import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { WorkspacePersistence } from "../src/application/workspace-persistence";
import { MemorySecureStore } from "../src/storage/secrets";
import { MemoryPersistenceBackend } from "./helpers/memory-persistence";
import { cloneRequestDraft, isRequestDocument } from "../src/features/workspaces/model/workspace";
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
