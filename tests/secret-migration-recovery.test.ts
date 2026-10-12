import assert from "node:assert/strict";
import test from "node:test";
import { invalidateSecretBuffers } from "../src/application/invalidate-secret-buffers";
import { WorkspacePersistence } from "../src/application/workspace-persistence";
import { CommitRejectedError, type SecretFieldState } from "../src/application/ports/credentials";
import type { StoredWorkspace } from "../src/application/ports/persistence";
import { MemorySecureStore } from "../src/storage/secrets";
import { cloneRequestDraft, createWorkspace, duplicateDocument, isDocumentDirty, isRequestDocument, type Workspace, type WorkspaceStore } from "../src/features/workspaces/model/workspace";
import { MemoryPersistenceBackend } from "./helpers/memory-persistence";

const storeFor = (workspace: Workspace): WorkspaceStore => ({ activeWorkspaceId: workspace.id, workspaces: [workspace], globalVariables: [] });
function request(workspace: Workspace) {
  const document = workspace.documents.find(isRequestDocument); assert.ok(document); return document;
}
function legacy(id = "migration-recovery"): StoredWorkspace {
  return { id, local: [], files: {
    "purr.yaml": { content: `purr: 1\nworkspace:\n  id: ${id}\n  name: Recovery fixture\n`, revision: "manifest-v1" },
    "documents/request.yaml": { content: "purr: 1\nkind: http\nid: legacy-request\nname: Legacy request\nmethod: GET\nurl: https://example.test/saved\nheaders:\n  - name: X-Custom\n    value: synthetic-header-one\n  - name: X-Custom\n    value: synthetic-header-two\n    enabled: false\nauth: { type: none }\n", revision: "request-v1" },
  } };
}
function legacySession(snapshot: StoredWorkspace) {
  const document = request(createWorkspace("Recovery fixture", snapshot.id));
  document.id = "legacy-request"; document.name = "Legacy request"; document.saved = true;
  document.request.url = "https://example.test/saved";
  document.request.headers = [
    { id: "retained-first", name: "X-Custom", value: "synthetic-header-one", enabled: true, secret: true },
    { id: "retained-second", name: "X-Custom", value: "synthetic-header-two", enabled: false, secret: false },
  ];
  document.savedRequest = cloneRequestDraft(document.request);
  const session = { editor: cloneRequestDraft(document.request), definition: snapshot.files["documents/request.yaml"].content };
  snapshot.local.push({ table: "document_session_state", id: document.id, value: session });
  return { document, session };
}
function canonicalHeaders(persistence: WorkspacePersistence, id: string) {
  const resource = persistence.getProject(id)?.resources.find((value) => value.id === "legacy-request");
  assert.ok(resource?.kind === "http"); return resource.headers;
}
function setup(snapshot?: StoredWorkspace) {
  const secure = new MemorySecureStore(); const backend = new MemoryPersistenceBackend(secure);
  if (snapshot) backend.snapshot = { activeWorkspaceId: snapshot.id, workspaces: [snapshot] };
  return { secure, backend, persistence: new WorkspacePersistence(backend, secure) };
}

for (const proof of ["definition", "revision"] as const) test(`v1 clean ${proof}-verified session recovers header sensitivity and stable duplicate identities`, async () => {
  const snapshot = legacy(); const { session } = legacySession(snapshot);
  if (proof === "revision") Object.assign(session, { definition: undefined, legacySourceRevision: "request-v1" });
  const original = structuredClone(snapshot.files); const { persistence, backend, secure } = setup(snapshot);
  const store = await persistence.load();
  assert.deepEqual(canonicalHeaders(persistence, snapshot.id).map(({ id, sensitive, enabled }) => ({ id, sensitive, enabled })), [
    { id: "retained-first", sensitive: true, enabled: true }, { id: "retained-second", sensitive: false, enabled: false },
  ]);
  assert.deepEqual(backend.snapshot.workspaces[0].files, original); assert.equal(backend.writes.length, 0);
  await persistence.upgradeWorkspace(store.workspaces[0]);
  const upgraded = canonicalHeaders(persistence, snapshot.id);
  assert.equal(upgraded[0].id, "retained-first"); assert.equal(upgraded[0].value.kind, "secret");
  if (upgraded[0].value.kind === "secret") assert.equal(await secure.get(upgraded[0].value.ref), "synthetic-header-one");
  assert.equal(upgraded[1].id, "retained-second"); assert.equal(upgraded[1].enabled, false);
  assert.ok(!JSON.stringify(backend.snapshot.workspaces[0].files).includes("synthetic-header-one"));
});

