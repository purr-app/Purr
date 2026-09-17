import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspacePersistence } from "../src/application/workspace-persistence";
import { projectWorkspace, restoreWorkspace } from "../src/application/project-projection";
import { persistImport } from "../src/application/import-project";
import { resolveEnvironmentSecrets } from "../src/application/environment-secrets";
import { validateProject } from "../src/domain/project";
import { createWorkspace, createSchemaDocument, cloneRequestDraft, isRequestDocument, type WorkspaceStore } from "../src/features/workspaces/model/workspace";
import { deserializeManifest, deserializeResource, serializeManifest, serializeResource } from "../src/storage/yaml";
import { MemorySecureStore } from "../src/storage/secrets";
import { MemoryPersistenceBackend } from "./helpers/memory-persistence";
import { executeHttp } from "../src/features/request-workbench/services/http-client";
import { isInlineHttpResponse } from "../src/domain/http";
import type { FileChange, LocalChange } from "../src/application/ports/persistence";

function savedWorkspace() {
  const workspace = createWorkspace("Backend", "backend"); const document = workspace.documents[0];
  assert.ok(isRequestDocument(document)); document.request.url = "https://example.com/users";
  document.saved = true; document.savedRequest = cloneRequestDraft(document.request);
  return { workspace, document };
}

test("JSON payload whitespace, repeated disabled rows and inactive body drafts survive the real YAML boundary", async () => {
  const { workspace, document } = savedWorkspace(); const secure = new MemorySecureStore();
  document.request.body.type = "json";
  document.request.body.json = ' {\r\n\t"duplicate": 1, "duplicate": 2\r\n}\n\n';
  document.request.body.xml = "<inactive>retained locally</inactive>";
  document.request.headers = [{ id: "ui-1", name: "X-Test", value: "one", enabled: false }, { id: "ui-2", name: "X-Test", value: "two", enabled: true }];
  document.savedRequest = cloneRequestDraft(document.request);
  const projected = await projectWorkspace(workspace, secure);
  const yaml = serializeResource(projected.project.resources[0]);
  assert.ok(!yaml.includes("ui-1")); assert.ok(!yaml.includes("retained locally"));
  const resource = deserializeResource(yaml);
  assert.ok(resource.kind === "http"); assert.equal(resource.body.type, "json");
  assert.deepEqual(resource.body, { type: "json", data: document.request.body.json });
  assert.deepEqual(resource.headers.map((row) => row.enabled), [false, true]);
  const restored = await restoreWorkspace({ ...projected.project, resources: [resource] }, projected.local, secure, {});
  assert.ok(isRequestDocument(restored.documents[0])); assert.equal(restored.documents[0].request.body.xml, document.request.body.xml);
});

test("every auth credential and runtime OAuth token uses SecureStore; explicit plain bearer remains supported", async () => {
  for (const type of ["bearer", "basic", "api-key", "oauth2"] as const) {
    const { workspace, document } = savedWorkspace(); const secure = new MemorySecureStore();
    const auth = document.request.auth; auth.type = type;
    auth.bearer.token = "secret-bearer";
    auth.basic.password = "secret-password"; auth.apiKey.value = "secret-api-key";
    auth.oauth2.clientSecret = "secret-client";
    auth.oauth2.token = { tokenType: "Bearer", accessToken: "secret-access", refreshToken: "secret-refresh", obtainedAt: 1 };
    document.savedRequest = cloneRequestDraft(document.request);
    const projected = await projectWorkspace(workspace, secure);
    const serialized = serializeResource(projected.project.resources[0]) + JSON.stringify(projected.local);
    for (const secret of ["secret-bearer", "secret-password", "secret-api-key", "secret-client", "secret-access", "secret-refresh"]) assert.ok(!serialized.includes(secret), `${type}: ${secret}`);
    const restored = await restoreWorkspace(projected.project, projected.local, secure, {});
    assert.ok(isRequestDocument(restored.documents[0]));
    assert.equal(restored.documents[0].request.auth.oauth2.token?.refreshToken, "secret-refresh");
    if (type === "bearer") {
      auth.credentialStorage = { bearer: "plain" }; document.savedRequest = cloneRequestDraft(document.request);
      assert.ok(serializeResource((await projectWorkspace(workspace, secure)).project.resources[0]).includes("secret-bearer"));
    }
  }
});

