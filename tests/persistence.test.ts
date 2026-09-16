import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { WorkspacePersistence } from "../src/application/workspace-persistence";
import { projectWorkspace, restoreWorkspace } from "../src/application/project-projection";
import { validateProject } from "../src/domain/project";
import { createWorkspace, createGraphqlDocument, createSchemaDocument, cloneRequestDraft, isExtensionDocument, isRequestDocument } from "../src/features/workspaces/model/workspace";
import { deserializeManifest, deserializeResource, deserializeResourceFile, serializeManifest, serializeResource } from "../src/storage/yaml";
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

test("integration envelopes migrate legacy endpoints and preserve unavailable provider config", async () => {
  const legacyText = await readFile(new URL("./fixtures/projects/integration-legacy.yaml", import.meta.url), "utf8");
  const privateText = await readFile(new URL("./fixtures/projects/integration-private.yaml", import.meta.url), "utf8");
  const legacy = deserializeResourceFile(legacyText);
  assert.equal(legacy.developmentRewrite, true);
  assert.equal(legacy.value.kind, "integration");
  if (legacy.value.kind !== "integration") return;
  assert.equal(legacy.value.enabled, true);
  assert.equal(legacy.value.configVersion, 1);
  assert.deepEqual(legacy.value.config, { endpoint: "http://127.0.0.1:16686" });
  const legacyYaml = serializeResource(legacy.value);
  assert.doesNotMatch(legacyYaml, /^endpoint:/m);
  assert.match(legacyYaml, /configVersion: 1/);
  assert.match(legacyYaml, /config:\n  endpoint: http:\/\/127\.0\.0\.1:16686/);

  const unavailable = deserializeResource(privateText);
  assert.equal(unavailable.kind, "integration");
  if (unavailable.kind !== "integration") return;
  const config = structuredClone(unavailable.config);
  const canonical = serializeResource(unavailable);
  const roundTrip = deserializeResource(canonical);
  assert.deepEqual(roundTrip, unavailable);
  assert.deepEqual(roundTrip.kind === "integration" ? roundTrip.config : undefined, config);
  assert.match(canonical, /enabled: true/);
  assert.match(canonical, /emptyList: \[\]/);
  assert.match(canonical, /body:\n      type: none/);

  const workspace = createWorkspace("Integration fixture", "integration-fixture");
  workspace.extraResources = [unavailable];
  const secure = new MemorySecureStore();
  await secure.set("purr/integration-fixture/integrations/private-observability/apiKey", "synthetic-private-token");
  const first = await projectWorkspace(workspace, secure);
  const yaml = first.project.resources.map((resource) => serializeResource(resource)).join("\n");
  assert.doesNotMatch(yaml, /synthetic-private-token/);
  const restored = await restoreWorkspace(first.project, first.local, secure, {});
  const restoredIntegration = restored.extraResources?.find((resource) => resource.id === unavailable.id);
  assert.deepEqual(restoredIntegration, unavailable);
  if (!restoredIntegration || restoredIntegration.kind !== "integration") return;
  restoredIntegration.enabled = true;
  const reprojected = await projectWorkspace(restored, secure);
  const enabled = reprojected.project.resources.find((resource) => resource.id === unavailable.id);
  assert.equal(enabled?.kind === "integration" ? enabled.enabled : false, true);
  assert.deepEqual(enabled?.kind === "integration" ? enabled.config : undefined, config);

  const wrongWorkspace = structuredClone(unavailable);
  wrongWorkspace.credentials.apiKey = { kind: "secret", ref: "purr/another-workspace/integrations/private-observability/apiKey" };
  assert.throws(() => validateProject({ workspace: first.project.workspace, resources: [wrongWorkspace] }), /belong to this workspace/);
  assert.throws(() => deserializeResource(privateText.replace("commercial.datadog", "Commercial/Datadog")), /Invalid Purr resource/);
  assert.throws(() => deserializeResource(privateText.replace("apiKey:", "api.key:")), /Invalid Purr resource/);
});