for (const invalid of ["dirty", "unmatched", "duplicate-ids", "row-mismatch"] as const) test(`v1 ${invalid} session cannot reclassify the saved public header definition`, async () => {
  const snapshot = legacy(); const { document, session } = legacySession(snapshot);
  if (invalid === "dirty") {
    document.request.url = "https://example.test/unsaved";
    snapshot.local.push({ table: "drafts", id: document.id, value: document });
  } else if (invalid === "unmatched") session.definition = session.definition.replace("/saved", "/different-source");
  else if (invalid === "duplicate-ids") session.editor.headers[1].id = session.editor.headers[0].id;
  else session.editor.headers[1].name = "X-Different";
  const original = structuredClone(snapshot.files); const { persistence, backend } = setup(snapshot);
  await persistence.load();
  assert.deepEqual(canonicalHeaders(persistence, snapshot.id).map(({ id, sensitive }) => ({ id, sensitive })), [
    { id: "legacy-header-0", sensitive: false }, { id: "legacy-header-1", sensitive: false },
  ]);
  assert.deepEqual(backend.snapshot.workspaces[0].files, original);
});

test("invalid, future and mixed-format workspaces stay intact and read-only without hiding a healthy catalogue entry", async () => {
  const healthy = legacy("healthy"); const invalid = legacy("invalid"); const future = legacy("future"); const mixed = legacy("mixed");
  invalid.files["documents/request.yaml"].content = "purr: [unterminated";
  future.files["purr.yaml"].content = future.files["purr.yaml"].content.replace("purr: 1", "purr: 999");
  mixed.files["documents/request.yaml"].content = mixed.files["documents/request.yaml"].content.replace("purr: 1", "purr: 2");
  const { backend, persistence } = setup(); backend.snapshot = { activeWorkspaceId: "healthy", workspaces: [invalid, future, mixed, healthy] };
  const originals = structuredClone([invalid, future, mixed]); const store = await persistence.load();
  assert.equal(store.workspaces.length, 4); assert.equal(store.activeWorkspaceId, "healthy");
  assert.equal(request(store.workspaces.find((workspace) => workspace.id === "healthy")!).request.url, "https://example.test/saved");
  for (const original of originals) {
    const workspace = store.workspaces.find((value) => value.id === original.id)!;
    assert.equal(persistence.getWorkspaceStatus(original.id).protectedState.status, "recovery-required");
    assert.deepEqual(workspace.documents, []);
    await assert.rejects(persistence.saveWorkspace(workspace), /read.only|unavailable|protected/i);
    assert.deepEqual(backend.snapshot.workspaces.find((value) => value.id === original.id), original);
  }
  assert.equal(persistence.getWorkspaceStatus("healthy").protectedState.status, "available");
});

for (const shape of ["array", "definitions-and-entries"] as const) test(`only documented legacy ${shape} workspace auth runtime is migrated`, async () => {
  const snapshot = legacy(); const auth = request(createWorkspace("Auth fixture", snapshot.id)).request.auth;
  const entries = [{ id: "old-auth", value: auth }];
  snapshot.local.push({ table: "workspace_local_state", id: "auth-runtime", value: shape === "array" ? entries : { definitions: [], entries } });
  const { backend, persistence } = setup(snapshot); await persistence.load();
  assert.equal(persistence.getWorkspaceStatus(snapshot.id).protectedState.status, "available");
  assert.deepEqual(backend.snapshot.workspaces[0].local.find((record) => record.id === "auth-runtime")?.value, { version: 1, entries: [] });
});

for (const value of [{ version: 99, entries: [], opaque: "future-metadata" }, { version: 1, entries: [{ broken: true }] }, { definitions: [], entries: [], unknown: "do-not-drop" }]) test(`unsupported auth runtime remains opaque (${JSON.stringify(value)})`, async () => {
  const snapshot = legacy(); snapshot.local.push({ table: "workspace_local_state", id: "auth-runtime", value });
  const original = structuredClone(snapshot); const { backend, persistence } = setup(snapshot); const store = await persistence.load();
  assert.equal(persistence.getWorkspaceStatus(snapshot.id).protectedState.status, "corrupt");
  assert.equal(request(store.workspaces[0]).request.url, "https://example.test/saved");
  await persistence.save(store); await assert.rejects(persistence.upgradeWorkspace(store.workspaces[0]), /read.only|protected|unavailable/i);
  assert.deepEqual(backend.snapshot.workspaces[0], original);
});

