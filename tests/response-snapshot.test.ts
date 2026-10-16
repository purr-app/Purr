import { test } from "node:test";
import assert from "node:assert/strict";
import { protectResponseSnapshot, restoreResponseSnapshot } from "../src/application/response-snapshot";
import { MemorySecureStore, SecretPreparationStore } from "../src/storage/secrets";
import { executeHttp } from "../src/features/request-workbench/services/http-client";
import { prepareWireRequest } from "../src/features/request-workbench/services/execute-request";
import { initialRequestDraft } from "../src/features/request-workbench/model/request";
import { cloneRequestDraft } from "../src/features/workspaces/model/workspace";
import { SessionCookieJar } from "../src/features/request-workbench/model/cookie-jar";

async function fixture() {
  return executeHttp({ url: "https://fixture.invalid/path-PRIVATE_URL", method: "POST", headers: [["X-Token", "PRIVATE_HEADER"]], bodyBase64: btoa("prefix-PRIVATE_BODY") }, {
    sensitivity: { url: true, headers: ["x-token"], body: true },
    responseStorage: { protection: "plaintext" },
    transport: async () => ({ status: 200, statusText: "OK", headers: [["Set-Cookie", "PRIVATE_COOKIE"], ["Content-Type", "text/plain"]], bodyBase64: btoa("PUBLIC_RESPONSE"), durationMs: 1 }),
  });
}

test("Off projects every classified wire occurrence, retains public body and immutable exact runtime snapshot", async () => {
  const secure = new MemorySecureStore();
  const staged = new SecretPreparationStore(secure);
  const original = await fixture();
  const stored = await protectResponseSnapshot(original, staged, "ws", "history/execution-a");
  const json = JSON.stringify(stored);
  for (const secret of ["PRIVATE_URL", "PRIVATE_HEADER", "PRIVATE_COOKIE", btoa("prefix-PRIVATE_BODY")]) assert.ok(!json.includes(secret), secret);
  assert.ok(json.includes("PUBLIC_RESPONSE"));
  assert.equal(await secure.get(stored.protectedSnapshot!.ref), null, "preparation does not publish");
  await secure.commit(await staged.batch());
  assert.deepEqual((await restoreResponseSnapshot(stored, secure, "ws"))?.timeline.request, original.timeline.request);
  original.timeline.request.headers[0][1] = "ROTATED";
  assert.equal((await restoreResponseSnapshot(stored, secure, "ws"))?.timeline.request.headers[0][1], "PRIVATE_HEADER");
  await secure.delete(stored.protectedSnapshot!.ref);
  const missing = await restoreResponseSnapshot(stored, secure, "ws");
  assert.equal(missing?.protectedSnapshot?.status, "missing");
  assert.equal(missing?.timeline.request.url, "********");
  assert.equal((await restoreResponseSnapshot(stored, secure, "different"))?.protectedSnapshot?.status, "corrupt");
});

test("request provenance protects whole mixed body and names without inspecting arbitrary server text", async () => {
  const draft = cloneRequestDraft(initialRequestDraft);
  draft.url = "https://fixture.invalid/{{token}}";
  draft.body.type = "text"; draft.body.text = "literal-prefix-{{token}}";
  draft.headers = [{ id: "s", name: "{{token}}", value: "also-sensitive", enabled: true }];
  const prepared = await prepareWireRequest(draft, { variables: { token: "SYNTHETIC_SECRET" }, sensitiveVariableNames: ["token"] });
  assert.equal(prepared.sensitiveBody, true);
  assert.ok(prepared.provenance.some((usage) => usage.field === "header-name"));
  const response = await fixture();
  response.timeline.sensitivity!.headerNames = true;
  response.timeline.request.headers = [["SECRET_HEADER_NAME", "SECRET_HEADER_VALUE"]];
  const stored = await protectResponseSnapshot(response, new SecretPreparationStore(new MemorySecureStore()), "ws", "history/names");
  assert.ok(!JSON.stringify(stored).includes("SECRET_HEADER"));
});

test("public Off request does not call SecureStore; unavailable cookie dependency blocks before dispatch", async () => {
  let calls = 0;
  const jar = new SessionCookieJar(); jar.available = false;
  const request = { url: "http://fixture.invalid/", method: "GET", headers: [] as [string, string][], bodyBase64: null };
  const transport = async () => { calls++; return { status: 200, statusText: "OK", headers: [] as [string,string][], bodyBase64: btoa("ARBITRARY_RETURNED_TOKEN"), durationMs: 1 }; };
  await assert.rejects(executeHttp(request, { jar, transport }), /disable both Send cookies and Store cookies/);
  assert.equal(calls, 0);
  const response = await executeHttp(request, { jar, transport, sendCookies: false, settings: { storeCookies: false }, responseStorage: { protection: "plaintext" } });
  const secure = new MemorySecureStore(); secure.read = async () => { throw new Error("must not access key"); };
  const stored = await protectResponseSnapshot(response, secure, "ws", "history/public");
  assert.equal(stored.protectedSnapshot, undefined);
  assert.ok(JSON.stringify(stored).includes("ARBITRARY_RETURNED_TOKEN"), "Off deliberately permits unclassified server text");
});

test("unexpected protected response metadata cannot fall back to plaintext when key access fails", async () => {
  const secure = new MemorySecureStore(); secure.read = async () => { throw new Error("key unavailable"); };
  const staged = new SecretPreparationStore(secure);
  const stored = await protectResponseSnapshot(await fixture(), staged, "ws", "history/unavailable");
  assert.equal(stored.protectedSnapshot?.status, "unavailable");
  assert.equal((await staged.batch()).mutations.length, 0);
  assert.ok(!JSON.stringify(stored).includes("PRIVATE_COOKIE"));
  assert.ok(JSON.stringify(stored).includes("PUBLIC_RESPONSE"));
});
