/**
 * Synthetic localhost API for S01/S02 manual checks.
 * Run: npx tsx tests/fixtures/secure-storage-server.ts
 * Optional: PURR_SECURE_STORAGE_FIXTURE_PORT=18765 (0 chooses a free port).
 * Auth: username purr-test; password/token purr-phase1-A or purr-phase1-B.
 * No accounts, files or external services are used. Request values are never logged.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const syntheticCredentials = { username: "purr-test", A: "purr-phase1-A", B: "purr-phase1-B" } as const;
const maximumBodyBytes = 1024 * 1024;
const cookieName = "purr-secure-storage-fixture";

function credentialLabel(value: string | undefined): "A" | "B" | undefined {
  return value === syntheticCredentials.A ? "A" : value === syntheticCredentials.B ? "B" : undefined;
}
function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8", "content-length": bytes.length,
    "cache-control": "no-store", "access-control-allow-origin": "*",
    "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    ...headers,
  });
  response.end(bytes);
}
async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > maximumBodyBytes) throw new Error("Fixture body limit exceeded");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startSecureStorageFixtureServer(port = 18765) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Fixture port must be an integer from 0 to 65535.");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "OPTIONS") { json(response, 200, { ok: true }); return; }
      if (url.pathname === "/health") { json(response, 200, { ok: true }); return; }
      if (url.pathname === "/response") {
        const bytes = Math.max(0, Math.min(16 * 1024 * 1024, Number(url.searchParams.get("bytes")) || 0));
        const delayMs = Math.max(0, Math.min(10_000, Number(url.searchParams.get("delayMs")) || 0));
        const marker = (url.searchParams.get("marker") || "PURR_PUBLIC_RESPONSE").slice(0, 128);
        const send = () => { if (!response.destroyed) json(response, 200, { marker, padding: "x".repeat(bytes) }); };
        if (delayMs) setTimeout(send, delayMs); else send();
        return;
      }
      if (url.pathname === "/oauth/token") {
        json(response, 200, { access_token: syntheticCredentials.A, token_type: "Bearer", expires_in: 3600 }); return;
      }
      if (url.pathname === "/basic" || url.pathname === "/bearer") {
        const authorization = request.headers.authorization ?? "";
        let label: "A" | "B" | undefined;
        if (url.pathname === "/basic" && /^Basic\s+/i.test(authorization)) {
          const decoded = Buffer.from(authorization.replace(/^Basic\s+/i, ""), "base64").toString("utf8");
          const prefix = `${syntheticCredentials.username}:`;
          if (decoded.startsWith(prefix)) label = credentialLabel(decoded.slice(prefix.length));
        } else if (url.pathname === "/bearer" && /^Bearer\s+/i.test(authorization)) {
          label = credentialLabel(authorization.replace(/^Bearer\s+/i, ""));
        }
        json(response, label ? 200 : 401, { credential: label ?? "missing-or-invalid" },
          label ? {} : { "www-authenticate": url.pathname === "/basic" ? 'Basic realm="Purr synthetic fixture"' : 'Bearer realm="Purr synthetic fixture"' });
        return;
      }
      if (url.pathname === "/cookies/set") {
        const label = url.searchParams.get("credential") === "B" ? "B" : "A";
        json(response, 200, { cookie: "set" }, { "set-cookie": `${cookieName}=${syntheticCredentials[label]}; Path=/; HttpOnly; SameSite=Lax` });
        return;
      }
      if (["/cookies", "/cookies/check"].includes(url.pathname)) {
        const value = (request.headers.cookie ?? "").split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
        json(response, 200, { cookie: credentialLabel(value) ?? "missing" }); return;
      }
      if (url.pathname === "/echo") {
        json(response, 200, { method: request.method, path: url.pathname,
          query: [...url.searchParams.entries()], headers: request.headers, rawHeaders: request.rawHeaders,
          body: await readBody(request) });
        return;
      }
      json(response, 404, { error: "Unknown synthetic fixture route" });
    } catch {
      if (!response.headersSent && !response.destroyed) json(response, 413, { error: "Fixture request could not be read within its limit" });
    }
  });
  server.requestTimeout = 30_000;
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind a TCP port.");
  return { server, url: `http://127.0.0.1:${address.port}`,
    async close() { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await startSecureStorageFixtureServer(Number(process.env.PURR_SECURE_STORAGE_FIXTURE_PORT ?? 18765));
  process.stdout.write(`Purr synthetic secure-storage fixture: ${fixture.url}\nRoutes: /health /response /oauth/token /basic /bearer /echo /cookies/set /cookies/check\n`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void fixture.close(); });
}