async function savedPasswordFixture() {
  const { secure, backend, persistence } = setup(); const workspace = createWorkspace("Intent fixture", "intent-recovery"); const document = request(workspace);
  document.saved = true; document.request.url = "https://example.test/saved";
  document.request.auth.type = "basic"; document.request.auth.basic.password = "synthetic-password-A";
  document.savedRequest = cloneRequestDraft(document.request); await persistence.save(storeFor(workspace));
  const ref = document.savedRequest.auth.credentialStates?.password?.ref; assert.ok(ref);
  return { secure, backend, persistence, workspace, document, ref };
}
function editPassword(document: ReturnType<typeof request>, ref: string, value: string) {
  document.request.auth.basic.password = value;
  document.request.auth.credentialStates = { ...document.request.auth.credentialStates, password: { ref, status: "available", edit: { kind: "set", value } } };
}

test("retry restores encrypted local drafts after unlocking without writes or secret reads while locked", async () => {
  const { secure, backend, persistence, workspace, document, ref } = await savedPasswordFixture();
  document.request.url = "https://example.test/local-only"; editPassword(document, ref, "synthetic-draft-password");
  workspace.ui.sidebarWidth = 23; await persistence.save(storeFor(workspace));
  const locals = structuredClone(backend.snapshot.workspaces[0].local);
  backend.snapshot.protectedState = { status: "locked", code: "fixture-locked" };
  const original = structuredClone(backend.snapshot); let writes = 0; let reads = 0;
  const commit = backend.commit.bind(backend); const read = secure.read.bind(secure);
  backend.commit = async (...args) => { writes += 1; return commit(...args); };
  secure.read = async (...args) => { reads += 1; return read(...args); };
  const restarted = new WorkspacePersistence(backend, secure); const locked = await restarted.load();
  assert.equal(request(locked.workspaces[0]).request.url, "https://example.test/saved");
  await restarted.save(locked); await restarted.retryProtectedStorage();
  assert.equal(writes, 0); assert.equal(reads, 0); assert.deepEqual(backend.snapshot, original);
  backend.snapshot.protectedState = { status: "available" };
  const recovered = await restarted.retryProtectedStorage(); const restored = request(recovered.workspaces[0]);
  assert.equal(restarted.getWorkspaceStatus(workspace.id).protectedState.status, "available");
  assert.equal(restored.request.url, "https://example.test/local-only"); assert.equal(recovered.workspaces[0].ui.sidebarWidth, 23);
  assert.equal(isDocumentDirty(restored), true);
  assert.ok(locals.some((record) => record.table === "drafts"), "fixture includes a real opaque-to-locked-loader draft");
  assert.equal(await secure.get(ref), "synthetic-password-A");
});

test("failed owner commit retains edit intent; successful commit consumes both saved and clean working intentions", async () => {
  const { secure, backend, persistence, workspace, document, ref } = await savedPasswordFixture();
  editPassword(document, ref, "synthetic-password-B"); document.savedRequest = cloneRequestDraft(document.request);
  const before = structuredClone(backend.snapshot); const commit = backend.commit.bind(backend);
  backend.commit = async () => { throw new CommitRejectedError("Synthetic owner rejection"); };
  await assert.rejects(persistence.saveWorkspace(workspace), /Synthetic owner rejection/);
  assert.deepEqual(backend.snapshot, before); assert.equal(await secure.get(ref), "synthetic-password-A");
  assert.deepEqual(document.request.auth.credentialStates?.password?.edit, { kind: "set", value: "synthetic-password-B" });
  assert.deepEqual(document.savedRequest.auth.credentialStates?.password?.edit, { kind: "set", value: "synthetic-password-B" });
  backend.commit = commit; await persistence.saveWorkspace(workspace);
  assert.equal(await secure.get(ref), "synthetic-password-B");
  assert.deepEqual(document.request.auth.credentialStates?.password?.edit, { kind: "keep" });
  assert.deepEqual(document.savedRequest.auth.credentialStates?.password?.edit, { kind: "keep" });
  assert.equal(isDocumentDirty(document), false);
});

