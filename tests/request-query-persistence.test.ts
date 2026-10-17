import { test } from "node:test";
import assert from "node:assert/strict";
import { projectAndCommit } from "./helpers/project-workspace";
import { restoreWorkspace } from "../src/application/project-projection";
import { createGraphqlDocument, createWorkspace, cloneRequestDraft, isRequestDocument, isDocumentDirty } from "../src/features/workspaces/model/workspace";
import { applyRequestQueryParamsToUrl } from "../src/features/request-workbench/model/request";
import { prepareWireRequest } from "../src/features/request-workbench/services/execute-request";
import { MemorySecureStore } from "../src/storage/secrets";
import { serializeResource } from "../src/storage/yaml";
import { semanticSections } from "../src/features/git/semantic-diff";
import { WorkspacePersistence } from "../src/application/workspace-persistence";
import { MemoryPersistenceBackend } from "./helpers/memory-persistence";
import { deserializeResource } from "../src/storage/yaml";
import { createHash } from "node:crypto";

for (const kind of ["http", "graphql"] as const) test(`${kind} saves query edits only in params and restores the full editor URL`, async () => {
  const workspace = createWorkspace(); if (kind === "graphql") workspace.documents = [createGraphqlDocument()];
  const document = workspace.documents[0]; assert.ok(isRequestDocument(document)); document.saved = true;
  if (document.request.graphql) document.request.graphql.query = "query { hello }";
  document.request.url = "{{base}}/users#results";
  document.request.params = [
    { id: "one", key: "tag", value: "red blue", enabled: true },
    { id: "two", key: "tag", value: "{{value}}", enabled: true },
    { id: "off", key: "disabled", value: "kept", enabled: false },
    { id: "empty", key: "", value: "", enabled: false },
  ];
  document.request.url = applyRequestQueryParamsToUrl(document.request.url, document.request.params);
  document.savedRequest = cloneRequestDraft(document.request);
  const secure = new MemorySecureStore(), before = await projectAndCommit(workspace, secure);
  document.request.params[0].value = "yellow";
  document.request.url = applyRequestQueryParamsToUrl(document.request.url, document.request.params);
  document.savedRequest = cloneRequestDraft(document.request);
  const after = await projectAndCommit(workspace, secure), resource = after.project.resources[0];
  assert.ok(resource.kind === "http" || resource.kind === "graphql");
  assert.equal(resource.url, "{{base}}/users#results"); assert.equal(resource.params.length, 3);
  const sections = semanticSections(serializeResource(before.project.resources[0]), serializeResource(resource))!;
  assert.equal(sections.find((section) => section.key === "url")?.changed, false);
  assert.equal(sections.find((section) => section.key === "params")?.changed, true);
  const restored = await restoreWorkspace(after.project, after.local, secure, after.assets), restoredDocument = restored.documents[0];
  assert.ok(isRequestDocument(restoredDocument)); assert.equal(restoredDocument.request.url, document.request.url);
  assert.equal(isDocumentDirty(restoredDocument), false);
  assert.deepEqual((await projectAndCommit(restored, secure)).project, after.project);
  const context = { variables: { base: "https://example.test", value: "a/b" } };
  assert.equal((await prepareWireRequest(restoredDocument.request, context)).request.url, (await prepareWireRequest(document.request, context)).request.url);
});

test("URL-only queries from older files retain duplicate names, encoded values and fragments", async () => {
  const workspace = createWorkspace(), document = workspace.documents[0]; assert.ok(isRequestDocument(document)); document.saved = true;
  document.request.url = "https://example.test/users?tag=one&tag=two&value=a%2Bb%26c#results";
  document.savedRequest = cloneRequestDraft(document.request);
  const secure = new MemorySecureStore(), projected = await projectAndCommit(workspace, secure), resource = projected.project.resources[0];
  assert.ok(resource.kind === "http"); assert.equal(resource.url, "https://example.test/users#results");
  assert.deepEqual(resource.params.map((row) => [row.name, row.value]), [["tag", "one"], ["tag", "two"], ["value", "a+b&c"]]);
  const restored = await restoreWorkspace(projected.project, [], secure, projected.assets), request = restored.documents[0]; assert.ok(isRequestDocument(request));
  assert.equal((await prepareWireRequest(request.request, {})).request.url, (await prepareWireRequest(document.request, {})).request.url);
  const legacy = { ...projected.project, resources: [{ ...resource, url: document.request.url }] };
  const loadedLegacy = await restoreWorkspace(legacy, [], secure, {}), normalized = await projectAndCommit(loadedLegacy, secure);
  assert.deepEqual(normalized.project.resources, projected.project.resources);
});

