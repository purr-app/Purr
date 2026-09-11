import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { WorkspacePersistence } from "../src/application/workspace-persistence";
import { projectWorkspace, restoreWorkspace } from "../src/application/project-projection";
import { createWorkspace, createGraphqlDocument, createSchemaDocument, cloneRequestDraft, isRequestDocument } from "../src/features/workspaces/model/workspace";
import { deserializeManifest, deserializeResource, serializeManifest, serializeResource } from "../src/storage/yaml";
import { MemorySecureStore } from "../src/storage/secrets";
import { MemoryPersistenceBackend } from "./helpers/memory-persistence";
import { persistImport } from "../src/application/import-project";

test("versioned YAML fixtures round-trip with disabled params and stable references", async () => {
  for (const fixture of ["get-user", "get-customer"]) {
    const resource = deserializeResource(await readFile(new URL(`./fixtures/projects/${fixture}.yaml`, import.meta.url), "utf8"));
    const yaml = serializeResource(resource); assert.deepEqual(deserializeResource(yaml), resource); assert.equal(serializeResource(deserializeResource(yaml)), yaml);
    assert.ok(!yaml.includes("param-1"));
  }
  assert.throws(() => deserializeManifest("purr: 99\nworkspace: {}"), /unsupported/);
  assert.throws(() => deserializeManifest("purr: 1\npurr: 1\nworkspace: {}"), /Invalid/);
  assert.throws(() => deserializeManifest("purr: 1\nworkspace: &a [*a]"), /Invalid/);
});

test("project projection excludes drafts, execution data, cookies and all credential values", async () => {
  const workspace = createWorkspace(); const secure = new MemorySecureStore();
  const request = workspace.documents[0]; assert.ok(isRequestDocument(request));
  request.request.auth.type = "basic"; request.request.auth.basic.password = "basic-password-secret";
  request.request.auth.bearer.token = "inactive-bearer-secret";
  workspace.environments.push({ id: "env", name: "Local", variables: [
    { id: "secret-id", name: "token", value: "environment-secret", enabled: true, secret: true },
    { id: "plain-id", name: "base_url", value: "https://example.com", enabled: false, secret: false },
  ] });
  workspace.activeEnvironmentId = "env";
  let projected = await projectWorkspace(workspace, secure);
  assert.equal(projected.project.resources.filter((resource) => resource.kind === "http").length, 0);
  assert.ok(projected.local.some((record) => record.table === "drafts"));
  request.saved = true; request.savedRequest = cloneRequestDraft(request.request);
  request.request.body.type = "json"; request.request.body.json = '{\n  "name": "Ihor",\n  "active": true\n}\n'; request.savedRequest = cloneRequestDraft(request.request);
  request.request.environmentId = "env"; request.savedRequest.environmentId = "env";
  request.sentAt = "2026-01-01";
  workspace.cookies.push({ id: "cookie-id", name: "session", value: "cookie-secret", domain: "example.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", hostOnly: true, enabled: true });
  projected = await projectWorkspace(workspace, secure);
  const yaml = [serializeManifest(projected.project.workspace), ...projected.project.resources.map((resource) => serializeResource(resource))].join("\n");
  for (const text of ["basic-password-secret", "inactive-bearer-secret", "environment-secret", "cookie-secret", "sentAt", "lastResponse", "openDocumentIds", "splitRatios"]) assert.ok(!yaml.includes(text), text);
  const local = JSON.stringify(projected.local);
  for (const text of ["basic-password-secret", "inactive-bearer-secret", "environment-secret"]) assert.ok(!local.includes(text), text);
  const restored = await restoreWorkspace(projected.project, projected.local, secure, {});
  const document = restored.documents[0]; assert.ok(isRequestDocument(document));
  assert.equal(document.request.body.json, request.request.body.json);
  assert.equal(document.request.environmentId, "env");
  assert.equal(document.request.auth.basic.password, "basic-password-secret");
  assert.equal(restored.environments[0].variables[0].value, "environment-secret");
  assert.equal(restored.environments[0].variables[1].enabled, false);
});

