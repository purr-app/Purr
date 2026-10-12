import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspacePersistence } from "../src/application/workspace-persistence";
import { RequestHistory } from "../src/application/request-history";
import { persistImport } from "../src/application/import-project";
import { projectWorkspace } from "../src/application/project-projection";
import { CommitRejectedError, RecoveryRequiredError } from "../src/application/ports/credentials";
import { MemorySecureStore, SecretPreparationStore } from "../src/storage/secrets";
import { BrowserHistory } from "../src/storage/browser-history";
import { MemoryPersistenceBackend } from "./helpers/memory-persistence";
import { cloneRequestDraft, createWorkspace, isRequestDocument } from "../src/features/workspaces/model/workspace";
import type { NormalizedImportResult } from "../src/importing/contracts";

async function savedFixture() {
  const secure = new MemorySecureStore();
  const backend = new MemoryPersistenceBackend(secure);
  const persistence = new WorkspacePersistence(backend, secure);
  const workspace = createWorkspace("Transactional fixture", "transactional");
  const document = workspace.documents[0];
  assert.ok(isRequestDocument(document));
  document.saved = true;
  document.name = "Original request";
  document.request.auth.type = "basic";
  document.request.auth.basic.password = "synthetic-password-A";
  document.savedRequest = cloneRequestDraft(document.request);
  const store = { activeWorkspaceId: workspace.id, workspaces: [workspace], globalVariables: [] };
  await persistence.save(store);
  const ref = `purr/${workspace.id}/requests/${document.id}/saved/password`;
  assert.equal(await secure.get(ref), "synthetic-password-A");
  return { secure, backend, persistence, workspace, document, store, ref };
}

test("failed canonical save preserves the existing password and files; retry commits both", async () => {
  const { secure, backend, persistence, document, store, ref } = await savedFixture();
  const before = structuredClone(backend.snapshot);
  const commit = backend.commit.bind(backend);
  document.name = "Renamed request";
  document.request.auth.basic.password = "synthetic-password-B";
  document.savedRequest = cloneRequestDraft(document.request);
  backend.commit = async () => { throw new Error("Injected canonical commit failure"); };
  await assert.rejects(persistence.save(store), /Injected canonical commit failure/);
  assert.equal(await secure.get(ref), "synthetic-password-A");
  assert.equal(await persistence.secure.get(ref), "synthetic-password-A", "failed preparation cannot publish its cache");
  assert.deepEqual(backend.snapshot, before);

  backend.commit = commit;
  await persistence.save(store);
  assert.equal(await secure.get(ref), "synthetic-password-B");
  const files = JSON.stringify(backend.snapshot.workspaces[0].files);
  assert.match(files, /Renamed request/);
  assert.doesNotMatch(files, /synthetic-password-[AB]/);
});

test("project validation failure after credential preparation leaves the vault unchanged", async () => {
  const { secure, backend, persistence, workspace, document, store, ref } = await savedFixture();
  const before = structuredClone(backend.snapshot);
  document.request.auth.basic.password = "synthetic-invalid-project-password";
  document.savedRequest = cloneRequestDraft(document.request);
  workspace.documents.push({ ...document, request: cloneRequestDraft(document.request) });
  await assert.rejects(persistence.save(store), /Duplicate.*identifier/i);
  assert.equal(await secure.get(ref), "synthetic-password-A");
  assert.deepEqual(backend.snapshot, before);
});

test("a conflicting external file edit prevents a prepared credential deletion", async () => {
  const { secure, backend, persistence, workspace, document, store, ref } = await savedFixture();
  const files = (await backend.loadWorkspace(workspace.id)).files;
  const path = Object.keys(files).find((name) => name.startsWith("documents/") && name.endsWith(".yaml"));
  assert.ok(path);
  const file = files[path];
  await backend.commit(workspace.id, [{ path, expectedRevision: file.revision,
    content: file.content.replace("Original request", "External author edit") }], []);
  const before = structuredClone(backend.snapshot);
  const credentialBefore = await secure.read(ref);
  document.name = "Conflicting local edit";
  document.request.auth.basic.password = "";
  document.savedRequest = cloneRequestDraft(document.request);
  await assert.rejects(persistence.save(store), /conflict|externally/i);
  assert.deepEqual(await secure.read(ref), credentialBefore);
  assert.deepEqual(backend.snapshot, before, "aborted save must retain the external author's edit");
});