test("dirty autosave cannot replace saved credentials and later unrelated save cannot replay acknowledged values", async () => {
  const { secure, persistence, backend, workspace, document, ref } = await savedPasswordFixture();
  const original = await secure.read(ref); editPassword(document, ref, "synthetic-password-B");
  assert.equal(isDocumentDirty(document), true); await persistence.save(storeFor(workspace));
  assert.deepEqual(await secure.read(ref), original, "working copy has a distinct protected owner");
  assert.equal(isDocumentDirty(document), true); document.savedRequest = cloneRequestDraft(document.request);
  await persistence.saveWorkspace(workspace);
  const savedRef = document.savedRequest.auth.credentialStates?.password?.ref; assert.ok(savedRef);
  assert.equal(await secure.get(savedRef), "synthetic-password-B");
  assert.deepEqual(document.request.auth.credentialStates?.password?.edit, { kind: "keep" });
  await secure.set(savedRef, "synthetic-external-password-C"); const external = await secure.read(savedRef);
  workspace.ui.sidebarWidth = 22; document.name = "Unrelated rename";
  await persistence.save(storeFor(workspace));
  assert.deepEqual(await secure.read(savedRef), external, "a later save must not resurrect an old set intent");
  const reloaded = await new WorkspacePersistence(backend, secure).load();
  assert.equal(request(reloaded.workspaces[0]).request.auth.credentialStates?.password?.ref, savedRef);
  assert.equal(await secure.get(savedRef), "synthetic-external-password-C");
});

test("clean cached editor header refs cannot overwrite a newer saved vault value on restart", async () => {
  const { secure, backend, persistence, workspace, document } = await savedPasswordFixture();
  document.request.headers = [{ id: "protected-header", name: "X-Custom", value: "synthetic-header-A", enabled: true, secret: true }];
  document.savedRequest = cloneRequestDraft(document.request); await persistence.saveWorkspace(workspace);
  const savedRef = document.savedRequest.headers[0].secretState?.ref; assert.ok(savedRef);
  const editorRef = `purr/${workspace.id}/editor/${document.id}/headers/protected-header/value`;
  assert.notEqual(savedRef, editorRef); assert.equal(await secure.get(editorRef), "synthetic-header-A");
  const session = backend.snapshot.workspaces[0].local.find((record) => record.table === "document_session_state" && record.id === document.id);
  assert.ok(JSON.stringify(session?.value).includes(editorRef), "fixture retains the older independent editor credential");
  await secure.set(savedRef, "synthetic-header-B"); const newer = await secure.read(savedRef);
  const restarted = new WorkspacePersistence(backend, secure); const loaded = await restarted.load();
  const header = request(loaded.workspaces[0]).request.headers.find((row) => row.id === "protected-header"); assert.ok(header);
  assert.equal(header.secretState?.ref, savedRef); assert.equal(header.secretState?.edit?.kind, "keep");
  assert.deepEqual(await secure.read(savedRef), newer);
  loaded.workspaces[0].ui.sidebarWidth = 24; await restarted.save(loaded);
  assert.deepEqual(await secure.read(savedRef), newer);
});

test("duplicating saved auth and sensitive headers gives the copy independent credential ownership", async () => {
  const { secure, persistence, workspace, document, ref } = await savedPasswordFixture();
  document.request.headers = [{ id: "duplicate-header", name: "X-Custom", value: "synthetic-original-header", enabled: true, secret: true }];
  document.savedRequest = cloneRequestDraft(document.request); await persistence.saveWorkspace(workspace);
  const originalHeaderRef = document.savedRequest.headers[0].secretRef; assert.ok(originalHeaderRef);
  const duplicated = duplicateDocument(workspace, document.id);
  const copy = duplicated.documents.find((item) => isRequestDocument(item) && item.id !== document.id); assert.ok(copy && isRequestDocument(copy));
  assert.equal(copy.request.auth.secretRefs, undefined); assert.equal(copy.request.headers[0].secretRef, undefined);
  // Source availability remains a copy dependency until the new owner commits.
  assert.equal(copy.request.auth.credentialStates?.password?.ref, ref);
  copy.saved = true; copy.savedRequest = cloneRequestDraft(copy.request); await persistence.saveWorkspace(duplicated);
  const copiedAuthRef = copy.savedRequest.auth.credentialStates?.password?.ref; const copiedHeaderRef = copy.savedRequest.headers[0].secretRef;
  assert.ok(copiedAuthRef); assert.ok(copiedHeaderRef);
  assert.notEqual(copiedAuthRef, ref); assert.notEqual(copiedHeaderRef, originalHeaderRef);
  assert.equal(await secure.get(copiedAuthRef), "synthetic-password-A"); assert.equal(await secure.get(copiedHeaderRef), "synthetic-original-header");
  editPassword(copy, copiedAuthRef, "synthetic-copy-password");
  copy.request.headers[0].value = "synthetic-copy-header";
  copy.request.headers[0].secretState = { ref: copiedHeaderRef, status: "available", edit: { kind: "set", value: "synthetic-copy-header" } };
  copy.savedRequest = cloneRequestDraft(copy.request); await persistence.saveWorkspace(duplicated);
  assert.equal(await secure.get(ref), "synthetic-password-A"); assert.equal(await secure.get(originalHeaderRef), "synthetic-original-header");
  assert.equal(await secure.get(copiedAuthRef), "synthetic-copy-password"); assert.equal(await secure.get(copiedHeaderRef), "synthetic-copy-header");
});

