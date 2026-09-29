import assert from "node:assert/strict";
import test from "node:test";
import { initialRequestDraft } from "../src/features/request-workbench/model/request";
import { createRequestAuth } from "../src/features/request-workbench/model/request-auth";
import { createDependencyAuthRuntime } from "../src/features/request-workbench/services/dependency-auth-runtime";
import type { HttpTransport, WireRequest } from "../src/features/request-workbench/services/http-client";

const response = () => ({ status: 200, statusText: "OK", durationMs: 1, headers: [], bodyBase64: Buffer.from(JSON.stringify({ access_token: "source-token", token_type: "Bearer", expires_in: 300 })).toString("base64") });
const oauth = () => {
  const auth = createRequestAuth();
  auth.type = "oauth2";
  auth.oauth2.tokenUrl = "https://{{host}}/token";
  auth.oauth2.clientId = "{{client}}";
  auth.oauth2.clientSecret = "{{secret}}";
  auth.oauth2.clientAuthentication = "body";
  return auth;
};

test("dependency OAuth uses source context and does not mutate source or inherited credentials", async () => {
  const source = { ...initialRequestDraft, auth: createRequestAuth() };
  source.auth.type = "inherit";
  const shared = oauth();
  const before = structuredClone(shared);
  const calls: WireRequest[] = [];
  const runtime = createDependencyAuthRuntime(source, { variables: { host: "source.example", client: "source-client", secret: "source-secret" }, workspace: { id: "shared", name: "Source auth", auth: shared } }, async (request) => { calls.push(request); return response(); });
  const token = await runtime.run("initial");
  assert.equal(token?.accessToken, "source-token");
  assert.equal(calls[0].url, "https://source.example/token");
  const body = new URLSearchParams(Buffer.from(calls[0].bodyBase64!, "base64").toString());
  assert.equal(body.get("client_id"), "source-client");
  assert.equal(body.get("client_secret"), "source-secret");
  assert.deepEqual(shared, before);
  assert.equal(runtime.busy, false);
});

test("dependency refresh uses its own refresh token and refuses interactive authorization", async () => {
  const auth = oauth();
  auth.oauth2.tokenUrl = "https://source.example/token";
  auth.oauth2.clientId = "source-client";
  auth.oauth2.clientSecret = "source-secret";
  auth.oauth2.grantType = "authorization_code";
  auth.oauth2.token = { accessToken: "old", refreshToken: "source-refresh", obtainedAt: 1, tokenType: "Bearer" };
  let body = "";
  const runtime = createDependencyAuthRuntime({ ...initialRequestDraft, auth }, {}, async (request) => { body = Buffer.from(request.bodyBase64!, "base64").toString(); return response(); });
  await runtime.run("refresh");
  assert.equal(new URLSearchParams(body).get("refresh_token"), "source-refresh");
  body = "";
  await assert.rejects(runtime.run("initial"), /authorize in your browser first/);
  assert.equal(body, "");
});

test("canceling dependency token acquisition propagates to transport without accepting a late token", async () => {
  const auth = oauth();
  const abort = new AbortController();
  let options: Parameters<HttpTransport>[1];
  let finish!: (value: ReturnType<typeof response>) => void;
  const runtime = createDependencyAuthRuntime({ ...initialRequestDraft, auth }, { variables: { host: "source.example", client: "client", secret: "secret" } }, async (_request, execution) => {
    options = execution;
    return new Promise((resolve) => { finish = resolve; });
  }, undefined, abort.signal);
  const pending = runtime.run("initial");
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 0));
  abort.abort();
  assert.equal(options?.signal?.aborted, true);
  finish(response());
  await assert.rejects(pending, /abort/i);
  assert.equal(runtime.busy, false);
});