test("a lost acknowledgement after commit is reconciled without reporting a false failed save", async () => {
  const { secure, backend, persistence, document, store, ref } = await savedFixture();
  const commit = backend.commit.bind(backend);
  document.name = "Committed before acknowledgement";
  document.request.auth.basic.password = "synthetic-acknowledged-password";
  document.savedRequest = cloneRequestDraft(document.request);
  let commits = 0;
  backend.commit = async (...args) => {
    commits += 1;
    await commit(...args);
    throw new Error("Injected acknowledgement loss");
  };
  await persistence.save(store);
  assert.equal(commits, 1);
  assert.equal(await secure.get(ref), "synthetic-acknowledged-password");
  assert.equal(await persistence.secure.get(ref), "synthetic-acknowledged-password");
  assert.match(JSON.stringify(backend.snapshot.workspaces[0].files), /Committed before acknowledgement/);
});

test("an unreadable operation status reports recovery required and preserves the active credential", async () => {
  const { secure, backend, persistence, document, store, ref } = await savedFixture();
  const before = structuredClone(backend.snapshot);
  const credentialBefore = await secure.read(ref);
  document.request.auth.basic.password = "synthetic-uncertain-password";
  document.savedRequest = cloneRequestDraft(document.request);
  let attemptedOperationId = "";
  backend.commit = async (_id, _files, _local, batch) => {
    attemptedOperationId = batch?.operationId ?? "";
    throw new Error("Synthetic transport disconnect");
  };
  secure.operationStatus = async () => { throw new Error("Synthetic status unavailable"); };
  await assert.rejects(persistence.save(store), (error: unknown) => {
    assert.ok(error instanceof RecoveryRequiredError);
    assert.ok(attemptedOperationId);
    assert.equal(error.operationId, attemptedOperationId);
    return true;
  });
  assert.deepEqual(await secure.read(ref), credentialBefore);
  assert.deepEqual(backend.snapshot, before);
});

test("a known prior recovery conflict cannot be hidden by a committed operation receipt", async () => {
  const { secure, backend, persistence, document, store, ref } = await savedFixture();
  const before = structuredClone(backend.snapshot);
  const credentialBefore = await secure.read(ref);
  document.request.auth.basic.password = "synthetic-rejected-recovery-password";
  document.savedRequest = cloneRequestDraft(document.request);
  backend.commit = async () => { throw new Error("commit-rejected: Commit recovery-required; synthetic prior operation conflict"); };
  let statusReads = 0;
  secure.operationStatus = async (operationId) => { statusReads += 1; return { operationId, status: "committed" }; };
  await assert.rejects(persistence.save(store), (error: unknown) => {
    assert.ok(error instanceof CommitRejectedError);
    assert.equal(error.recoveryRequired, true);
    assert.match(error.message, /synthetic prior operation conflict/);
    return true;
  });
  assert.equal(statusReads, 0, "a known rejection must not be reinterpreted as acknowledgement loss");
  assert.deepEqual(await secure.read(ref), credentialBefore);
  assert.deepEqual(backend.snapshot, before);
});

test("projection returns protected records and a transient mutation plan without publishing credentials", async () => {
  const { secure, workspace, document, ref } = await savedFixture();
  const before = await secure.read(ref);
  document.request.auth.basic.password = "synthetic-preview-password";
  document.savedRequest = cloneRequestDraft(document.request);
  const projection = await projectWorkspace(workspace, secure);
  assert.deepEqual(await secure.read(ref), before);
  assert.ok(projection.secrets.mutations.some((mutation) => mutation.ref === ref && mutation.value === "synthetic-preview-password"));
  assert.doesNotMatch(JSON.stringify({ project: projection.project, local: projection.local, assets: projection.assets }), /synthetic-preview-password/);
});

test("global secret-only edits commit even when definitions do not change and failed updates preserve values", async () => {
  const secure = new MemorySecureStore();
  const backend = new MemoryPersistenceBackend(secure);
  const persistence = new WorkspacePersistence(backend, secure);
  const variable = { id: "global-token", name: "token", kind: "static" as const, sensitive: true, enabled: true, loaded: true, value: "synthetic-global-A" };
  const store = { activeWorkspaceId: "", workspaces: [], globalVariables: [variable] };
  const ref = "purr/global/variables/global-token";
  await persistence.save(store);
  const before = structuredClone(backend.snapshot);
  const writeGlobal = backend.writeGlobal.bind(backend);
  variable.value = "synthetic-global-B";
  backend.writeGlobal = async () => { throw new Error("Injected global commit failure"); };
  await assert.rejects(persistence.save(store), /Injected global commit failure/);
  assert.equal(await secure.get(ref), "synthetic-global-A");
  assert.deepEqual(backend.snapshot, before);
  backend.writeGlobal = writeGlobal;
  await persistence.save(store);
  assert.equal(await secure.get(ref), "synthetic-global-B");
  assert.deepEqual(backend.snapshot.global, before.global, "value-only changes leave canonical global definitions identical");
});

