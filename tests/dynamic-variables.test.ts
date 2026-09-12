import { test } from "node:test";
import assert from "node:assert/strict";

import { createHttpDocument, type Variable } from "../src/features/workspaces/model/workspace";
import { inspectDynamicVariableGraph, resolveDynamicVariables, type DynamicVariableRequest } from "../src/features/workspaces/services/dynamic-variable-resolver";
import type { HttpResult } from "../src/features/request-workbench/services/http-client";

function document(id: string, name: string, url: string): DynamicVariableRequest {
  const request = createHttpDocument().request;
  request.url = url;
  return { id, name, kind: "http", request };
}

function result(request: DynamicVariableRequest, value: unknown): HttpResult {
  const text = JSON.stringify(value);
  return { status: 200, statusText: "OK", headers: [["content-type", "application/json"]], bodyBase64: btoa(text), durationMs: 1,
    url: request.request.url, text, size: text.length, timeline: { startedAtMs: 1, prepareMs: 0, waitingMs: 1, downloadMs: 0, completedAtMs: 2,
      request: { url: request.request.url, method: "GET", headers: [], bodyBase64: null }, followRedirects: true, usesCookieJar: false, timeoutMs: 60_000 } };
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
