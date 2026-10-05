import { test } from "node:test";
import assert from "node:assert/strict";

import { createHttpDocument, type Variable } from "../src/features/workspaces/model/workspace";
import { inspectDynamicVariableGraph, resolveDynamicVariables, type DynamicVariableRequest } from "../src/features/workspaces/services/dynamic-variable-resolver";
import { createInlineHttpResponse, type InlineHttpResponse } from "../src/domain/http";
import type { ResponseContentPort } from "../src/application/ports/response-content";
import type { HttpExchange } from "../src/domain/http";

function document(id: string, name: string, url: string): DynamicVariableRequest {
  const request = createHttpDocument().request;
  request.url = url;
  return { id, name, kind: "http", request };
}

function result(request: DynamicVariableRequest, value: unknown): InlineHttpResponse {
  const text = JSON.stringify(value);
  return createInlineHttpResponse({ status: 200, statusText: "OK", headers: [["content-type", "application/json"]], bodyBase64: btoa(text), durationMs: 1,
    url: request.request.url, text, size: text.length, timeline: { startedAtMs: 1, prepareMs: 0, waitingMs: 1, downloadMs: 0, completedAtMs: 2,
      request: { url: request.request.url, method: "GET", headers: [], bodyBase64: null }, followRedirects: true, usesCookieJar: false, timeoutMs: 60_000 } });
}

function dynamic(id: string, name: string, source: string, expression = "$.value", refresh: "every-time" | "session" | "cache" = "every-time"): Variable {
  return { id, name, enabled: true, sensitive: false, kind: "dynamic-request", documentId: source, expression, language: "jsonpath", refresh,
    ...(refresh === "cache" ? { cacheTtlSeconds: 300 } : {}), environment: { type: "current" } };
}

test("dynamic variables execute saved request dependencies and extract a JSONPath value", async () => {
  const root = document("a", "Upload", "https://example.test/{{upload_url}}");
  const source = document("b", "Create upload", "https://example.test/create");
  let calls = 0;
  const resolved = await resolveDynamicVariables({ root, environmentId: "local", documents: [root, source], variablesForEnvironment: async () => [dynamic("upload", "upload_url", "b")], persistentCache: {}, sessionCache: new Map(),
    execute: async (request) => { calls++; return result(request, { value: "signed/path" }); } });
  assert.equal(calls, 1);
  assert.equal(resolved.values.upload_url, "signed/path");
});

test("dynamic variables query referenced native responses without materializing the body", async () => {
  const root = document("a", "Upload", "https://example.test/{{upload_url}}");
  const source = document("b", "Create upload", "https://example.test/create");
  const released: string[] = [];
  const unavailable = () => Promise.reject(new Error("unused operation"));
  const responseContent: ResponseContentPort = {
    inspect: unavailable,
    readRange: unavailable,
    readLines: unavailable,
    search: unavailable,
    format: unavailable,
    query: async (_reference, request) => {
      assert.deepEqual(request, { language: "jsonpath", expression: "$.value" });
      return { kind: "value", value: "native/signed/path" };
    },
    save: unavailable,
    release: async (reference) => { released.push(reference.id); },
  };
  const exchange: HttpExchange = {
    protocolVersion: 2,
    request: { url: source.request.url, method: "GET", headers: [], bodyBase64: null },
    response: { url: source.request.url, status: 200, statusText: "OK", headers: [["content-type", "application/json"]], byteLength: 2 * 1024 * 1024, durationMs: 1 },
    content: { id: "content-dynamic", byteLength: 2 * 1024 * 1024, mediaType: "application/json", charset: "utf-8", complete: true },
    timeline: { startedAtMs: 1, prepareMs: 0, waitingMs: 1, downloadMs: 0, completedAtMs: 2, request: { url: source.request.url, method: "GET", headers: [], bodyBase64: null }, followRedirects: true, usesCookieJar: false, timeoutMs: 60_000 },
  };
  const resolved = await resolveDynamicVariables({
    root,
    environmentId: "local",
    documents: [root, source],
    variablesForEnvironment: async () => [dynamic("upload", "upload_url", "b")],
    persistentCache: {},
    sessionCache: new Map(),
    responseContent,
    execute: async () => exchange,
  });
  assert.equal(resolved.values.upload_url, "native/signed/path");
  assert.deepEqual(released, ["content-dynamic"]);
});

