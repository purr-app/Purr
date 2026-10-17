import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { WorkspacePersistence } from "../src/application/workspace-persistence";
import { MemorySecureStore } from "../src/storage/secrets";
import { MemoryPersistenceBackend } from "./helpers/memory-persistence";
import { cloneRequestDraft, createSchemaDocument, isRequestDocument } from "../src/features/workspaces/model/workspace";
import { deserializeResource, serializeResource } from "../src/storage/yaml";

async function fixture() {
  const secure = new MemorySecureStore(); const backend = new MemoryPersistenceBackend(secure); const persistence = new WorkspacePersistence(backend, secure);
  const store = await persistence.load(); const workspace = store.workspaces[0]; const document = workspace.documents[0]; assert.ok(isRequestDocument(document));
  document.name = "Saved"; document.saved = true; document.request.url = "https://example.test/before"; document.savedRequest = cloneRequestDraft(document.request);
  await persistence.save(store);
  const snapshot = backend.snapshot.workspaces[0]; const path = Object.keys(snapshot.files).find((path) => path.startsWith("documents/"))!;
  const external = (content: string | null) => { const snapshot = backend.snapshot.workspaces[0]; if (content === null) delete snapshot.files[path]; else snapshot.files[path] = { content, revision: createHash("sha256").update(content).digest("hex") }; };
  return { secure, backend, persistence, store, workspace, document, get snapshot() { return backend.snapshot.workspaces[0]; }, path, external };
}

test("external request changes preserve the dirty editor and update its canonical baseline", async () => {
  const f = await fixture(); f.document.request.url = "https://example.test/local"; await f.persistence.save(f.store);
  const incoming = deserializeResource(f.snapshot.files[f.path].content); assert.ok(incoming.kind === "http"); incoming.url = "https://example.test/incoming";
  f.external(serializeResource(incoming)); const reconciled = await f.persistence.reconcileExternalChanges(f.store); const workspace = reconciled.workspaces[0]; const document = workspace.documents[0]; assert.ok(isRequestDocument(document));
  assert.equal(document.request.url, "https://example.test/local"); assert.equal(document.savedRequest?.url, incoming.url); assert.equal(workspace.editorConflicts?.[document.id].incoming?.id, document.id);
  await f.persistence.save(reconciled); assert.equal(deserializeResource(f.snapshot.files[f.path].content).kind, "http"); assert.match(f.snapshot.files[f.path].content, /incoming/); assert.doesNotMatch(f.snapshot.files[f.path].content, /\/local/);
  const reopened = await new WorkspacePersistence(f.backend, f.secure).load(); const restored = reopened.workspaces[0].documents[0]; assert.ok(isRequestDocument(restored)); assert.equal(restored.request.url, "https://example.test/local"); assert.ok(reopened.workspaces[0].editorConflicts?.[restored.id]);
});

test("deleted dirty requests remain recoverable drafts and are never recreated by autosave", async () => {
  const f = await fixture(); f.document.request.url = "https://example.test/local"; await f.persistence.save(f.store); f.external(null);
  const reconciled = await f.persistence.reconcileExternalChanges(f.store); const workspace = reconciled.workspaces[0]; const recovered = workspace.documents.find((document) => document.id === f.document.id)!;
  assert.equal(recovered.saved, false); assert.equal(workspace.editorConflicts?.[recovered.id].incoming, null); assert.equal(workspace.ui.activeDocumentId, recovered.id);
  await f.persistence.save(reconciled); assert.equal(f.snapshot.files[f.path], undefined);
});