test("inactive environment secrets are resolved on demand and saving does not overwrite them with blanks", async () => {
  const { workspace } = savedWorkspace(); const secure = new MemorySecureStore();
  workspace.environments = [{ id: "staging", name: "Staging", variables: [{ id: "stable", name: "password", kind: "static", value: "retained-secret", loaded: true, sensitive: true, enabled: true }] }];
  const projected = await projectWorkspace(workspace, secure);
  const restored = await restoreWorkspace(projected.project, projected.local, secure, {});
  assert.deepEqual(restored.environments[0].variables[0], { id: "stable", name: "password", enabled: true, sensitive: true, kind: "static", secretRef: "purr/backend/environments/staging/stable", value: "", loaded: false });
  await projectWorkspace(restored, secure);
  const resolved = await resolveEnvironmentSecrets(restored.environments[0], secure);
  assert.equal(resolved.variables[0].kind === "static" ? resolved.variables[0].value : "", "retained-secret");
});

test("sensitive dynamic cache values use SecureStore instead of SQLite plaintext", async () => {
  const { workspace } = savedWorkspace(); const secure = new MemorySecureStore();
  workspace.variables = [{ id: "token", name: "access_token", enabled: true, sensitive: true, kind: "dynamic-request",
    documentId: workspace.documents[0].id, expression: "$.token", language: "jsonpath", refresh: "session", environment: { type: "current" } }];
  workspace.dynamicVariableCache["token:none"] = { status: "success", value: "runtime-token", resolvedAt: new Date(0).toISOString(), durationMs: 5,
    environmentId: null, fingerprint: JSON.stringify(workspace.variables[0]) };
  const projected = await projectWorkspace(workspace, secure);
  assert.doesNotMatch(JSON.stringify(projected.local), /runtime-token/);
  const restored = await restoreWorkspace(projected.project, projected.local, secure, {});
  assert.equal(restored.dynamicVariableCache["token:none"].value, "runtime-token");
});

test("schema cache invalidates on external source changes and custom SDL sidecar paths remain stable", async () => {
  const { workspace } = savedWorkspace(); const schema = createSchemaDocument();
  Object.assign(schema, { saved: true, source: "introspection", endpoint: "https://old.example/graphql", sdl: "type Query { user: String }", pinned: true });
  workspace.documents.push(schema); const secure = new MemorySecureStore();
  const projection = await projectWorkspace(workspace, secure);
  const resource = projection.project.resources.find((resource) => resource.id === schema.id)!; assert.ok(resource.kind === "schema");
  const backend = new MemoryPersistenceBackend(); const sdlPath = "schemas/backend/pinned.graphql";
  await backend.commit(workspace.id, [
    { path: "purr.yaml", content: serializeManifest(projection.project.workspace), expectedRevision: null },
    { path: "schemas/backend.yaml", content: serializeResource(resource, sdlPath), expectedRevision: null },
    { path: sdlPath, content: schema.sdl, expectedRevision: null },
  ], projection.local);
  const persistence = new WorkspacePersistence(backend, secure); const loaded = await persistence.load();
  assert.ok(backend.snapshot.workspaces[0].files[sdlPath]);
  assert.equal(Object.keys(backend.snapshot.workspaces[0].files).filter((path) => path.endsWith(".graphql")).length, 1);
  const changed = { ...resource, pinnedSdl: undefined, source: { type: "introspection" as const, endpoint: "https://new.example/graphql" } };
  const restored = await restoreWorkspace({ ...projection.project, resources: [changed] }, projection.local, secure, {});
  const fresh = restored.documents.find((document) => document.id === schema.id); assert.ok(fresh?.kind === "schema"); assert.equal(fresh.sdl, "");
  await persistence.save(loaded);
});

test("binary attachments persist exact bytes through resource files, not UI file metadata", async () => {
  const { workspace, document } = savedWorkspace(); const file = new File([new Uint8Array([0, 255, 13, 10, 42])], "sample.bin", { type: "application/octet-stream" });
  document.request.body.type = "binary"; document.request.body.binary = { file, name: file.name, size: file.size, mimeType: file.type };
  document.savedRequest = cloneRequestDraft(document.request); const secure = new MemorySecureStore();
  const projected = await projectWorkspace(workspace, secure);
  const restored = await restoreWorkspace(projected.project, [], secure, projected.assets);
  assert.ok(isRequestDocument(restored.documents[0]));
  assert.deepEqual(new Uint8Array(await restored.documents[0].request.body.binary!.file.arrayBuffer()), new Uint8Array(await file.arrayBuffer()));
  await assert.rejects(restoreWorkspace(projected.project, [], secure, {}), /attachment is missing/);
});