test("explicit disabled rows override same-name URL queries without losing URL-only rows", async () => {
  const workspace = createWorkspace(), document = workspace.documents[0]; assert.ok(isRequestDocument(document)); document.saved = true;
  document.request.url = "https://example.test?off=old&extra=kept";
  document.request.params = [{ id: "off", key: "off", value: "disabled", enabled: false }, { id: "other", key: "other", value: "active", enabled: true }];
  document.savedRequest = cloneRequestDraft(document.request);
  const secure = new MemorySecureStore(), projected = await projectAndCommit(workspace, secure), resource = projected.project.resources[0]; assert.ok(resource.kind === "http");
  assert.deepEqual(resource.params.map((row) => [row.name, row.value, row.enabled]), [["extra", "kept", true], ["off", "disabled", false], ["other", "active", true]]);
  const restored = await restoreWorkspace(projected.project, [], secure, projected.assets), result = restored.documents[0]; assert.ok(isRequestDocument(result));
  assert.equal((await prepareWireRequest(result.request, {})).request.url, (await prepareWireRequest(document.request, {})).request.url);
});

test("the synthetic empty editor row does not discard a URL-only value with an empty name", async () => {
  const workspace = createWorkspace(), document = workspace.documents[0]; assert.ok(isRequestDocument(document)); document.saved = true;
  document.request.url = "https://example.test?=retained"; document.savedRequest = cloneRequestDraft(document.request);
  const projected = await projectAndCommit(workspace, new MemorySecureStore()), resource = projected.project.resources[0]; assert.ok(resource.kind === "http");
  assert.equal(resource.url, "https://example.test"); assert.deepEqual(resource.params, [{ name: "", value: "retained", enabled: true }]);
});

for (const mirrored of [false, true]) test(`old ${mirrored ? "mirrored" : "URL-only"} queries stay unchanged on UI-only saves and normalize on a saved edit`, async () => {
  const secure = new MemorySecureStore(), backend = new MemoryPersistenceBackend(secure);
  const initial = new WorkspacePersistence(backend, secure), store = await initial.load(), document = store.workspaces[0].documents[0];
  assert.ok(isRequestDocument(document)); document.saved = true;
  document.request.url = "https://example.test/users?tag=one&tag=two#results";
  document.savedRequest = cloneRequestDraft(document.request); await initial.save(store);
  const snapshot = backend.snapshot.workspaces[0], path = Object.keys(snapshot.files).find((path) => path.startsWith("documents/"))!;
  const old = deserializeResource(snapshot.files[path].content); assert.ok(old.kind === "http");
  old.url = document.request.url; if (!mirrored) old.params = [];
  const content = serializeResource(old);
  snapshot.files[path] = { content, revision: createHash("sha256").update(content).digest("hex") };
  const persistence = new WorkspacePersistence(backend, secure), loaded = await persistence.load(), workspace = loaded.workspaces[0];
  const request = workspace.documents[0]; assert.ok(isRequestDocument(request)); assert.equal(isDocumentDirty(request), false);
  const writes = backend.writes.length;
  workspace.ui.previewDocumentId = request.id; await persistence.save(loaded);
  assert.equal(backend.writes.length, writes); assert.equal(backend.snapshot.workspaces[0].files[path].content, content);
  const reconciled = await persistence.reconcileExternalChanges(loaded); await persistence.save(reconciled);
  assert.deepEqual(reconciled.workspaces[0].editorConflicts ?? {}, {});
  assert.equal(backend.writes.length, writes);
  const reopening = new WorkspacePersistence(backend, secure), reopened = await reopening.load(), edited = reopened.workspaces[0].documents[0]; assert.ok(isRequestDocument(edited));
  assert.equal(edited.request.url, document.request.url); assert.equal(isDocumentDirty(edited), false);
  edited.request.params[0].value = "changed";
  edited.request.url = applyRequestQueryParamsToUrl(edited.request.url, edited.request.params); edited.savedRequest = cloneRequestDraft(edited.request);
  await reopening.save(reopened);
  const saved = deserializeResource(backend.snapshot.workspaces[0].files[path].content); assert.ok(saved.kind === "http");
  assert.equal(saved.url, "https://example.test/users#results"); assert.deepEqual(saved.params.map((row) => row.value), ["changed", "two"]);
});