test("clean external updates preserve tab identity and reject an identity replacement", async () => {
  const f = await fixture(); const incoming = deserializeResource(f.snapshot.files[f.path].content); assert.ok(incoming.kind === "http"); incoming.url = "https://example.test/incoming"; f.external(serializeResource(incoming));
  const reconciled = await f.persistence.reconcileExternalChanges(f.store); const workspace = reconciled.workspaces[0]; const document = workspace.documents[0]; assert.ok(isRequestDocument(document));
  assert.equal(document.request.url, incoming.url); assert.equal(workspace.ui.activeDocumentId, f.document.id); assert.deepEqual(workspace.ui.openDocumentIds, f.workspace.ui.openDocumentIds); assert.deepEqual(workspace.editorConflicts, {});
  f.snapshot.files["purr.yaml"] = { content: f.snapshot.files["purr.yaml"].content.replace(f.workspace.id, "other-workspace"), revision: "different-identity" };
  await assert.rejects(f.persistence.reconcileExternalChanges(reconciled), /identity|identifier/i);
});

test("a queued pre-pull save cannot overwrite the reconciled incoming definition", async () => {
  const f = await fixture(); const incoming = deserializeResource(f.snapshot.files[f.path].content); assert.ok(incoming.kind === "http"); incoming.url = "https://example.test/incoming"; f.external(serializeResource(incoming));
  await f.persistence.reconcileExternalChanges(f.store);
  await assert.rejects(f.persistence.save(f.store), /changed externally while this save was queued/);
  assert.match(f.snapshot.files[f.path].content, /incoming/);
});

test("a kind change keeps the incoming resource and recovers the old editor under a new draft ID", async () => {
  const f = await fixture(); f.document.request.url = "https://example.test/local"; await f.persistence.save(f.store);
  const incoming = deserializeResource(f.snapshot.files[f.path].content); assert.ok(incoming.kind === "http");
  f.external(serializeResource({ ...incoming, kind: "graphql", graphql: { query: "query { hello }", variables: "{}" } }));
  const reconciled = await f.persistence.reconcileExternalChanges(f.store); const workspace = reconciled.workspaces[0];
  const canonical = workspace.documents.find((document) => document.id === f.document.id); assert.equal(canonical?.kind, "graphql");
  const recovered = workspace.documents.find((document) => document.id !== f.document.id && document.kind === "http"); assert.ok(recovered && isRequestDocument(recovered)); assert.equal(recovered.request.url, "https://example.test/local"); assert.equal(recovered.saved, false);
  assert.equal(workspace.ui.activeDocumentId, recovered.id); assert.ok(workspace.editorConflicts?.[recovered.id]);
  await f.persistence.save(reconciled); assert.equal(deserializeResource(f.snapshot.files[f.path].content).kind, "graphql");
});

test("a request replaced by an API schema keeps a recoverable editor without reusing the canonical ID", async () => {
  const f = await fixture(); f.document.request.url = "https://example.test/local"; await f.persistence.save(f.store);
  const path = "schemas/incoming.openapi";
  f.snapshot.files[path] = { content: "openapi: 3.1.0\ninfo:\n  title: Incoming\n  version: '1'\npaths: {}\n", revision: "new-sidecar" };
  f.external(serializeResource({ id: f.document.id, kind: "api-schema", name: "Incoming schema", format: "openapi-3", source: { type: "text", location: "fixture" }, document: f.snapshot.files[path].content }, path));
  const reconciled = await f.persistence.reconcileExternalChanges(f.store); const workspace = reconciled.workspaces[0];
  const recovered = workspace.documents.find((document) => isRequestDocument(document) && document.request.url === "https://example.test/local");
  assert.ok(recovered); assert.notEqual(recovered.id, f.document.id); assert.equal(recovered.saved, false);
  assert.equal(workspace.editorConflicts?.[recovered.id].incoming?.kind, "api-schema"); assert.equal(workspace.ui.activeDocumentId, recovered.id);
  await f.persistence.save(reconciled); assert.equal(deserializeResource(f.snapshot.files[f.path].content, (name) => f.snapshot.files[name].content).kind, "api-schema");
  const reopened = await new WorkspacePersistence(f.backend, f.secure).load(); assert.ok(reopened.workspaces[0].documents.some((document) => document.id === recovered.id));
});