test("working-copy attachments are referenced from small editor records and restored from the encrypted attachment table", async () => {
  const { workspace, document } = savedWorkspace();
  const file = new File(
    [new Uint8Array([0, 255, 13, 10, 42])],
    "working-copy.bin",
    { type: "application/octet-stream", lastModified: 1234 },
  );
  document.request.body.type = "binary";
  document.request.body.binary = {
    file,
    name: file.name,
    size: file.size,
    mimeType: file.type,
  };
  const secure = new MemorySecureStore();
  const projected = await projectWorkspace(workspace, secure);
  const attachments = projected.local.filter((record) => record.table === "attachments");
  assert.equal(attachments.length, 1);
  const editorRecords = projected.local.filter((record) =>
    record.table === "drafts" || record.table === "document_session_state",
  );
  assert.ok(editorRecords.some((record) => JSON.stringify(record.value).includes("__purrFileRef")));
  assert.ok(editorRecords.every((record) => !JSON.stringify(record.value).includes("__purrFile\"")));
  assert.ok(editorRecords.every((record) => !JSON.stringify(record.value).includes("AP8NCio=")));

  const restored = await restoreWorkspace(projected.project, projected.local, secure, projected.assets);
  assert.ok(isRequestDocument(restored.documents[0]));
  const restoredFile = restored.documents[0].request.body.binary?.file;
  assert.ok(restoredFile);
  assert.equal(restoredFile.name, file.name);
  assert.deepEqual(
    new Uint8Array(await restoredFile.arrayBuffer()),
    new Uint8Array(await file.arrayBuffer()),
  );

  await assert.rejects(
    restoreWorkspace(
      projected.project,
      projected.local.filter((record) => record.table !== "attachments"),
      secure,
      projected.assets,
    ),
    /attachment is missing or damaged/,
  );
});

test("native attachment metadata opens without loading bytes and remains lazy across autosave", async () => {
  const { workspace, document } = savedWorkspace();
  const expected = new Uint8Array([7, 8, 9, 10]);
  const file = new File([expected], "lazy.bin", {
    type: "application/octet-stream",
    lastModified: 1234,
  });
  document.request.body.type = "binary";
  document.request.body.binary = {
    file,
    name: file.name,
    size: file.size,
    mimeType: file.type,
  };
  const secure = new MemorySecureStore();
  const projected = await projectWorkspace(workspace, secure);
  const attachment = projected.local.find((record) => record.table === "attachments");
  assert.ok(attachment);
  attachment.value = {
    version: 1,
    native: true,
    name: file.name,
    type: file.type,
    lastModified: file.lastModified,
    size: file.size,
  };
  let loads = 0;
  const restored = await restoreWorkspace(
    projected.project,
    projected.local,
    secure,
    projected.assets,
    async () => {
      loads += 1;
      return expected;
    },
  );
  assert.equal(loads, 0);
  assert.ok(isRequestDocument(restored.documents[0]));
  const restoredFile = restored.documents[0].request.body.binary?.file;
  assert.ok(restoredFile);
  assert.equal(restoredFile.size, expected.length);
  assert.equal(cloneRequestDraft(restored.documents[0].request).body.binary?.file, restoredFile);
  await projectWorkspace(restored, secure);
  assert.equal(loads, 0);
  assert.deepEqual(new Uint8Array(await restoredFile.arrayBuffer()), expected);
  assert.equal(loads, 1);
});

test("editing another body mode does not rewrite an unchanged working-copy attachment", async () => {
  const { workspace, document } = savedWorkspace();
  const file = new File([new Uint8Array([1, 2, 3, 4])], "retained.bin", {
    type: "application/octet-stream",
  });
  document.request.body.type = "binary";
  document.request.body.binary = {
    file,
    name: file.name,
    size: file.size,
    mimeType: file.type,
  };
  const backend = new MemoryPersistenceBackend();
  const localBatches: LocalChange[][] = [];
  const commit = backend.commit.bind(backend);
  backend.commit = async (id: string, files: FileChange[], local: LocalChange[]) => {
    localBatches.push(local);
    return commit(id, files, local);
  };
  const persistence = new WorkspacePersistence(backend, new MemorySecureStore());
  const store: WorkspaceStore = {
    activeWorkspaceId: workspace.id,
    workspaces: [workspace],
  };
  await persistence.save(store);
  assert.ok(localBatches.flat().some((change) => change.table === "attachments"));

  localBatches.length = 0;
  document.request.body.type = "form-data";
  document.request.body.formData[0] = {
    ...document.request.body.formData[0],
    enabled: true,
    key: "name",
    value: "test",
  };
  await persistence.save(store);
  assert.ok(localBatches.length > 0);
  assert.ok(localBatches.flat().every((change) => change.table !== "attachments"));
});

