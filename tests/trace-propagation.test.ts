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