test("schema sources are shareable, caches local and explicit pinned SDL is separate", async () => {
  const workspace = createWorkspace(); const schema = createSchemaDocument();
  schema.saved = true; schema.source = "introspection"; schema.endpoint = "https://example.com/graphql"; schema.sdl = "type Query { hello: String }";
  const query = createGraphqlDocument(); query.saved = true; query.request.graphql.schemaId = schema.id;
  query.request.graphql.query = "query Hello {\n  hello\n}"; query.savedRequest = cloneRequestDraft(query.request);
  workspace.documents = [schema, query];
  const secure = new MemorySecureStore(); let projected = await projectWorkspace(workspace, secure);
  const resource = projected.project.resources.find((item) => item.id === schema.id)!;
  assert.ok(!serializeResource(resource).includes("type Query"));
  assert.ok(projected.local.some((record) => record.table === "schema_cache"));
  schema.pinned = true; projected = await projectWorkspace(workspace, secure);
  const pinned = projected.project.resources.find((item) => item.id === schema.id)!;
  assert.ok(serializeResource(pinned, `schemas/${schema.id}.graphql`).includes("pinned:"));
  assert.deepEqual(deserializeResource(serializeResource(pinned, `schemas/${schema.id}.graphql`), () => schema.sdl), pinned);
});

test("legacy workspace migrates once; UI saves do not rewrite project files, rename keeps paths and secret references", async () => {
  const backend = new MemoryPersistenceBackend(); const secure = new MemorySecureStore(); const workspace = createWorkspace("Legacy", "legacy");
  const request = workspace.documents[0]; assert.ok(isRequestDocument(request)); request.saved = true; request.savedRequest = cloneRequestDraft(request.request);
  workspace.environments.push({ id: "env", name: "Staging", variables: [{ id: "stable", name: "password", value: "do-not-export", secret: true, enabled: true }] });
  workspace.activeEnvironmentId = "env";
  backend.snapshot.legacy = { activeWorkspaceId: workspace.id, workspaces: [workspace] };
  const persistence = new WorkspacePersistence(backend, secure); const loaded = await persistence.load();
  assert.equal(loaded.workspaces[0].name, "Legacy"); assert.equal(backend.snapshot.legacy, undefined);
  const paths = Object.keys(backend.snapshot.workspaces[0].files); const writes = backend.writes.length;
  loaded.workspaces[0].ui.sidebarOpen = false; await persistence.save(loaded); assert.equal(backend.writes.length, writes);
  loaded.workspaces[0].environments[0].variables[0].name = "renamed_password";
  loaded.workspaces[0].documents[0].name = "Renamed request"; await persistence.save(loaded);
  assert.deepEqual(Object.keys(backend.snapshot.workspaces[0].files), paths);
  const reloaded = await new WorkspacePersistence(backend, secure).load();
  assert.equal(reloaded.workspaces[0].environments[0].variables[0].value, "do-not-export");
  assert.equal(reloaded.workspaces[0].environments[0].variables[0].name, "renamed_password");
});

test("external malformed YAML cannot destroy existing resources", async () => {
  const backend = new MemoryPersistenceBackend(); const secure = new MemorySecureStore(); const persistence = new WorkspacePersistence(backend, secure);
  const loaded = await persistence.load(); const snapshot = backend.snapshot.workspaces[0];
  snapshot.files["purr.yaml"] = { content: "purr: [ broken-secret", revision: "external" };
  await assert.rejects(new WorkspacePersistence(backend, secure).load(), /Invalid/);
  loaded.workspaces[0].name = "Changed";
  await assert.rejects(persistence.save(loaded), /conflict/);
  assert.equal(snapshot.files["purr.yaml"].content, "purr: [ broken-secret");
});

test("normalized imports use the same persistence path", async () => {
  const backend = new MemoryPersistenceBackend(); const secure = new MemorySecureStore(); const persistence = new WorkspacePersistence(backend, secure);
  const resource = deserializeResource(await readFile(new URL("./fixtures/projects/get-user.yaml", import.meta.url), "utf8"));
  await persistImport({ workspace: { id: "imported", name: "Imported", headers: [], auth: [] }, resources: [resource], diagnostics: [], secrets: [] }, persistence);
  assert.ok(Object.keys(backend.snapshot.workspaces[0].files).some((path) => path.startsWith("requests/")));
  assert.ok(!JSON.stringify(backend.snapshot.workspaces[0].files).includes("lastResponse"));
});