test("file watching reconciles a moved YAML resource without renaming it back or orphaning credential references", async () => {
  const { workspace } = savedWorkspace(); const secure = new MemorySecureStore(); const backend = new MemoryPersistenceBackend();
  const persistence = new WorkspacePersistence(backend, secure); let current: WorkspaceStore = { activeWorkspaceId: workspace.id, workspaces: [workspace] };
  await persistence.save(current);
  const before = backend.snapshot.workspaces[0]; const path = Object.keys(before.files).find((path) => path.startsWith("documents/"))!;
  const moved = "documents/users/get-user.yaml";
  await backend.moveResource(workspace.id, path, moved, before.files[path].revision);
  const reloaded = new Promise<void>((resolve, reject) => {
    void persistence.watchChanges((workspace) => { current = { ...current, workspaces: [workspace] }; resolve(); }, reject, () => current)
      .then(() => backend.listener?.(workspace.id, ["*"]));
  });
  await reloaded; await persistence.save(current);
  assert.ok(backend.snapshot.workspaces[0].files[moved]); assert.ok(!backend.snapshot.workspaces[0].files[path]);
});

test("explicit save retry reconciles an external move before committing local edits", async () => {
  const { workspace, document } = savedWorkspace(); const secure = new MemorySecureStore(); const backend = new MemoryPersistenceBackend();
  const persistence = new WorkspacePersistence(backend, secure); let current: WorkspaceStore = { activeWorkspaceId: workspace.id, workspaces: [workspace] };
  await persistence.save(current);
  const before = backend.snapshot.workspaces[0]; const path = Object.keys(before.files).find((candidate) => candidate.startsWith("documents/"))!;
  const moved = "documents/externally-renamed.yaml";
  await backend.moveResource(workspace.id, path, moved, before.files[path].revision);
  document.request.url = "https://local.example/retained-on-retry";
  document.savedRequest = cloneRequestDraft(document.request);
  await assert.rejects(persistence.save(current), /conflict/);

  current = await persistence.reconcileExternalChanges(current);
  const reconciled = current.workspaces[0].documents.find((candidate) => candidate.id === document.id);
  assert.ok(reconciled && isRequestDocument(reconciled));
  assert.equal(reconciled.request.url, "https://local.example/retained-on-retry");
  await persistence.save(current);

  const files = backend.snapshot.workspaces[0].files;
  assert.ok(!files[path]); assert.ok(files[moved]);
  const saved = deserializeResource(files[moved].content); assert.ok(saved.kind === "http");
  assert.equal(saved.url, "https://local.example/retained-on-retry");
});

test("legacy request directories are migrated to the shared documents directory without changing IDs", async () => {
  const { workspace, document } = savedWorkspace(); const secure = new MemorySecureStore(); const backend = new MemoryPersistenceBackend();
  const first = new WorkspacePersistence(backend, secure);
  await first.save({ activeWorkspaceId: workspace.id, workspaces: [workspace] });
  const before = backend.snapshot.workspaces[0];
  const original = Object.keys(before.files).find((path) => path.startsWith("documents/"))!;
  const legacy = `requests/${original.slice("documents/".length)}`;
  await backend.moveResource(workspace.id, original, legacy, before.files[original].revision);
  const restored = await new WorkspacePersistence(backend, secure).load();
  const files = backend.snapshot.workspaces[0].files;
  assert.ok(Object.keys(files).some((path) => path.startsWith("documents/")));
  assert.ok(!Object.keys(files).some((path) => path.startsWith("requests/")));
  const persisted = Object.values(files).find((file) => file.content.includes(document.id));
  assert.ok(persisted);
  assert.equal(restored.workspaces[0].documents[0].id, document.id);
});

test("documents directories restore sidebar folders and persist their marker metadata", async () => {
  const { workspace, document } = savedWorkspace(); const secure = new MemorySecureStore(); const backend = new MemoryPersistenceBackend();
  const persistence = new WorkspacePersistence(backend, secure);
  await persistence.save({ activeWorkspaceId: workspace.id, workspaces: [workspace] });
  const before = backend.snapshot.workspaces[0];
  const source = Object.keys(before.files).find((path) => path.startsWith("documents/"))!;
  const sourceParts = source.split("/"); const moved = `documents/external/${sourceParts[sourceParts.length - 1]}`;
  await backend.moveResource(workspace.id, source, moved, before.files[source].revision);
  const loaded = await new WorkspacePersistence(backend, secure).load();
  const restored = loaded.workspaces[0]; const folder = restored.extraResources?.find((resource) => resource.kind === "folder" && resource.name === "external");
  assert.ok(folder?.kind === "folder");
  assert.equal(restored.documents.find((item) => item.id === document.id)?.folderId, folder.id);
  assert.ok(backend.snapshot.workspaces[0].files["documents/external/.purr-folder.yaml"]);
  assert.ok(backend.snapshot.workspaces[0].files[moved]);
});

