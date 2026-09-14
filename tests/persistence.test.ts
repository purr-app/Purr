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
    { id: "secret-id", name: "token", kind: "static", value: "environment-secret", loaded: true, sensitive: true, enabled: true },
    { id: "plain-id", name: "base_url", kind: "static", value: "https://example.com", sensitive: false, enabled: false },
  ] });
  workspace.activeEnvironmentId = "env";
  let projected = await projectWorkspace(workspace, secure);
  assert.equal(projected.project.resources.filter((resource) => resource.kind === "http").length, 0);
  assert.ok(projected.local.some((record) => record.table === "drafts"));
  request.saved = true; request.savedRequest = cloneRequestDraft(request.request);
  request.request.documentation = "# Basic authentication\n\nThis request returns a user.";
  request.request.body.type = "json"; request.request.body.json = '{\n  "name": "Ihor",\n  "active": true\n}\n'; request.savedRequest = cloneRequestDraft(request.request);
  request.request.environmentId = "env"; request.savedRequest.environmentId = "env";
  request.sentAt = "2026-01-01";
  workspace.cookies.push({ id: "cookie-id", name: "session", value: "cookie-secret", domain: "example.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", hostOnly: true, enabled: true });
  projected = await projectWorkspace(workspace, secure);
  const documentedResource = projected.project.resources.find((resource) => resource.kind === "http");
  assert.ok(documentedResource?.kind === "http");
  const documentedYaml = serializeResource(documentedResource);
  assert.match(documentedYaml, /documentation:/);
  const documentedRoundTrip = deserializeResource(documentedYaml);
  assert.equal(documentedRoundTrip.kind === "http" ? documentedRoundTrip.documentation : undefined, request.request.documentation);
  const yaml = [serializeManifest(projected.project.workspace), ...projected.project.resources.map((resource) => serializeResource(resource))].join("\n");
  for (const text of ["basic-password-secret", "inactive-bearer-secret", "environment-secret", "cookie-secret", "sentAt", "lastResponse", "openDocumentIds", "splitRatios"]) assert.ok(!yaml.includes(text), text);
  const local = JSON.stringify(projected.local);
  for (const text of ["basic-password-secret", "inactive-bearer-secret", "environment-secret"]) assert.ok(!local.includes(text), text);
  const restored = await restoreWorkspace(projected.project, projected.local, secure, {});
  const document = restored.documents[0]; assert.ok(isRequestDocument(document));
  assert.equal(document.request.body.json, request.request.body.json);
  assert.equal(document.request.documentation, request.request.documentation);
  assert.equal(document.request.environmentId, "env");
  assert.equal(document.request.auth.basic.password, "basic-password-secret");
  assert.equal(restored.environments[0].variables[0].kind === "static" ? restored.environments[0].variables[0].value : "", "environment-secret");
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
  assert.ok(resource.kind === "schema" && resource.pin && resource.pinnedSdl === schema.sdl);
  assert.ok(projected.local.some((record) => record.table === "schema_cache"));
  schema.pinned = true; projected = await projectWorkspace(workspace, secure);
  const pinned = projected.project.resources.find((item) => item.id === schema.id)!;
  assert.ok(serializeResource(pinned, `schemas/${schema.id}.graphql`).includes("pinned:"));
  assert.deepEqual(deserializeResource(serializeResource(pinned, `schemas/${schema.id}.graphql`), () => schema.sdl), pinned);
  schema.pinned = false; projected = await projectWorkspace(workspace, secure);
  const unpinned = projected.project.resources.find((item) => item.id === schema.id)!;
  const unpinnedYaml = serializeResource(unpinned, `schemas/${schema.id}.graphql`);
  assert.match(unpinnedYaml, /pin: false/);
  assert.equal(deserializeResource(unpinnedYaml).kind === "schema" && deserializeResource(unpinnedYaml).pin, false);
});

test("first-class workspace variables are deterministic and secret values never enter YAML", async () => {
  const workspace = createWorkspace("Variables", "variables");
  const secure = new MemorySecureStore();
  workspace.variables = [
    { id: "base-url", name: "base_url", enabled: true, sensitive: false, kind: "static", value: "https://example.test" },
    { id: "api-token", name: "api_token", enabled: true, sensitive: true, kind: "static", value: "local-only-value", loaded: true },
    { id: "upload-url", name: "upload_url", enabled: true, sensitive: true, kind: "dynamic-request", documentId: "", expression: "$.media.url", language: "jsonpath", refresh: "cache", cacheTtlSeconds: 300, environment: { type: "current" } },
  ];
  const first = await projectWorkspace(workspace, secure);
  const yaml = serializeManifest(first.project.workspace);
  assert.equal(serializeManifest(first.project.workspace), yaml);
  assert.match(yaml, /kind: dynamic-request/);
  assert.match(yaml, /secretRef: purr\/variables\/variables\/api-token/);
  assert.doesNotMatch(yaml, /local-only-value/);
  const restored = await restoreWorkspace(first.project, first.local, secure, {});
  assert.equal(restored.variables.find((variable) => variable.name === "api_token")?.kind === "static"
    ? restored.variables.find((variable) => variable.name === "api_token")?.value : "", "local-only-value");
});

test("legacy workspace migrates once; UI saves do not rewrite project files, rename keeps paths and secret references", async () => {
  const backend = new MemoryPersistenceBackend(); const secure = new MemorySecureStore(); const workspace = createWorkspace("Legacy", "legacy");
  const request = workspace.documents[0]; assert.ok(isRequestDocument(request)); request.saved = true; request.savedRequest = cloneRequestDraft(request.request);
  workspace.environments.push({ id: "env", name: "Staging", variables: [{ id: "stable", name: "password", kind: "static", value: "do-not-export", loaded: true, sensitive: true, enabled: true }] });
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
  assert.equal(reloaded.workspaces[0].environments[0].variables[0].kind === "static" ? reloaded.workspaces[0].environments[0].variables[0].value : "", "do-not-export");
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
  assert.ok(Object.keys(backend.snapshot.workspaces[0].files).some((path) => path.startsWith("documents/")));
  assert.ok(!JSON.stringify(backend.snapshot.workspaces[0].files).includes("lastResponse"));
});