test("dynamic variable cycles fail with the complete request and variable path", async () => {
  const a = document("a", "Request A", "https://example.test/{{from_b}}");
  const b = document("b", "Request B", "https://example.test/{{from_a}}");
  const variables = [dynamic("ab", "from_b", "b"), dynamic("ba", "from_a", "a")];
  await assert.rejects(resolveDynamicVariables({ root: a, environmentId: null, documents: [a, b], variablesForEnvironment: async () => variables,
    persistentCache: {}, sessionCache: new Map(), execute: async (request) => result(request, {}) }), /Request A — \{\{from_b\}\} → Request B — \{\{from_a\}\} → Request A/);
  const graph = inspectDynamicVariableGraph(variables[0], variables, [a, b]);
  assert.equal(graph.cycle, "{{from_b}} → Request B → {{from_a}} → Request A → {{from_b}} → Request B");
});

test("persistent dynamic cache is isolated by environment", async () => {
  const root = document("a", "Root", "https://example.test/{{value}}"), source = document("b", "Source", "https://example.test/source");
  const variable = dynamic("value-id", "value", "b", "$.value", "cache");
  let calls = 0;
  const run = (environmentId: string, persistentCache: Record<string, never> | Awaited<ReturnType<typeof resolveDynamicVariables>>["cache"]) => resolveDynamicVariables({ root, environmentId, documents: [root, source], variablesForEnvironment: async () => [variable], persistentCache, sessionCache: new Map(),
    execute: async (request) => { calls++; return result(request, { value: environmentId }); } });
  const local = await run("local", {});
  const localAgain = await run("local", local.cache);
  const staging = await run("staging", localAgain.cache);
  assert.equal(calls, 2);
  assert.equal(localAgain.values.value, "local");
  assert.equal(staging.values.value, "staging");
});

test("disabled variables fail with an actionable error", async () => {
  const root = document("a", "Root", "https://example.test/{{value}}"), source = document("b", "Source", "https://example.test/source");
  const disabled = { ...dynamic("value-id", "value", "b"), enabled: false };
  await assert.rejects(resolveDynamicVariables({ root, environmentId: null, documents: [root, source], variablesForEnvironment: async () => [disabled], persistentCache: {}, sessionCache: new Map(), execute: async (request) => result(request, {}) }), /Variable "value" is disabled/);
});

test("refresh policies distinguish every-time, session and expiring cache", async () => {
  const root = document("a", "Root", "https://example.test/{{value}}"), source = document("b", "Source", "https://example.test/source");
  let calls = 0;
  const execute = async (request: DynamicVariableRequest) => { calls++; return result(request, { value: calls }); };
  const run = (variable: Variable, persistentCache: Awaited<ReturnType<typeof resolveDynamicVariables>>["cache"] = {}, sessionCache = new Map(), force = false) =>
    resolveDynamicVariables({ root, environmentId: "local", documents: [root, source], variablesForEnvironment: async () => [variable], persistentCache, sessionCache,
      ...(force ? { forceVariableIds: new Set([variable.id]) } : {}), execute });

  const every = dynamic("every", "value", "b");
  const first = await run(every); await run(every, first.cache); assert.equal(calls, 2);

  calls = 0; const sessionVariable = { ...dynamic("session", "value", "b"), refresh: "session" as const }; const sessionCache = new Map();
  const sessionFirst = await run(sessionVariable, {}, sessionCache); await run(sessionVariable, sessionFirst.cache, sessionCache); assert.equal(calls, 1);

  calls = 0; const cached = { ...dynamic("cache", "value", "b", "$.value", "cache"), cacheTtlSeconds: 1 }; const cachedFirst = await run(cached);
  cachedFirst.cache["cache:local"].resolvedAt = new Date(0).toISOString(); await run(cached, cachedFirst.cache); assert.equal(calls, 2);

});

test("dependency diagnostics retain HTTP errors when extraction succeeds and do not record cache hits", async () => {
  const root = document("root", "Root", "https://example.test/{{value}}"), source = document("source", "Error source", "https://example.test/source");
  const records: import("../src/features/workspaces/services/dynamic-variable-resolver").DynamicExecutionRecord[] = [];
  const variable = dynamic("v", "value", source.id, "$.error.meta", "session");
  const sessionCache = new Map();
  const options = { root, environmentId: null, documents: [source], variablesForEnvironment: async () => [variable], persistentCache: {}, sessionCache,
    execute: async () => ({ ...result(source, { error: { meta: false } }), status: 401 }),
    onExecuted: async (record: typeof records[number]) => { records.push(record); return "history-1"; } };
  const first = await resolveDynamicVariables(options);
  assert.equal(first.values.value, "false");
  assert.equal(first.steps[0].status, 401);
  assert.equal(first.steps[0].state, "resolved");
  assert.equal(first.steps[0].historyEntryId, "history-1");
  assert.equal(records[0].outcome, "response");
  assert.equal(records[0].dynamicExecution.extraction?.status, "success");
  const cached = await resolveDynamicVariables(options);
  assert.equal(cached.steps[0].state, "cached");
  assert.equal(records.length, 1);
});