test("nested folders and documents round-trip through canonical filesystem paths with stable IDs", async () => {
  const { workspace, document } = savedWorkspace();
  const secure = new MemorySecureStore();
  const backend = new MemoryPersistenceBackend();
  workspace.extraResources = [
    { id: "folder-api", kind: "folder", name: "API" },
    { id: "folder-users", kind: "folder", name: "Users", folderId: "folder-api" },
  ];
  document.folderId = "folder-users";
  document.name = "Get user";
  document.savedRequest = cloneRequestDraft(document.request);

  let persistence = new WorkspacePersistence(backend, secure);
  await persistence.save({ activeWorkspaceId: workspace.id, workspaces: [workspace] });
  let files = backend.snapshot.workspaces[0].files;
  const requestName = Object.keys(files).find((path) => path.startsWith("documents/API/Users/") && path.endsWith(".yaml") && !path.endsWith(".purr-folder.yaml"))?.split("/").pop();
  assert.ok(requestName);
  assert.ok(files["documents/API/.purr-folder.yaml"]);
  assert.ok(files["documents/API/Users/.purr-folder.yaml"]);
  assert.ok(files[`documents/API/Users/${requestName}`]);
  assert.equal(deserializeResource(files["documents/API/.purr-folder.yaml"].content).id, "folder-api");
  assert.equal(deserializeResource(files["documents/API/Users/.purr-folder.yaml"].content).id, "folder-users");

  let loaded = await new WorkspacePersistence(backend, secure).load();
  let restored = loaded.workspaces[0];
  const restoredUsers = restored.extraResources?.find((resource) => resource.id === "folder-users");
  assert.ok(restoredUsers?.kind === "folder");
  assert.equal(restoredUsers.folderId, "folder-api");
  assert.equal(restored.documents.find((item) => item.id === document.id)?.folderId, "folder-users");

  restored.extraResources = restored.extraResources?.map((resource) => resource.id === "folder-users" && resource.kind === "folder"
    ? { ...resource, name: "Accounts", folderId: undefined }
    : resource);
  const movedDocument = restored.documents.find((item) => item.id === document.id)!;
  movedDocument.folderId = "folder-users";
  movedDocument.name = "Renamed request";
  if (isRequestDocument(movedDocument)) movedDocument.savedRequest = cloneRequestDraft(movedDocument.request);
  persistence = new WorkspacePersistence(backend, secure);
  await persistence.load();
  await persistence.save(loaded);

  files = backend.snapshot.workspaces[0].files;
  assert.ok(files["documents/API/.purr-folder.yaml"]);
  assert.ok(files["documents/Accounts/.purr-folder.yaml"]);
  assert.ok(files[`documents/Accounts/${requestName}`]);
  assert.ok(!files["documents/API/Users/.purr-folder.yaml"]);
  assert.ok(!files[`documents/API/Users/${requestName}`]);
  assert.equal(deserializeResource(files["documents/Accounts/.purr-folder.yaml"].content).id, "folder-users");
  const movedDefinition = deserializeResource(files[`documents/Accounts/${requestName}`].content);
  assert.equal(movedDefinition.id, document.id);
  assert.equal(movedDefinition.name, "Renamed request");

  loaded = await new WorkspacePersistence(backend, secure).load();
  restored = loaded.workspaces[0];
  const rootFolder = restored.extraResources?.find((resource) => resource.id === "folder-users");
  assert.ok(rootFolder?.kind === "folder");
  assert.equal(rootFolder.folderId, undefined);
  assert.equal(rootFolder.name, "Accounts");
  assert.equal(restored.documents.find((item) => item.id === document.id)?.folderId, "folder-users");
});