test("secret batches check every revision before publishing and replay without overwriting newer values", async () => {
  const secure = new MemorySecureStore();
  const first = "purr/transactional/variables/first";
  const second = "purr/transactional/variables/second";
  const initialFirst = await secure.read(first);
  const initialSecond = await secure.read(second);
  const batch = { operationId: crypto.randomUUID(), mutations: [
    { ref: first, expectedRevision: initialFirst.revision, value: "synthetic-first-A" },
    { ref: second, expectedRevision: initialSecond.revision, value: "synthetic-second-A" },
  ] };
  assert.equal((await secure.operationStatus(batch.operationId)).status, "missing");
  await secure.commit(batch);
  assert.equal((await secure.operationStatus(batch.operationId)).status, "committed");
  const committed = await secure.read(first);
  assert.ok(committed.revision > initialFirst.revision);
  await secure.commit({ operationId: crypto.randomUUID(), mutations: [{ ref: first, expectedRevision: committed.revision, value: "synthetic-first-B" }] });
  await secure.commit(batch);
  assert.equal(await secure.get(first), "synthetic-first-B", "old operation replay must not restore its old value");
  await assert.rejects(secure.commit({ ...batch, mutations: [{ ...batch.mutations[0], value: "operation-id-reuse" }] }));
  assert.equal((await secure.operationStatus(batch.operationId)).status, "committed", "rejected ID reuse must not corrupt the original operation result");

  const secondBefore = await secure.read(second);
  const staleOperationId = crypto.randomUUID();
  await assert.rejects(secure.commit({ operationId: staleOperationId, mutations: [
    { ref: second, expectedRevision: secondBefore.revision, value: "must-not-be-published" },
    { ref: first, expectedRevision: initialFirst.revision, value: "stale-write" },
  ] }));
  assert.equal((await secure.operationStatus(staleOperationId)).status, "aborted");
  assert.deepEqual(await secure.read(second), secondBefore, "a late conflict cannot publish earlier mutations");
  assert.equal(await secure.get(first), "synthetic-first-B");
});

test("deletion keeps revision history so an old missing snapshot cannot recreate a changed secret", async () => {
  const secure = new MemorySecureStore();
  const ref = "purr/transactional/variables/deleted";
  const missing = await secure.read(ref);
  await secure.commit({ operationId: crypto.randomUUID(), mutations: [{ ref, expectedRevision: missing.revision, value: "synthetic-created" }] });
  const created = await secure.read(ref);
  await secure.commit({ operationId: crypto.randomUUID(), mutations: [{ ref, expectedRevision: created.revision, value: null }] });
  const deleted = await secure.read(ref);
  assert.equal(deleted.value, null);
  assert.ok(deleted.revision > created.revision);
  await assert.rejects(secure.commit({ operationId: crypto.randomUUID(), mutations: [{ ref, expectedRevision: missing.revision, value: "stale-recreation" }] }));
  assert.deepEqual(await secure.read(ref), deleted);
});

test("failed history append cannot publish its prepared editor credentials", async () => {
  const secure = new MemorySecureStore();
  const values = new Map<string, unknown>();
  const port = new BrowserHistory({
    read: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    write: async (changes) => { for (const change of changes) values.set(change.key, structuredClone(change.value)); },
    legacy: async () => [], deleteSecrets: async () => {},
  });
  let attemptedId = "";
  port.append = async (_workspace, entry) => { attemptedId = entry.id; throw new Error("Injected history publication failure"); };
  const history = new RequestHistory(port, secure, (work) => work());
  const workspace = createWorkspace("History", "transactional");
  const document = workspace.documents[0];
  assert.ok(isRequestDocument(document));
  document.request.auth.bearer.token = "synthetic-history-secret";
  await assert.rejects(history.append(workspace.id, {
    documentId: document.id, name: document.name, kind: "http", editor: document.request,
    response: null, error: "Synthetic transport failure", outcome: "error", startedAt: Date.now(), durationMs: 1,
  }), /Injected history publication failure/);
  assert.ok(attemptedId);
  assert.equal(await secure.get(`purr/${workspace.id}/history/${attemptedId}/editor/auth/bearer/token`), null);
  assert.equal(history.getSnapshot(), 0);
  assert.equal(values.size, 0);
});

test("failed import leaves neither a new credential nor a compensation revision", async () => {
  const secure = new MemorySecureStore();
  const backend = new MemoryPersistenceBackend(secure);
  const persistence = new WorkspacePersistence(backend, secure);
  const ref = "purr/imported/variables/token";
  const before = await secure.read(ref);
  const result: NormalizedImportResult = {
    adapter: "postman-environment", diagnostics: [],
    workspace: { id: "imported", name: "Imported", headers: [], auth: [], variables: [] },
    resources: [{ id: "environment", kind: "environment", name: "Environment", variables: [
      { id: "token", name: "token", kind: "static", sensitive: true, enabled: true, secretRef: ref },
    ] }], secrets: [{ ref, value: "synthetic-import-secret" }],
  };
  backend.commit = async () => { throw new Error("Injected import commit failure"); };
  await assert.rejects(persistImport(result, persistence), /Injected import commit failure/);
  assert.deepEqual(await secure.read(ref), before, "failure must not write then compensate with a delete");
  assert.deepEqual(backend.snapshot.workspaces, []);
});