test("Git recovery preserves local editors and vault availability, then clears even if files did not change", async () => {
  const f = await fixture();
  f.document.request.url = "https://example.test/unsaved";
  await f.persistence.save(f.store);
  f.snapshot.local.push({ table: "workspace_local_state", id: "git-operation", protection: "encrypted", value: { version: 1, kind: "stash" } });
  const pending = await f.persistence.reconcileExternalChanges(f.store);
  assert.equal(f.persistence.getWorkspaceStatus(f.workspace.id).gitRecovery, true);
  assert.equal(f.persistence.getWorkspaceStatus(f.workspace.id).publicWritable, false);
  assert.equal(f.persistence.getWorkspaceStatus(f.workspace.id).protectedState.status, "available");
  assert.equal((pending.workspaces[0].documents[0] as typeof f.document).request.url, "https://example.test/unsaved");
  f.snapshot.local = f.snapshot.local.filter((record) => record.id !== "git-operation");
  const restored = await f.persistence.reconcileExternalChanges(pending);
  assert.equal(f.persistence.getWorkspaceStatus(f.workspace.id).gitRecovery, false);
  assert.equal(f.persistence.getWorkspaceStatus(f.workspace.id).publicWritable, true);
  assert.equal(restored.workspaces[0].publicWritable, true);
  assert.equal((restored.workspaces[0].documents[0] as typeof f.document).request.url, "https://example.test/unsaved");
});

test("stash reconciliation does not recreate a removed binary asset and apply restores its bytes", async () => {
  const f = await fixture(); const baseline = structuredClone(f.snapshot.files);
  const file = new File([new Uint8Array([0, 255, 13, 10])], "payload.bin", { type: "application/octet-stream" });
  f.document.request.body.type = "binary"; f.document.request.body.binary = { file, name: file.name, size: file.size, mimeType: file.type };
  f.document.savedRequest = cloneRequestDraft(f.document.request); await f.persistence.save(f.store);
  const stashed = structuredClone(f.snapshot.files); const asset = Object.keys(stashed).find((path) => path.startsWith("assets/"))!;
  assert.ok(asset);
  f.snapshot.files = baseline;
  const clean = await f.persistence.reconcileExternalChanges(f.store);
  await f.persistence.save(clean);
  assert.equal(f.snapshot.files[asset], undefined);
  assert.equal((clean.workspaces[0].documents[0] as typeof f.document).request.body.type, "none");
  f.snapshot.files = stashed;
  const applied = await f.persistence.reconcileExternalChanges(clean);
  const restored = applied.workspaces[0].documents[0]; assert.ok(isRequestDocument(restored));
  assert.equal(restored.request.body.type, "binary");
  assert.deepEqual(new Uint8Array(await restored.request.body.binary!.file.arrayBuffer()), new Uint8Array(await file.arrayBuffer()));
  assert.equal(f.persistence.getWorkspaceStatus(f.workspace.id).protectedState.status, "available");
  assert.equal(f.persistence.getWorkspaceStatus(f.workspace.id).publicWritable, true);
});

test("stash removes a new pinned schema without autosave recreating its definition or SDL", async () => {
  const f = await fixture(); const baseline = structuredClone(f.snapshot.files);
  const schema = createSchemaDocument(); schema.saved = true; schema.name = "Rick and Morty copy";
  schema.endpoint = "https://rickandmortyapi.com/graphql/"; schema.source = "introspection";
  schema.sdl = "type Query { character: Character }\ntype Character { name: String }";
  f.workspace.documents.push(schema); await f.persistence.save(f.store);
  const stashed = structuredClone(f.snapshot.files);
  assert.equal(Object.keys(stashed).filter((path) => path.startsWith("schemas/")).length, 2);
  f.snapshot.files = baseline;
  const clean = await f.persistence.reconcileExternalChanges(f.store);
  assert.equal(clean.workspaces[0].documents.some((document) => document.id === schema.id), false);
  await f.persistence.save(clean);
  assert.equal(Object.keys(f.snapshot.files).some((path) => path.startsWith("schemas/")), false);
  f.snapshot.files = stashed;
  const applied = await f.persistence.reconcileExternalChanges(clean);
  assert.equal(applied.workspaces[0].documents.find((document) => document.id === schema.id)?.kind, "schema");
});