test("post-await invalidation preserves newer set/delete intents and opaque provider or extension JSON", async () => {
  const ref = "purr/invalidation/variables/credential";
  const keep = { ref, status: "available", edit: { kind: "keep" } } as const;
  let latest = {
    auth: { basic: { password: "old-auth" }, credentialStates: { password: { ...keep } as SecretFieldState } },
    headers: [{ id: "new-set", value: "old-header", loaded: true, secretRef: ref, secretState: { ...keep } as SecretFieldState }],
    variable: { value: "old-variable", loaded: true, secretRef: ref, secretState: { ...keep } as SecretFieldState },
    extension: { kind: "extension", config: { value: "opaque-extension", secretRef: ref, secretState: keep } },
    integration: { kind: "integration", config: { value: "opaque-provider", secretRef: ref, secretState: keep } },
  };
  let finish!: () => void; const committed = new Promise<void>((resolve) => { finish = resolve; });
  const applyAfterCommit = async () => { await committed; return invalidateSecretBuffers(latest, ref); };
  const pending = applyAfterCommit();
  // React publishes fresh state while the owner commit awaits its acknowledgement.
  const concurrent = {
    ...latest,
    auth: { basic: { password: "" }, credentialStates: { password: { ...keep, edit: { kind: "delete" as const } } } },
    headers: [{ ...latest.headers[0], value: "new-user-input", secretState: { ...keep, edit: { kind: "set" as const, value: "new-user-input" } } }],
  };
  latest = concurrent;
  finish();
  const updated = await pending;
  assert.deepEqual(updated.auth, concurrent.auth); assert.deepEqual(updated.headers, concurrent.headers);
  assert.equal(updated.variable.value, ""); assert.equal(updated.variable.loaded, false); assert.equal(updated.variable.secretState.status, "unresolved");
  assert.deepEqual(updated.extension, concurrent.extension); assert.deepEqual(updated.integration, concurrent.integration);
  assert.equal(concurrent.variable.value, "old-variable", "invalidation does not mutate the input snapshot");
});

test("legacy definition overlay is versioned and excludes aggregate local state; a future overlay stays opaque", async () => {
  const { secure, backend, persistence } = setup(legacy()); const store = await persistence.load(); const workspace = store.workspaces[0];
  workspace.name = "Pending legacy name"; workspace.ui.sidebarWidth = 27;
  await persistence.save(store);
  const snapshot = backend.snapshot.workspaces[0];
  const overlay = snapshot.local.find((record) => record.table === "workspace_local_state" && record.id === "legacy-definition-draft"); assert.ok(overlay);
  const dto = overlay.value as { version: number; sourceRevisions: Record<string, string>; definitions: Record<string, unknown> };
  assert.equal(dto.version, 1); assert.equal(dto.definitions.name, "Pending legacy name");
  for (const key of ["workspace", "ui", "cookies", "dynamicVariableCache", "activeEnvironmentId", "history"]) assert.ok(!(key in dto.definitions), key);
  assert.deepEqual(dto.sourceRevisions, Object.fromEntries(Object.entries(snapshot.files).map(([path, file]) => [path, file.revision])));
  assert.ok(snapshot.local.some((record) => record.table === "workspace_local_state" && record.id === "state"), "UI remains in its owning record");
  const restored = await new WorkspacePersistence(backend, secure).load();
  assert.equal(restored.workspaces[0].name, "Pending legacy name"); assert.equal(restored.workspaces[0].ui.sidebarWidth, 27);
  const persistedOverlay = backend.snapshot.workspaces[0].local.find((record) => record.id === "legacy-definition-draft")!;
  persistedOverlay.value = { ...(persistedOverlay.value as object), version: 99, futureField: { opaque: "preserve-me" } };
  const original = structuredClone(backend.snapshot.workspaces[0]); const restarted = new WorkspacePersistence(backend, secure);
  const future = await restarted.load();
  assert.equal(restarted.getWorkspaceStatus(workspace.id).protectedState.status, "corrupt");
  assert.equal(future.workspaces[0].name, "Recovery fixture", "unknown overlay must not masquerade as a restored definition");
  await restarted.save(future); await assert.rejects(restarted.upgradeWorkspace(future.workspaces[0]), /read.only|unavailable|protected/i);
  assert.deepEqual(backend.snapshot.workspaces[0], original);
});

