import { test } from "node:test";
import assert from "node:assert/strict";
import { executeHttp } from "../src/features/request-workbench/services/http-client";
import { prepareWireRequest } from "../src/features/request-workbench/services/execute-request";
import { createWorkspace, isRequestDocument, cloneRequestDraft, applyWorkspaceRequestConfig } from "../src/features/workspaces/model/workspace";
import { projectWorkspace, restoreWorkspace } from "../src/application/project-projection";
import { MemorySecureStore } from "../src/storage/secrets";
import { deserializeManifest, serializeManifest, serializeResource, deserializeResource } from "../src/storage/yaml";

test("propagation selection survives YAML and saved-versus-working-copy projection without persisting generated IDs", async () => {
  const workspace = createWorkspace("synthetic", "synthetic");
  workspace.requestConfig.tracePropagation = "w3c";
  const document = workspace.documents.find(isRequestDocument)!;
  document.request.url = "http://example.test/fixture";
  document.saved = true; document.request.tracePropagation = "off";
  document.savedRequest = cloneRequestDraft(document.request);
  document.request.tracePropagation = "b3";
  const secure = new MemorySecureStore();
  const projected = await projectWorkspace(workspace, secure);
  const manifest = serializeManifest(projected.project.workspace);
  assert.equal(deserializeManifest(manifest).tracePropagation, "w3c");
  const resource = projected.project.resources.find((item) => item.id === document.id)!;
  assert.equal((deserializeResource(serializeResource(resource)) as { tracePropagation: string }).tracePropagation, "off");
  assert.doesNotMatch(manifest + serializeResource(resource), /injectedTraceId|traceparent/);
  const restored = await restoreWorkspace(projected.project, projected.local, secure, projected.assets);
  assert.equal(restored.requestConfig.tracePropagation, "w3c");
  const restoredDocument = restored.documents.find(isRequestDocument)!;
  assert.equal(restoredDocument.request.tracePropagation, "b3");
  assert.equal(restoredDocument.savedRequest?.tracePropagation, "off");
  const inherited = applyWorkspaceRequestConfig({ ...document.request, tracePropagation: undefined }, "http", workspace.requestConfig);
  assert.equal((await prepareWireRequest(inherited, { variables: {} })).request.tracePropagation, "w3c");
  assert.equal(applyWorkspaceRequestConfig({ ...document.request, tracePropagation: "off" }, "http", workspace.requestConfig).tracePropagation, "off");
});

test("native injected context appears in actual/display snapshots and stays consistent across same-origin redirects", async () => {
  const generated: [string, string][] = [["traceparent", "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"]];
  const request = { url: "http://example.test/one", method: "GET", headers: [] as [string, string][], bodyBase64: null, tracePropagation: "w3c" };
  let hops = 0;
  const response = await executeHttp(request, { displayRequest: request, transport: async (next) => {
    if (hops++ === 0) return { status: 302, statusText: "Found", headers: [["location", "/two"]], bodyBase64: "", durationMs: 1, injectedTraceHeaders: generated };
    assert.deepEqual(next.headers, generated);
    return { status: 200, statusText: "OK", headers: [], bodyBase64: "", durationMs: 1, injectedTraceHeaders: [] };
  } });
  assert.deepEqual(response.timeline.request.headers, generated);
  assert.deepEqual(response.timeline.displayRequest?.headers, generated);
  assert.deepEqual(request.headers, []);
});

test("cross-origin redirects drop automatically generated context and do not generate a replacement", async () => {
  let hops = 0;
  const response = await executeHttp({ url: "http://one.test/", method: "GET", headers: [], bodyBase64: null, tracePropagation: "b3" }, { transport: async (next) => {
    if (hops++ === 0) return { status: 302, statusText: "Found", headers: [["location", "http://two.test/"]], bodyBase64: "", durationMs: 1, injectedTraceHeaders: [["b3", "0123456789abcdef-0123456789abcdef-1"]] };
    assert.equal(next.tracePropagation, "off"); assert.deepEqual(next.headers, []);
    return { status: 200, statusText: "OK", headers: [], bodyBase64: "", durationMs: 1 };
  } });
  assert.deepEqual(response.timeline.request.headers, []);
});

test("request provider selection, templates and explicit headers follow one composition path", async () => {
  const { integrationDefinitionSchema } = await import("../src/domain/project");
  const { getRequestHeaders } = await import("../src/features/request-workbench/model/request");
  const workspace = createWorkspace("synthetic", "synthetic");
  const integration = integrationDefinitionSchema.parse({ kind: "integration", id: "jaeger", name: "Jaeger", provider: "jaeger", enabled: true, configVersion: 1,
    tracing: { propagation: "w3c", requestHeaders: [{ name: "x-context", value: "{{$traceparent}}", enabled: true }, { name: "x-env", value: "{{stage}}", enabled: true }], responseHeaders: [{ name: "x-server-trace", value: "traceId", enabled: true }] } });
  const config = { ...workspace.requestConfig, integrations: [integration] };
  const original = workspace.documents.find(isRequestDocument)!.request;
  const draft = { ...original, url: "https://example.test/", tracing: { enabled: true, integrationId: integration.id } };
  const effective = applyWorkspaceRequestConfig(draft, "http", config);
  assert.equal(effective.tracePropagation, "w3c");
  assert.equal(getRequestHeaders(effective).find((header) => header.name === "x-context")?.readOnly, true);
  const { request } = await prepareWireRequest(effective, { variables: { stage: "testing" } });
  assert.deepEqual(request.headers, []);
  assert.deepEqual(request.traceHeaders, [["x-context", "{{$traceparent}}"], ["x-env", "testing"]]);
  const disabled = applyWorkspaceRequestConfig({ ...draft, tracing: { ...draft.tracing, enabled: false } }, "http", config);
  assert.equal(disabled.tracePropagation, "off");
  assert.equal(getRequestHeaders(disabled).filter((header) => header.enabled).length, 0);
  await prepareWireRequest(disabled, { variables: {} }); // Inactive templates must not resolve missing variables.
  const unavailable = applyWorkspaceRequestConfig(draft, "http", { ...config, integrations: [{ ...integration, enabled: false }] });
  assert.equal(unavailable.tracePropagation, "off");
  const explicit = { ...effective, headers: [{ id: "explicit", name: "traceparent", value: "user-value", enabled: true }] };
  assert.equal(getRequestHeaders(explicit).length, 1);
  assert.equal(getRequestHeaders(explicit)[0].value, "user-value");
});

test("per-request tracing selection round trips saved and working copies without generated templates", async () => {
  const workspace = createWorkspace("tracing", "tracing");
  const document = workspace.documents.find(isRequestDocument)!;
  document.saved = true;
  document.request.tracing = { enabled: true, integrationId: "provider-one" };
  document.savedRequest = cloneRequestDraft(document.request);
  document.request.tracing = { enabled: false, integrationId: "provider-two" };
  const secure = new MemorySecureStore();
  const result = await projectWorkspace(workspace, secure);
  const restored = await restoreWorkspace(result.project, result.local, secure, result.assets);
  const request = restored.documents.find(isRequestDocument)!;
  assert.deepEqual(request.request.tracing, { enabled: false, integrationId: "provider-two" });
  assert.deepEqual(request.savedRequest?.tracing, { enabled: true, integrationId: "provider-one" });
  assert.doesNotMatch(JSON.stringify(result.project), /traceHeaderTemplates|trace-generated/);
});
