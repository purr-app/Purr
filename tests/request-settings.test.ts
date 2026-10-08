import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultRequestSettings, normalizeRequestSettings } from "../src/domain/request-settings";
import { getRequestSettings, initialRequestDraft } from "../src/features/request-workbench/model/request";
import { SessionCookieJar } from "../src/features/request-workbench/model/cookie-jar";
import { executeHttp, type WireRequest, type WireResponse } from "../src/features/request-workbench/services/http-client";
import { executeRequest } from "../src/features/request-workbench/services/execute-request";
import { projectWorkspace, restoreWorkspace } from "../src/application/project-projection";
import { cloneRequestDraft, createWorkspace, isMeaningfulDraft, isRequestDocument, validateWorkspace } from "../src/features/workspaces/model/workspace";
import { MemorySecureStore } from "../src/storage/secrets";
import { deserializeResource, serializeResource } from "../src/storage/yaml";

const request: WireRequest = { url: "https://example.test/start", method: "GET", headers: [], bodyBase64: null };
const response = (status = 200, headers: [string, string][] = []): WireResponse => ({
  status, statusText: "OK", headers, bodyBase64: "", durationMs: 1,
});

test("old requests keep transport defaults and legacy cookie opt-out", () => {
  assert.deepEqual(getRequestSettings(initialRequestDraft), defaultRequestSettings);
  assert.equal(getRequestSettings({ useCookieJar: false }).storeCookies, false);
  assert.equal(getRequestSettings({ useCookieJar: false, settings: { storeCookies: true } }).storeCookies, true);
  const workspace = createWorkspace();
  const document = workspace.documents[0];
  assert.ok(isRequestDocument(document));
  document.request.settings = { timeoutMs: -1, maxRedirects: 500, httpVersion: "invalid", followRedirects: false } as never;
  const restored = validateWorkspace(workspace).documents[0];
  assert.ok(isRequestDocument(restored));
  assert.deepEqual(restored.request.settings, { followRedirects: false });
  assert.equal(isMeaningfulDraft(restored), true);
  assert.equal(normalizeRequestSettings(null), undefined);
});

test("saved settings survive canonical YAML while unsaved edits stay local", async () => {
  const workspace = createWorkspace();
  const document = workspace.documents[0];
  assert.ok(isRequestDocument(document));
  document.saved = true;
  document.request.settings = { ...defaultRequestSettings, maxRedirects: 3, httpVersion: "http2", validateTlsCertificates: false };
  document.savedRequest = cloneRequestDraft(document.request);
  document.request.settings.timeoutMs = 15_000;
  document.request.useCookieJar = false;
  document.request.settings.storeCookies = true;
  const secure = new MemorySecureStore();
  const projected = await projectWorkspace(workspace, secure);
  const canonical = projected.project.resources.find((item) => item.kind === "http");
  assert.ok(canonical?.kind === "http");
  assert.deepEqual(canonical.settings, document.savedRequest.settings);
  assert.deepEqual(deserializeResource(serializeResource(canonical)), canonical);
  const restored = await restoreWorkspace(projected.project, projected.local, secure, {});
  const restoredDocument = restored.documents.find((item) => item.id === document.id);
  assert.ok(restoredDocument && isRequestDocument(restoredDocument));
  assert.deepEqual(restoredDocument.request.settings, document.request.settings);
  assert.deepEqual(restoredDocument.savedRequest?.settings, document.savedRequest.settings);
  assert.equal(restoredDocument.request.useCookieJar, false);
  assert.throws(() => deserializeResource(serializeResource(canonical).replace("maxRedirects: 3", "maxRedirects: 51")), /Invalid/);
});

test("redirect opt-out returns the initial response and a zero limit rejects a redirect", async () => {
  let calls = 0;
  const transport = async () => { calls++; return response(302, [["Location", "/next"]]); };
  const result = await executeHttp(request, { transport, settings: { followRedirects: false, maxRedirects: 0 } });
  assert.equal(result.status, 302);
  assert.equal(result.timeline.followRedirects, false);
  assert.equal(calls, 1);
  await assert.rejects(executeHttp(request, { transport, settings: { maxRedirects: 0 } }), /maximum 0/);
  assert.equal(calls, 2);
});