test("external document-tree renames, moves and deletes reload from canonical hierarchy", async () => {
  const { workspace, document } = savedWorkspace();
  const secure = new MemorySecureStore();
  const backend = new MemoryPersistenceBackend();
  workspace.extraResources = [
    { id: "folder-root", kind: "folder", name: "API" },
    { id: "folder-child", kind: "folder", name: "Users", folderId: "folder-root" },
  ];
  document.folderId = "folder-child";
  document.savedRequest = cloneRequestDraft(document.request);
  const persistence = new WorkspacePersistence(backend, secure);
  let current: WorkspaceStore = { activeWorkspaceId: workspace.id, workspaces: [workspace] };
  await persistence.save(current);

  const nextReload = () => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Watcher did not reload the external document-tree change.")), 1_000);
    void persistence.watchChanges((reloaded) => {
      clearTimeout(timeout);
      current = { ...current, workspaces: [reloaded] };
      resolve();
    }, (message) => {
      clearTimeout(timeout);
      reject(new Error(message));
    }, () => current).then(() => backend.listener?.(workspace.id, ["*"]));
  });
  const move = async (from: string, to: string) => {
    const file = backend.snapshot.workspaces[0].files[from];
    assert.ok(file, from);
    await backend.moveResource(workspace.id, from, to, file.revision);
  };

  let requestPath = Object.keys(backend.snapshot.workspaces[0].files).find((path) => path.startsWith("documents/API/Users/") && path.endsWith(".yaml") && !path.endsWith(".purr-folder.yaml"))!;
  await move("documents/API/.purr-folder.yaml", "documents/Services/.purr-folder.yaml");
  await move("documents/API/Users/.purr-folder.yaml", "documents/Services/Users/.purr-folder.yaml");
  await move(requestPath, requestPath.replace("documents/API/Users/", "documents/Services/Users/"));
  await nextReload();

  let restored = current.workspaces[0];
  const root = restored.extraResources?.find((resource) => resource.id === "folder-root");
  const child = restored.extraResources?.find((resource) => resource.id === "folder-child");
  assert.ok(root?.kind === "folder" && child?.kind === "folder");
  assert.equal(root.name, "Services");
  assert.equal(child.folderId, root.id);
  assert.equal(restored.documents.find((item) => item.id === document.id)?.folderId, child.id);

  const dirtyDocument = restored.documents.find((item) => item.id === document.id);
  assert.ok(dirtyDocument && isRequestDocument(dirtyDocument));
  dirtyDocument.request.url = "https://local.example/unsaved-after-external-move";
  requestPath = Object.keys(backend.snapshot.workspaces[0].files).find((path) => path.startsWith("documents/Services/Users/") && path.endsWith(".yaml") && !path.endsWith(".purr-folder.yaml"))!;
  const renamedRequestPath = "documents/People/external-name.yaml";
  await move("documents/Services/Users/.purr-folder.yaml", "documents/People/.purr-folder.yaml");
  await move(requestPath, renamedRequestPath);
  await nextReload();

  restored = current.workspaces[0];
  const movedChild = restored.extraResources?.find((resource) => resource.id === "folder-child");
  assert.ok(movedChild?.kind === "folder");
  assert.equal(movedChild.name, "People");
  assert.equal(movedChild.folderId, undefined);
  const externallyMovedDocument = restored.documents.find((item) => item.id === document.id);
  assert.ok(externallyMovedDocument && isRequestDocument(externallyMovedDocument));
  assert.equal(externallyMovedDocument.folderId, movedChild.id);
  assert.equal(externallyMovedDocument.request.url, "https://local.example/unsaved-after-external-move");
  externallyMovedDocument.savedRequest = cloneRequestDraft(externallyMovedDocument.request);
  await persistence.save(current);
  assert.ok(backend.snapshot.workspaces[0].files[renamedRequestPath]);

  const files = backend.snapshot.workspaces[0].files;
  await backend.commit(workspace.id, [
    { path: renamedRequestPath, content: null, expectedRevision: files[renamedRequestPath].revision },
    { path: "documents/People/.purr-folder.yaml", content: null, expectedRevision: files["documents/People/.purr-folder.yaml"].revision },
  ], []);
  await nextReload();

  restored = current.workspaces[0];
  assert.ok(!restored.documents.some((item) => item.id === document.id));
  assert.ok(!restored.extraResources?.some((resource) => resource.id === "folder-child"));
  assert.ok(restored.extraResources?.some((resource) => resource.id === "folder-root"));
});

