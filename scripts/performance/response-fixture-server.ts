import { createServer, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { once } from "node:events";

import {
  syntheticFixtureChunk,
  syntheticGraphqlIntrospection,
  type SyntheticResponseKind,
} from "../../tests/performance/synthetic-fixtures";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.PURR_FIXTURE_PORT ?? "43119", 10);
const maximumBodyBytes = 128 * 1024 * 1024;
const contentTypes: Record<SyntheticResponseKind, string> = {
  text: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  ndjson: "application/x-ndjson; charset=utf-8",
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
  const match = /^\/response\/(text|json|ndjson|binary)$/.exec(url.pathname);
  if (!match) {
    respondJson(response, 404, {
      fixture: "purr-synthetic",
      endpoints: [
        "/response/text?size=102400",
        "/response/json?size=1048576",
        "/response/ndjson?size=20971520",
        "/response/binary?size=104857600",
        "/graphql/introspection?types=1200",
        "/graphql/result",
        "/oauth/token",
        "/cookies/set",
        "/cookies/echo",
        "/redirect/cross-origin",
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