test("redirect limit counts followed hops and keeps credential protections", async () => {
  const sent: WireRequest[] = [];
  await assert.rejects(executeHttp({ ...request, headers: [["Authorization", "Bearer synthetic"]] }, {
    settings: { maxRedirects: 2 },
    transport: async (wire) => { sent.push(wire); return response(302, [["Location", "https://other.test/next"]]); },
  }), /maximum 2/);
  assert.equal(sent.length, 3);
  assert.equal(sent[1].headers.some(([name]) => name === "Authorization"), false);
  await assert.rejects(executeHttp(request, {
    settings: { maxRedirects: 50, validateTlsCertificates: false },
    transport: async () => response(302, [["Location", "http://example.test/insecure"]]),
  }), /Blocked redirect from HTTPS/);
});

test("timeout is one budget across hops, with TLS and HTTP policy forwarded each time", async (context) => {
  let time = 0;
  context.mock.method(performance, "now", () => time);
  const sent: WireRequest[] = [];
  await assert.rejects(executeHttp(request, {
    settings: { timeoutMs: 100, httpVersion: "http1", validateTlsCertificates: false },
    transport: async (wire) => { sent.push(wire); time += 60; return response(302, [["Location", "/next"]]); },
  }), /timed out/);
  assert.deepEqual(sent.map((item) => item.transportSettings), [
    { timeoutMs: 100, httpVersion: "http1", validateTlsCertificates: false },
    { timeoutMs: 40, httpVersion: "http1", validateTlsCertificates: false },
  ]);
});

for (const sendCookies of [false, true]) for (const storeCookies of [false, true]) {
  test(`cookies can independently send=${sendCookies} and store=${storeCookies} across redirects`, async () => {
    const jar = new SessionCookieJar();
    jar.receive(request.url, [["Set-Cookie", "existing=jar; Path=/; Secure"]]);
    const sent: WireRequest[] = [];
    await executeHttp({ ...request, headers: [["Cookie", "manual=explicit"]] }, {
      jar, sendCookies, settings: { storeCookies },
      transport: async (wire) => {
        sent.push(wire);
        return sent.length === 1 ? response(302, [["Location", "/next"], ["Set-Cookie", "new=captured; Path=/; Secure"]]) : response();
      },
    });
    const cookies = sent.map((wire) => wire.headers.find(([name]) => name.toLowerCase() === "cookie")?.[1] ?? "");
    for (const cookie of cookies) {
      assert.ok(cookie.includes("manual=explicit"));
      assert.equal(cookie.includes("existing=jar"), sendCookies);
    }
    assert.equal(cookies[1].includes("new=captured"), sendCookies && storeCookies);
    assert.equal(jar.list().some((cookie) => cookie.name === "new"), storeCookies);
  });
}

test("request execution honors old disabled jars and explicit store-only mode", async () => {
  for (const storeCookies of [undefined, true]) {
    const jar = new SessionCookieJar();
    jar.receive(request.url, [["Set-Cookie", "existing=jar; Path=/; Secure"]]);
    const draft = { ...initialRequestDraft, url: request.url, useCookieJar: false,
      settings: { followRedirects: false, ...(storeCookies === undefined ? {} : { storeCookies }), httpVersion: "http2" as const } };
    const result = await executeRequest(draft, {}, jar,
      { busy: false, authorizing: false, error: "", now: 0, run: async () => null, cancel() {}, clearError() {} },
      async (wire) => {
        assert.equal(wire.transportSettings?.httpVersion, "http2");
        assert.equal(wire.headers.some(([name]) => name.toLowerCase() === "cookie"), false);
        return response(302, [["Location", "/next"], ["Set-Cookie", "received=value; Path=/; Secure"]]);
      });
    assert.equal(result.status, 302);
    assert.equal(jar.list().some((cookie) => cookie.name === "received"), storeCookies === true);
  }
});