test("external valid edits conflict with dirty working copies instead of discarding them", async () => {
  const { workspace, document } = savedWorkspace(); const secure = new MemorySecureStore(); const backend = new MemoryPersistenceBackend();
  const persistence = new WorkspacePersistence(backend, secure); const current = { activeWorkspaceId: workspace.id, workspaces: [workspace] };
  await persistence.save(current); document.request.url = "https://local.example/unsaved";
  const before = backend.snapshot.workspaces[0]; const path = Object.keys(before.files).find((path) => path.startsWith("documents/"))!;
  const resource = deserializeResource(before.files[path].content); assert.ok(resource.kind === "http"); resource.url = "https://external.example/changed";
  await backend.saveResource(workspace.id, { path, content: serializeResource(resource), expectedRevision: before.files[path].revision });
  const error = await new Promise<string>((resolve, reject) => {
    void persistence.watchChanges(() => reject(new Error("Conflicting edits must not reload")), resolve, () => current).then(() => backend.listener?.(workspace.id, [path]));
  });
  assert.match(error, /could not be reconciled/); assert.equal(document.request.url, "https://local.example/unsaved");
  assert.equal(deserializeResource(backend.snapshot.workspaces[0].files[path].content).id, document.id);
});

test("migration checkpoints resume after interruption and reject changed legacy originals", async () => {
  const { workspace } = savedWorkspace(); const backend = new MemoryPersistenceBackend(); const secure = new MemorySecureStore();
  const legacy = { activeWorkspaceId: workspace.id, workspaces: [workspace] }; backend.snapshot.legacy = structuredClone(legacy);
  backend.finishMigration = async () => { throw new Error("Simulated interruption before retirement"); };
  await assert.rejects(new WorkspacePersistence(backend, secure).load(), /interruption/);
  backend.finishMigration = async () => { delete backend.snapshot.legacy; };
  await new WorkspacePersistence(backend, secure).load(); assert.equal(backend.snapshot.legacy, undefined);
  legacy.workspaces[0].name = "Changed in old app"; backend.snapshot.legacy = legacy;
  await assert.rejects(new WorkspacePersistence(backend, secure).load(), /Legacy data changed/);
  assert.ok(backend.snapshot.legacy);
});

test("strict manifests upgrade omitted defaults but reject unknown keys; external formats never become the core model", () => {
  const manifest = deserializeManifest("purr: 1\nworkspace:\n  id: project\n  name: Project\n");
  assert.deepEqual(manifest.headers, []); assert.deepEqual(manifest.auth, []);
  assert.deepEqual(deserializeManifest(serializeManifest(manifest)), manifest);
  assert.throws(() => deserializeManifest("purr: 1\nworkspace:\n  id: project\n  name: Project\n  activeDocument: user\n"), /Invalid/);
  assert.throws(() => validateProject({ workspace: manifest, resources: [{ kind: "environment", id: "env", name: "env", variables: [{ id: "bad", name: "bad", enabled: true, sensitive: true, kind: "static", secretRef: "purr/other/credential" }] }] }), /belong to this workspace/);
});

test("an empty environment survives compact YAML serialization", () => {
  const environment = deserializeResource("purr: 1\nkind: environment\nid: local\nname: Local\n");
  assert.equal(environment.kind, "environment");
  if (environment.kind !== "environment") return;
  assert.deepEqual(environment.variables, []);
  assert.deepEqual(deserializeResource(serializeResource(environment)), environment);
});

test("known development-only variable and auth shapes are rewritten to canonical YAML during startup", async () => {
  const backend = new MemoryPersistenceBackend(); const secure = new MemorySecureStore();
  const manifest = `purr: 1
workspace:
  id: project
  name: Project
  variables:
    - id: runtime
      name: runtime_url
      source:
        type: dynamic-request
        documentId: source
        expression: $.url
        language: jsonpath
        execution: once
        environment:
          type: current
defaults:
  auth:
    - id: auth
      name: Shared auth
      scope: all
      config:
        type: bearer
        token:
          kind: secret
          ref: purr/project/auth/auth/bearer
        prefix: Bearer
        response:
          documentId: source
          expression: $.token
`;
  const request = `purr: 1
kind: http
id: source
name: Source
url: https://example.test/source
method: GET
`;
  const environment = `purr: 1
kind: environment
id: local
name: Local
variables:
  - id: base-url
    name: base_url
    source:
      type: value
      value: https://example.test
`;
  backend.snapshot = { activeWorkspaceId: "project", workspaces: [{ id: "project", local: [], files: {
    "purr.yaml": { content: manifest, revision: "manifest" },
    "requests/source.yaml": { content: request, revision: "request" },
    "environments/local.yaml": { content: environment, revision: "environment" },
  } }] };

  const loaded = await new WorkspacePersistence(backend, secure).load();
  assert.equal(loaded.workspaces[0].variables[0].kind, "dynamic-request");
  const savedManifest = backend.snapshot.workspaces[0].files["purr.yaml"].content;
  const savedEnvironment = backend.snapshot.workspaces[0].files["environments/local.yaml"].content;
  assert.doesNotMatch(savedManifest, /\n\s+response:/); assert.doesNotMatch(savedManifest, /\n\s+source:/);
  assert.match(savedManifest, /kind: dynamic-request/); assert.match(savedManifest, /refresh: session/);
  assert.doesNotMatch(savedEnvironment, /\n\s+source:/); assert.match(savedEnvironment, /kind: static/);
  assert.ok(backend.writes.some((write) => write.path === "purr.yaml"));
  assert.ok(backend.writes.some((write) => write.path === "environments/local.yaml"));
});