test("legacy pending definitions reject external sidecar, asset and file-list changes before reconciliation or restart writes", async () => {
  for (const mutation of ["openapi", "asset", "addition"] as const) {
    const snapshot = legacy();
    snapshot.files["schemas/api.yaml"] = { content: "purr: 1\nkind: api-schema\nid: original-api\nname: Original API\nformat: openapi-3\nsource: { type: text, location: fixture }\nschema: schemas/source.openapi\n", revision: "schema-v1" };
    snapshot.files["schemas/source.openapi"] = { content: "openapi: 3.0.3\ninfo: { title: Original, version: 1.0.0 }\npaths: {}\n", revision: "sidecar-v1" };
    snapshot.files["assets/original.bin"] = { content: "AAECAwQ=", revision: "asset-v1" };
    const { secure, backend, persistence } = setup(snapshot); const store = await persistence.load();
    store.workspaces[0].name = "Local pending name"; await persistence.save(store);
    const files = backend.snapshot.workspaces[0].files;
    if (mutation === "openapi") files["schemas/source.openapi"] = { content: `${files["schemas/source.openapi"].content}# external source edit\n`, revision: "sidecar-v2" };
    else if (mutation === "asset") files["assets/original.bin"] = { content: "BQYHCA==", revision: "asset-v2" };
    else files["assets/external.bin"] = { content: "CQoLDA==", revision: "external-addition" };
    const original = structuredClone(backend.snapshot.workspaces[0]); let commits = 0; const commit = backend.commit.bind(backend);
    backend.commit = async (...args) => { commits += 1; return commit(...args); };
    await assert.rejects(persistence.reconcileExternalChanges(store), /External project changes conflict with pending legacy definitions/, mutation);
    assert.deepEqual(persistence.getWorkspaceStatus(snapshot.id).protectedState, { status: "recovery-required", code: "legacy-definition-conflict" }, mutation);
    assert.deepEqual(backend.snapshot.workspaces[0], original, mutation);
    const restarted = new WorkspacePersistence(backend, secure); const loaded = await restarted.load();
    assert.deepEqual(restarted.getWorkspaceStatus(snapshot.id).protectedState, { status: "recovery-required", code: "legacy-definition-conflict" }, mutation);
    assert.equal(loaded.workspaces[0].name, "Recovery fixture");
    await restarted.save(loaded); await assert.rejects(restarted.upgradeWorkspace(loaded.workspaces[0]), /read.only|unavailable|protected/i);
    assert.equal(commits, 0, mutation); assert.deepEqual(backend.snapshot.workspaces[0], original, mutation);
  }
});

test("import into an existing v1 workspace requires explicit upgrade before staging credentials or invoking initialization", async () => {
  const snapshot = legacy(); const { secure, backend, persistence } = setup(snapshot); await persistence.load();
  const project = persistence.getProject(snapshot.id); assert.ok(project);
  const imported = { ...project, resources: [...project.resources, { kind: "environment" as const, id: "additional-environment", name: "Imported environment", variables: [] }] };
  const ref = `purr/${snapshot.id}/environments/additional-environment/token`;
  const original = structuredClone(backend.snapshot); let reads = 0; let initialized = false;
  const read = secure.read.bind(secure); secure.read = async (...args) => { reads += 1; return read(...args); };
  await assert.rejects(persistence.saveProject(imported, (workspace) => { initialized = true; return workspace; }, [{ ref, value: "synthetic-import-secret" }]), /Upgrade this workspace to format v2 before importing/);
  assert.equal(reads, 0, "import credentials must not even acquire a preparation baseline before format approval");
  assert.equal(initialized, false); assert.equal(await secure.get(ref), null);
  assert.deepEqual(backend.snapshot, original); assert.equal(persistence.getWorkspaceStatus(snapshot.id).sourceVersion, 1);
});