test("unknown extension documents preserve canonical config and local edits without their module", async () => {
  const source = await readFile(new URL("./fixtures/projects/extension-private.yaml", import.meta.url), "utf8");
  const unavailable = deserializeResource(source);
  assert.equal(unavailable.kind, "extension");
  if (unavailable.kind !== "extension") return;
  const originalConfig = structuredClone(unavailable.config);
  const yaml = serializeResource(unavailable);
  assert.deepEqual(deserializeResource(yaml), unavailable);
  assert.match(yaml, /emptyList: \[\]/);
  assert.match(yaml, /body:\n    type: none/);

  const project = validateProject({
    workspace: { id: "extension-fixture", name: "Extension fixture", variables: [], headers: [], auth: [] },
    resources: [unavailable],
  });
  const secure = new MemorySecureStore();
  const restored = await restoreWorkspace(project, [], secure, {});
  const document = restored.documents.find((item) => item.id === unavailable.id);
  assert.ok(document && isExtensionDocument(document));
  assert.deepEqual(document.config, originalConfig);
  document.name = "Renamed without module";
  document.config = { ...document.config, message: "local working copy" };
  document.configVersion = 3;

  const projected = await projectWorkspace(restored, secure);
  const canonical = projected.project.resources.find((item) => item.id === unavailable.id);
  assert.equal(canonical?.name, "Renamed without module");
  assert.equal(canonical?.kind === "extension" ? canonical.configVersion : 0, 2);
  assert.deepEqual(canonical?.kind === "extension" ? canonical.config : undefined, originalConfig);
  assert.ok(projected.local.some((record) => record.table === "drafts" && record.id === unavailable.id));

  const withWorkingCopy = await restoreWorkspace(projected.project, projected.local, secure, {});
  const working = withWorkingCopy.documents.find((item) => item.id === unavailable.id);
  assert.ok(working && isExtensionDocument(working));
  assert.equal(working.name, "Renamed without module");
  assert.equal(working.configVersion, 3);
  assert.equal(working.config.message, "local working copy");
  assert.deepEqual(working.savedConfig, originalConfig);

  working.savedConfigVersion = working.configVersion;
  working.savedConfig = structuredClone(working.config);
  const saved = await projectWorkspace(withWorkingCopy, secure);
  const savedDefinition = saved.project.resources.find((item) => item.id === unavailable.id);
  assert.equal(savedDefinition?.kind === "extension" ? savedDefinition.configVersion : 0, 3);
  assert.equal(savedDefinition?.kind === "extension" ? savedDefinition.config.message : undefined, "local working copy");

  const backend = new MemoryPersistenceBackend();
  const persistence = new WorkspacePersistence(backend, secure);
  await persistence.save({ activeWorkspaceId: withWorkingCopy.id, workspaces: [withWorkingCopy], globalVariables: [] });
  const files = backend.snapshot.workspaces[0].files;
  const extensionPath = Object.keys(files).find((path) => path.startsWith("documents/") && path.endsWith(".yaml"));
  assert.ok(extensionPath);
  assert.match(files[extensionPath].content, /kind: extension/);
  const reloaded = await persistence.load();
  const reloadedDocument = reloaded.workspaces[0].documents.find((item) => item.id === unavailable.id);
  assert.ok(reloadedDocument && isExtensionDocument(reloadedDocument));
  assert.equal(reloadedDocument.config.message, "local working copy");
});