test("invalid importer credential scope is rejected before writing any secret or resource", async () => {
  const backend = new MemoryPersistenceBackend(); const secure = new MemorySecureStore(); const persistence = new WorkspacePersistence(backend, secure);
  await assert.rejects(persistImport({ workspace: { id: "project", name: "Project", headers: [], auth: [] }, resources: [], diagnostics: [], secrets: [{ ref: "purr/other/token", value: "secret" }] }, persistence), /scoped/);
  assert.equal(await secure.exists("purr/other/token"), false); assert.equal(backend.writes.length, 0);
});

test("response bodies and sent request credentials belong only to local executions, never Git files", async () => {
  const { workspace, document } = savedWorkspace();
  document.lastResponse = await executeHttp({ method: "GET", url: document.request.url, headers: [["Authorization", "Bearer execution-secret"]], bodyBase64: null }, {
    transport: async () => ({ status: 200, statusText: "OK", durationMs: 1, headers: [["set-cookie", "session=response-cookie"]], bodyBase64: btoa("private-response") }),
  });
  const secure = new MemorySecureStore(); const backend = new MemoryPersistenceBackend(); const persistence = new WorkspacePersistence(backend, secure);
  await persistence.save({ activeWorkspaceId: workspace.id, workspaces: [workspace] });
  const files = JSON.stringify(backend.snapshot.workspaces[0].files);
  for (const value of ["execution-secret", "response-cookie", "private-response", "lastResponse", "timeline"]) assert.ok(!files.includes(value));
  const restored = await new WorkspacePersistence(backend, secure).load(); assert.ok(isRequestDocument(restored.workspaces[0].documents[0]));
  const lastResponse = restored.workspaces[0].documents[0].lastResponse;
  assert.ok(lastResponse && isInlineHttpResponse(lastResponse));
  assert.equal(lastResponse.text, "private-response");
});

test("importing into an existing workspace is additive and rejects conflicting IDs", async () => {
  const { workspace, document } = savedWorkspace(); const backend = new MemoryPersistenceBackend(); const secure = new MemorySecureStore(); const persistence = new WorkspacePersistence(backend, secure);
  await persistence.save({ activeWorkspaceId: workspace.id, workspaces: [workspace] });
  const projected = await projectWorkspace(workspace, secure);
  const imported = { ...projected.project.resources[0], id: "another-request" };
  const result = { workspace: { ...projected.project.workspace, name: "Must not replace" }, resources: [imported], diagnostics: [], secrets: [] };
  const restored = await persistImport(result, persistence);
  assert.equal(restored.name, workspace.name); assert.ok(restored.documents.some((item) => item.id === document.id));
  assert.ok(restored.documents.some((item) => item.id === imported.id));
  await assert.rejects(persistImport(result, persistence), /conflict/);
});

test("clean editor snapshots cannot shadow a credential updated through SecureStore", async () => {
  const { workspace, document } = savedWorkspace(); const secure = new MemorySecureStore(); const backend = new MemoryPersistenceBackend();
  document.request.auth.type = "bearer"; document.request.auth.bearer.token = "old-value";
  document.savedRequest = cloneRequestDraft(document.request);
  await new WorkspacePersistence(backend, secure).save({ activeWorkspaceId: workspace.id, workspaces: [workspace] });
  const path = Object.keys(backend.snapshot.workspaces[0].files).find((path) => path.startsWith("documents/"))!;
  const definition = deserializeResource(backend.snapshot.workspaces[0].files[path].content);
  assert.ok(definition.kind === "http" && definition.auth.type === "bearer" && definition.auth.token.kind === "secret");
  await secure.set(definition.auth.token.ref, "updated-value");
  const restored = await new WorkspacePersistence(backend, secure).load(); const request = restored.workspaces[0].documents[0];
  assert.ok(isRequestDocument(request)); assert.equal(request.request.auth.bearer.token, "updated-value");
  assert.equal(request.request.auth.secretRefs?.bearer, definition.auth.token.ref);
});