test("failed extraction records its response before releasing native content", async () => {
  const root = document("root", "Root", "https://example.test/{{value}}"), source = document("source", "Source", "https://example.test/source");
  const events: string[] = [];
  const inline = result(source, {});
  const response: HttpExchange = { protocolVersion: 2, request: inline.timeline.request, response: { url: source.request.url, status: 403, statusText: "Forbidden", headers: [], byteLength: 2, durationMs: 1 },
    content: { id: "body", byteLength: 2, mediaType: "application/json", charset: "utf-8", complete: true }, timeline: inline.timeline };
  await assert.rejects(resolveDynamicVariables({ root, environmentId: null, documents: [source], variablesForEnvironment: async () => [dynamic("v", "value", source.id)], persistentCache: {}, sessionCache: new Map(),
    execute: async () => response,
    responseContent: { query: async () => { throw new Error("The query did not match any response value."); }, release: async () => { events.push("release"); } } as unknown as ResponseContentPort,
    onExecuted: async (record) => { events.push("adopt"); assert.equal(record.response, response); assert.equal(record.outcome, "response"); assert.equal(record.dynamicExecution.extraction?.status, "error"); return "history-failed"; },
  }), (error: unknown) => {
    const failure = error as import("../src/features/workspaces/services/dynamic-variable-resolver").DynamicVariableResolutionError;
    assert.equal(failure.steps[0].historyEntryId, "history-failed");
    assert.equal(failure.steps[0].state, "failed");
    assert.equal(failure.steps[0].status, 403);
    return true;
  });
  assert.deepEqual(events, ["adopt", "release"]);
});

test("only dispatched transport failures are recorded; history failures do not change resolution", async () => {
  const root = document("root", "Root", "https://example.test/{{value}}"), source = document("source", "Source", "https://example.test/source");
  let records = 0;
  const options = { root, environmentId: null, documents: [source], variablesForEnvironment: async () => [dynamic("v", "value", source.id)], persistentCache: {}, sessionCache: new Map(), onExecuted: async () => { records++; return "failure"; } };
  await assert.rejects(resolveDynamicVariables({ ...options, execute: async () => { throw new Error("Invalid auth"); } }), /Invalid auth/);
  assert.equal(records, 0);
  await assert.rejects(resolveDynamicVariables({ ...options, execute: async (_doc, _values, _env, execution) => { execution.onDispatch(); throw new Error("Offline"); } }), /Offline/);
  assert.equal(records, 1);
  let historyErrors = 0;
  const resolved = await resolveDynamicVariables({ ...options, execute: async () => result(source, { value: "ok" }), onExecuted: async () => { throw new Error("Disk full"); }, onHistoryError: () => { historyErrors++; } });
  assert.equal(resolved.values.value, "ok");
  assert.equal(historyErrors, 1);
});

test("the same document in another environment is not a dependency cycle", async () => {
  const root = document("request", "Cross environment", "https://example.test/{{value}}");
  const fromProduction = { ...dynamic("v", "value", root.id), environment: { type: "specific" as const, environmentId: "production" } };
  const staticValue: Variable = { id: "static", name: "value", enabled: true, sensitive: false, kind: "static", value: "production-value" };
  const variablesForEnvironment = async (id: string | null) => id === "production" ? [staticValue] : [fromProduction];
  const resolved = await resolveDynamicVariables({ root, environmentId: "dev", documents: [root], variablesForEnvironment, persistentCache: {}, sessionCache: new Map(), execute: async (_document, values, environment) => {
    assert.equal(environment, "production"); assert.equal(values.value, "production-value"); return result(root, { value: "resolved" });
  } });
  assert.equal(resolved.values.value, "resolved");
  assert.equal(resolved.steps.length, 1);
});

test("cancelling a dependency records only its dispatched attempt", async () => {
  const root = document("root", "Root", "https://example.test/{{value}}"), source = document("source", "Source", "https://example.test/source");
  const abort = new AbortController();
  const records: string[] = [];
  await assert.rejects(resolveDynamicVariables({ root, environmentId: null, documents: [source], variablesForEnvironment: async () => [dynamic("v", "value", source.id)], persistentCache: {}, sessionCache: new Map(), signal: abort.signal,
    execute: async (_doc, _values, _env, execution) => { execution.onDispatch(); abort.abort(); throw new Error("Request canceled."); },
    onExecuted: async (record) => { records.push(record.outcome); return "cancelled"; },
  }), /canceled/);
  assert.deepEqual(records, ["cancelled"]);
});
