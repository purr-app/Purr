import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  syntheticFixtureChunk,
  syntheticGraphqlIntrospection,
  type SyntheticResponseKind,
} from "../../tests/performance/synthetic-fixtures";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.PURR_FIXTURE_PORT ?? "43119", 10);
const maximumBodyBytes = 128 * 1024 * 1024;
const redirectUploads = new Map<string, { sha256: string; size: number }>();
const syntheticSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><metadata>${"purr-synthetic-".repeat(5_000)}</metadata><rect width="640" height="360" fill="#151821"/><text x="40" y="190" fill="#62c29a" font-family="monospace" font-size="32">Purr synthetic image</text></svg>`);

function syntheticWav() {
  const sampleRate = 44_100;
  const dataBytes = sampleRate * 2 * 2;
  const result = Buffer.alloc(44 + dataBytes);
  result.write("RIFF", 0);
  result.writeUInt32LE(result.length - 8, 4);
  result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36);
  result.writeUInt32LE(dataBytes, 40);
  return result;
}

const videoCore = readFileSync(fileURLToPath(new URL("../../tests/performance/fixtures/purr-synthetic-video.mp4", import.meta.url)));
const videoPadding = Buffer.alloc(1024 * 1024);
videoPadding.writeUInt32BE(videoPadding.length, 0);
videoPadding.write("free", 4);
const mediaFixtures = new Map([
  ["/media/image.svg", { body: syntheticSvg, mediaType: "image/svg+xml" }],
  ["/media/audio.wav", { body: syntheticWav(), mediaType: "audio/wav" }],
  ["/media/video.mp4", { body: Buffer.concat([videoCore, videoPadding]), mediaType: "video/mp4" }],
]);
const contentTypes: Record<SyntheticResponseKind, string> = {
  text: "text/plain; charset=utf-8",
  lines: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  graphql: "application/json; charset=utf-8",
  ndjson: "application/x-ndjson; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  binary: "application/octet-stream",
};

function boundedInteger(url: URL, name: string, fallback: number, minimum: number, maximum: number) {
  const raw = url.searchParams.get(name);
  const value = raw === null ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function respondJson(response: ServerResponse, status: number, value: unknown) {
  respondJsonWithHeaders(response, status, value, {});
}

function respondJsonWithHeaders(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string>,
) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "content-length": body.length,
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(body);
}

function mediaRange(value: string | undefined, size: number) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new Error("Invalid media range.");
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new Error("Invalid media range.");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start)
    throw new Error("Invalid media range.");
  return { start, end };
}

function respondMedia(request: IncomingMessage, response: ServerResponse, body: Buffer, mediaType: string) {
  try {
    const range = mediaRange(request.headers.range, body.length);
    const selected = range ? body.subarray(range.start, range.end + 1) : body;
    response.writeHead(range ? 206 : 200, {
      "accept-ranges": "bytes",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "content-length": selected.length,
      "content-type": mediaType,
      ...(range ? { "content-range": `bytes ${range.start}-${range.end}/${body.length}` } : {}),
    });
    response.end(request.method === "HEAD" ? undefined : selected);
  } catch {
    response.writeHead(416, { "content-range": `bytes */${body.length}` });
    response.end();
  }
}

async function readRequestBody(request: NodeJS.AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maximumBodyBytes) throw new Error("Upload exceeds the 128 MiB fixture limit.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function multipartParts(body: Buffer, contentType: string) {
  const boundary = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)?.slice(1).find(Boolean);
  if (!boundary) throw new Error("Multipart upload is missing its boundary.");
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Array<{
    name: string | null;
    fileName: string | null;
    contentType: string | null;
    size: number;
    sha256: string;
  }> = [];
  let position = 0;
  while (true) {
    const boundaryAt = body.indexOf(delimiter, position);
    if (boundaryAt < 0) break;
    const afterBoundary = boundaryAt + delimiter.length;
    if (body.subarray(afterBoundary, afterBoundary + 2).equals(Buffer.from("--"))) break;
    const headersAt = afterBoundary + 2;
    const headersEnd = body.indexOf(Buffer.from("\r\n\r\n"), headersAt);
    if (headersEnd < 0) throw new Error("Multipart fixture received malformed part headers.");
    const nextBoundary = body.indexOf(delimiter, headersEnd + 4);
    if (nextBoundary < 0) throw new Error("Multipart fixture received an unterminated part.");
    const headers = body.subarray(headersAt, headersEnd).toString("utf8");
    const content = body.subarray(headersEnd + 4, Math.max(headersEnd + 4, nextBoundary - 2));
    const disposition = headers.split("\r\n").find((line) => /^content-disposition:/i.test(line)) ?? "";
    const contentTypeHeader = headers.split("\r\n").find((line) => /^content-type:/i.test(line));
    parts.push({
      name: /(?:^|;)\s*name="([^"]*)"/i.exec(disposition)?.[1] ?? null,
      fileName: /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition)?.[1] ?? null,
      contentType: contentTypeHeader?.split(":", 2)[1]?.trim() ?? null,
      size: content.length,
      sha256: sha256(content),
    });
    position = nextBoundary;
  }
  return parts;
}

async function echoUpload(request: IncomingMessage, response: ServerResponse, url: URL) {
  const body = await readRequestBody(request);
  const contentType = request.headers["content-type"] ?? "application/octet-stream";
  const digest = sha256(body);
  const redirectToken = url.searchParams.get("redirectToken");
  const initial = redirectToken ? redirectUploads.get(redirectToken) : undefined;
  if (redirectToken) redirectUploads.delete(redirectToken);
  respondJson(response, 200, {
    fixture: "purr-upload",
    method: request.method,
    contentType,
    size: body.length,
    sha256: digest,
    multipart: contentType.toLowerCase().startsWith("multipart/form-data")
      ? multipartParts(body, contentType)
      : null,
    redirectReplay: initial
      ? { matches: initial.size === body.length && initial.sha256 === digest, initial }
      : null,
  });
}

async function writeResponseFixture(
  response: ServerResponse,
  kind: SyntheticResponseKind,
  size: number,
  chunkSize: number,
  delayMs: number,
) {
  let sent = 0;
  while (sent < size && !response.destroyed) {
    const length = Math.min(chunkSize, size - sent);
    const chunk = syntheticFixtureChunk(kind, size, sent, length);
    sent += length;
    if (!response.write(chunk)) await once(response, "drain");
    if (delayMs > 0 && sent < size) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  response.end();
  return sent;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  response.on("error", () => {});
  if (url.pathname === "/health") {
    respondJson(response, 200, { fixture: "purr-synthetic", ready: true });
    return;
  }
  if (url.pathname === "/graphql/introspection") {
    try {
      const types = boundedInteger(url, "types", 40, 1, 5_000);
      respondJson(response, 200, { data: syntheticGraphqlIntrospection(types) });
    } catch (cause) {
      respondJson(response, 400, { error: cause instanceof Error ? cause.message : "Invalid fixture request." });
    }
    return;
  }
  if (url.pathname === "/graphql/result") {
    respondJson(response, 200, {
      data: { fixture: "purr-v1" },
      errors: [{ message: "Synthetic partial result", path: ["fixture"], extensions: { code: "SYNTHETIC" } }],
      extensions: { fixture: "purr-extension" },
    });
    return;
  }
  if (url.pathname === "/oauth/token") {
    respondJson(response, 200, {
      access_token: "purr-fixture-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "fixture.read",
    });
    return;
  }
  if (url.pathname === "/cookies/set") {
    respondJsonWithHeaders(response, 200, { fixture: "purr-cookie", set: true }, {
      "set-cookie": "purr-phase3=ok; Path=/; HttpOnly; SameSite=Lax",
    });
    return;
  }
  if (url.pathname === "/cookies/echo") {
    respondJson(response, 200, {
      fixture: "purr-cookie",
      cookie: request.headers.cookie ?? "",
    });
    return;
  }
  if (url.pathname === "/redirect/cross-origin") {
    response.writeHead(302, {
      "cache-control": "no-store",
      location: `http://localhost:${port}/redirect/final?api_key=fixture-redirect-secret`,
      "set-cookie": "purr-redirect=kept; Path=/; HttpOnly; SameSite=Lax",
    });
    response.end();
    return;
  }
  if (url.pathname === "/redirect/final") {
    respondJson(response, 200, {
      fixture: "purr-cross-origin-redirect",
      authorization: request.headers.authorization ?? null,
      cookie: request.headers.cookie ?? null,
      apiKey: url.searchParams.get("api_key"),
    });
    return;
  }
  const media = mediaFixtures.get(url.pathname);
  if (media) {
    respondMedia(request, response, media.body, media.mediaType);
    return;
  }
  if (url.pathname === "/upload/echo") {
    try {
      await echoUpload(request, response, url);
    } catch (cause) {
      respondJson(response, 400, { error: cause instanceof Error ? cause.message : "Invalid upload fixture request." });
    }
    return;
  }
  if (url.pathname === "/upload/redirect307" || url.pathname === "/upload/redirect308") {
    try {
      const body = await readRequestBody(request);
      const redirectToken = randomUUID();
      redirectUploads.set(redirectToken, { size: body.length, sha256: sha256(body) });
      response.writeHead(url.pathname.endsWith("307") ? 307 : 308, {
        "cache-control": "no-store",
        location: `/upload/echo?redirectToken=${redirectToken}`,
      });
      response.end();
    } catch (cause) {
      respondJson(response, 400, { error: cause instanceof Error ? cause.message : "Invalid redirect upload fixture request." });
    }
    return;
  }
  const match = /^\/response\/(text|lines|json|graphql|ndjson|xml|binary)$/.exec(url.pathname);
  if (!match) {
    respondJson(response, 404, {
      fixture: "purr-synthetic",
      endpoints: [
        "/response/text?size=102400",
        "/response/lines?size=4000000",
        "/response/json?size=1048576",
        "/response/graphql?size=2097152",
        "/response/ndjson?size=20971520",
        "/response/xml?size=20971520",
        "/response/binary?size=104857600",
        "/graphql/introspection?types=1200",
        "/graphql/result",
        "/oauth/token",
        "/cookies/set",
        "/cookies/echo",
        "/redirect/cross-origin",
        "/media/image.svg",
        "/media/audio.wav",
        "/media/video.mp4",
        "/upload/echo",
        "/upload/redirect307",
        "/upload/redirect308",
      ],
    });
    return;
  }
  try {
    const kind = match[1] as SyntheticResponseKind;
    const size = boundedInteger(url, "size", 100 * 1024, 128, maximumBodyBytes);
    const chunkSize = boundedInteger(url, "chunkSize", 64 * 1024, 1, 1024 * 1024);
    const delayMs = boundedInteger(url, "delayMs", 0, 0, 10_000);
    const headersDelayMs = boundedInteger(url, "headersDelayMs", 0, 0, 60_000);
    if (headersDelayMs) await new Promise((resolve) => setTimeout(resolve, headersDelayMs));
    const headers: OutgoingHttpHeaders = {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "content-length": size,
      "content-type": contentTypes[kind],
      "x-purr-fixture": "synthetic",
    };
    if (url.searchParams.get("cookies") === "repeated") {
      headers["set-cookie"] = [
        "purr-binary-first=one; Path=/; HttpOnly; SameSite=Lax",
        "purr-binary-second=two; Path=/; SameSite=Lax",
      ];
    }
    response.writeHead(200, headers);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const sent = await writeResponseFixture(response, kind, size, chunkSize, delayMs);
    process.stdout.write(`fixture kind=${kind} requested=${size} sent=${sent}\n`);
  } catch (cause) {
    if (!response.headersSent) {
      respondJson(response, 400, { error: cause instanceof Error ? cause.message : "Invalid fixture request." });
    } else {
      response.destroy();
    }
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Purr synthetic fixture server: http://${host}:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