test("external reconciliation prepares working credentials without changing the active vault", async () => {
  const { secure, backend, persistence, workspace, document, store, ref } = await savedFixture();
  const stored = await backend.loadWorkspace(workspace.id);
  const manifest = stored.files["purr.yaml"];
  await backend.commit(workspace.id, [{ path: "purr.yaml", expectedRevision: manifest.revision,
    content: manifest.content.replace("Transactional fixture", "Externally renamed workspace") }], []);
  document.request.auth.basic.password = "synthetic-working-password";
  const editorRef = `purr/${workspace.id}/drafts/${document.id}/request/auth/basic/password`;
  const before = await secure.read(editorRef);
  const reconciled = await persistence.reconcileExternalChanges(store);
  assert.equal(reconciled.workspaces[0].name, "Externally renamed workspace");
  const working = reconciled.workspaces[0].documents.find((item) => item.id === document.id);
  assert.ok(working && isRequestDocument(working));
  assert.equal(working.request.auth.basic.password, "synthetic-working-password");
  assert.equal(await secure.get(ref), "synthetic-password-A");
  assert.deepEqual(await secure.read(editorRef), before, "preview-only staged refs must not reach the vault");
});

test("an integration editor retries an aborted save with a fresh operation and retains staged values", async () => {
  const { secure, backend, persistence, workspace } = await savedFixture();
  const ref = `purr/${workspace.id}/integrations/fixture/auth`;
  const prepared = new SecretPreparationStore(persistence.secure);
  await prepared.set(ref, "synthetic-integration-auth");
  workspace.extraResources = [{ kind: "integration", id: "fixture", name: "Fixture", provider: "jaeger", enabled: true,
    configVersion: 1, config: { endpoint: "https://example.test" }, credentials: { auth: { kind: "secret", ref } } }];
  const original = backend.commit.bind(backend);
  const attempts: string[] = [];
  backend.commit = async (_id, _files, _local, batch) => {
    assert.ok(batch);
    attempts.push(batch.operationId);
    await secure.commitWith(batch, () => { throw new Error("Injected integration failure"); });
    throw new Error("Unexpected replay");
  };
  await assert.rejects(persistence.saveWorkspace(workspace, prepared), /Injected integration failure/);
  assert.equal(await secure.get(ref), null);
  backend.commit = async (...args) => { assert.ok(args[3]); attempts.push(args[3].operationId); return original(...args); };
  await persistence.saveWorkspace(workspace, prepared);
  assert.notEqual(attempts[0], attempts[1]);
  assert.equal((await secure.operationStatus(attempts[0])).status, "aborted");
  assert.equal(await secure.get(ref), "synthetic-integration-auth");
});

test("selection preference failure cannot hide a successfully committed import", async () => {
  const secure = new MemorySecureStore();
  const backend = new MemoryPersistenceBackend(secure);
  const persistence = new WorkspacePersistence(backend, secure);
  backend.setActiveWorkspace = async () => { throw new Error("Injected selection write failure"); };
  const ref = "purr/import-selection/variables/token";
  const result: NormalizedImportResult = {
    adapter: "postman-collection", diagnostics: [],
    workspace: { id: "import-selection", name: "Imported", headers: [], auth: [], variables: [
      { id: "token", name: "TOKEN", enabled: true, sensitive: true, kind: "static", secretRef: ref },
    ] },
    resources: [], secrets: [{ ref, value: "synthetic-imported-token" }],
  };
  const workspace = await persistImport(result, persistence);
  assert.equal(workspace.id, "import-selection");
  assert.equal(await secure.get(ref), "synthetic-imported-token");
  assert.equal(backend.snapshot.workspaces.length, 1);
});

test("committed workspace deletion invalidates caches even while folder cleanup is pending", async () => {
  const { secure, backend, persistence, workspace, store } = await savedFixture();
  const original = backend.deleteWorkspace.bind(backend);
  backend.deleteWorkspace = async (id) => { await original(id); return { committed: true, cleanupPending: true }; };
  assert.deepEqual(await persistence.deleteWorkspace(workspace.id), { committed: true, cleanupPending: true });
  await persistence.save(store);
  assert.equal(backend.snapshot.workspaces.length, 0, "stale runtime snapshots cannot resurrect committed deletion");
  assert.equal(await secure.get(`purr/${workspace.id}/requests/${workspace.documents[0].id}/saved/password`), null);
});