test("workspace load rewrites legacy integration YAML to the canonical envelope", async () => {
  const backend = new MemoryPersistenceBackend();
  const legacy = await readFile(new URL("./fixtures/projects/integration-legacy.yaml", import.meta.url), "utf8");
  backend.snapshot = {
    activeWorkspaceId: "integration-fixture",
    workspaces: [{
      id: "integration-fixture",
      files: {
        "purr.yaml": { content: "purr: 1\nworkspace:\n  id: integration-fixture\n  name: Integration fixture\n", revision: "manifest" },
        "integrations/legacy-jaeger.yaml": { content: legacy, revision: "legacy" },
      },
      local: [],
    }],
  };
  const persistence = new WorkspacePersistence(backend, new MemorySecureStore());
  const store = await persistence.load();
  const integration = store.workspaces[0].extraResources?.find((resource) => resource.id === "legacy-jaeger");
  assert.equal(integration?.kind === "integration" ? integration.config.endpoint : undefined, "http://127.0.0.1:16686");
  const rewritten = backend.snapshot.workspaces[0].files["integrations/legacy-jaeger.yaml"].content;
  assert.doesNotMatch(rewritten, /^endpoint:/m);
  assert.match(rewritten, /configVersion: 1/);
  assert.equal(deserializeResourceFile(rewritten).developmentRewrite, false);
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

test("failed import commits remove transient secret values", async () => {
  const backend = new MemoryPersistenceBackend();
  backend.commit = async () => { throw new Error("Import commit failed"); };
  const secure = new MemorySecureStore();
  const persistence = new WorkspacePersistence(backend, secure);
  const ref = "purr/failed-import/imports/openapi/access-token" as const;
  await assert.rejects(persistImport({
    workspace: { id: "failed-import", name: "Failed", headers: [], auth: [], variables: [
      { id: "access-token", name: "accessToken", enabled: true, sensitive: true, kind: "static", secretRef: ref },
    ] },
    resources: [], diagnostics: [], secrets: [{ ref, value: "" }],
  }, persistence), /Import commit failed/);
  assert.equal(await secure.exists(ref), false);
});

test("OpenAPI imports persist operation metadata and the source document as a schema sidecar", async () => {
  const backend = new MemoryPersistenceBackend(); const secure = new MemorySecureStore(); const persistence = new WorkspacePersistence(backend, secure);
  const schemaId = "api-schema-example";
  const authRef = "purr/openapi-import/auth/bearer-auth/bearer" as const;
  const result = {
    workspace: { id: "openapi-import", name: "Example API", headers: [], auth: [
      { id: "bearer-auth", name: "Bearer auth", enabled: true, scope: "all" as const,
        config: { type: "bearer" as const, token: { kind: "secret" as const, ref: authRef }, prefix: "Bearer" } },
    ], variables: [{ id: "base-url", name: "baseUrl", enabled: true, sensitive: false, kind: "static" as const, value: "https://api.example.com" }] },
    resources: [
      { id: "users", name: "Users", kind: "folder" as const },
      { id: schemaId, name: "Example API OpenAPI", kind: "api-schema" as const, format: "openapi-3" as const, source: { type: "url" as const, location: "https://api.example.com/openapi.yaml" }, document: "openapi: 3.1.0\ninfo: { title: Example API, version: 1 }\npaths: {}\n" },
      { id: "get-user", name: "Get user", kind: "http" as const, folderId: "users", method: "GET", url: "{{baseUrl}}/users/:id",
        params: [], pathParams: [{ name: "id", value: "", enabled: true }], headers: [], body: { type: "none" as const }, auth: { type: "inherit" as const, profileId: "bearer-auth" },
        origin: { type: "openapi" as const, schemaId, operationPath: "#/paths/~1users~1{id}/get", operationId: "getUser" } },
    ], diagnostics: [], secrets: [{ ref: authRef, value: "" }],
  };
  const imported = await persistImport(result, persistence);
  assert.equal(imported.id, "openapi-import"); assert.equal(imported.ui.activeDocumentId, "get-user");
  const files = backend.snapshot.workspaces[0].files;
  assert.equal(files[`schemas/${schemaId}.openapi`].content, result.resources[1].document);
  assert.match(Object.values(files).find((file) => file.content.includes("kind: api-schema"))!.content, new RegExp(`schema: schemas/${schemaId}\\.openapi`));
  const reloaded = await new WorkspacePersistence(backend, secure).load();
  assert.equal(reloaded.workspaces[0].documents[0].origin?.operationId, "getUser");
  assert.equal(reloaded.workspaces[0].documents[0].request.auth.inherit.profileId, "bearer-auth");
  assert.equal(reloaded.workspaces[0].requestConfig.auth[0].value.bearer.token, "");
  const schema = reloaded.workspaces[0].extraResources?.find((resource) => resource.id === schemaId);
  assert.ok(schema?.kind === "api-schema"); assert.equal(schema.document, result.resources[1].document);
});
