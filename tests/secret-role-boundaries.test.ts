import assert from "node:assert/strict";
import test from "node:test";
import { projectWorkspace } from "../src/application/project-projection";
import { WorkspacePersistence } from "../src/application/workspace-persistence";
import { integrationDefinitionSchema } from "../src/domain/project";
import { cloneRequestDraft, createExtensionDocument, createSchemaDocument, createWorkspace, isDocumentDirty, isRequestDocument } from "../src/features/workspaces/model/workspace";
import { MemorySecureStore, protectRuntime, resolveRuntime, SecretPreparationStore } from "../src/storage/secrets";
import { deserializeResource } from "../src/storage/yaml";
import { MemoryPersistenceBackend } from "./helpers/memory-persistence";
import { createRequestAuth } from "../src/features/request-workbench/model/request-auth";
import { resolveRequestSecrets, resolveSecretField } from "../src/application/resolve-request-secrets";

test("unsaved cookie protocol rows are protected locally even without a sensitive UI flag", async () => {
  const secure = new SecretPreparationStore(new MemorySecureStore());
  const rows = [
    { id: "cookie", name: " Cookie ", value: "synthetic-cookie-local", enabled: false },
    { id: "set-cookie", name: "sEt-CoOkIe", value: "synthetic-set-cookie-local", enabled: true },
    { id: "ordinary", name: "Authorization", value: "public-unmarked-header", enabled: true },
  ];
  const protectedRows = await protectRuntime(rows, secure, "role-local", "drafts/request/headers");
  const serialized = JSON.stringify(protectedRows);
  assert.ok(!serialized.includes(rows[0].value)); assert.ok(!serialized.includes(rows[1].value));
  assert.ok(serialized.includes(rows[2].value), "ordinary names must not cause protection inference");
  assert.deepEqual((await secure.batch()).mutations.map((mutation) => mutation.value).sort(), [rows[0].value, rows[1].value].sort());
});

function roleWorkspace() {
  const workspace = createWorkspace("Legacy role fixture", "legacy-roles");
  const schema = createSchemaDocument(); schema.id = "registry-schema";
  schema.schemaSource = { type: "registry", provider: "example", resource: "fixture", credential: { kind: "plain", value: "synthetic-registry-token" } };
  workspace.documents = [schema];
  workspace.extraResources = [integrationDefinitionSchema.parse({ id: "provider", kind: "integration", name: "Opaque provider", provider: "private.example",
    config: { nested: { kind: "plain", value: "public-provider-config" }, template: "{{PUBLIC}}" },
    credentials: { accessToken: { kind: "plain", value: "synthetic-integration-token" }, templateSlot: { kind: "plain", value: "{{OPAQUE_PROVIDER_TOKEN}}" } } })];
  return { workspace, schema };
}

test("pending workspace protection handles declared integration and registry slots without interpreting opaque provider config", async () => {
  const { workspace } = roleWorkspace(); const secure = new SecretPreparationStore(new MemorySecureStore());
  const protectedWorkspace = await protectRuntime(workspace, secure, workspace.id, "legacy-definition-draft") as typeof workspace;
  const serialized = JSON.stringify(protectedWorkspace);
  for (const marker of ["synthetic-registry-token", "synthetic-integration-token", "{{OPAQUE_PROVIDER_TOKEN}}"])
    assert.ok(!serialized.includes(marker), `Declared credential remains literal: ${marker}`);
  const integration = protectedWorkspace.extraResources?.find((resource) => resource.kind === "integration");
  assert.ok(integration?.kind === "integration");
  assert.deepEqual(integration.config, { nested: { kind: "plain", value: "public-provider-config" }, template: "{{PUBLIC}}" });
  assert.deepEqual((await secure.batch()).mutations.map((mutation) => mutation.value).sort(),
    ["synthetic-registry-token", "synthetic-integration-token", "{{OPAQUE_PROVIDER_TOKEN}}"].sort());
});

test("projection migrates explicit credential slots and keeps schema cache credential-free", async () => {
  const { workspace, schema } = roleWorkspace(); schema.saved = true;
  const projected = await projectWorkspace(workspace, new MemorySecureStore());
  const serialized = JSON.stringify({ project: projected.project, local: projected.local });
  for (const marker of ["synthetic-registry-token", "synthetic-integration-token", "{{OPAQUE_PROVIDER_TOKEN}}"])
    assert.ok(!serialized.includes(marker), `Credential remains literal in canonical or local projection: ${marker}`);
  const integration = projected.project.resources.find((resource) => resource.kind === "integration");
  assert.ok(integration?.kind === "integration");
  assert.equal(integration.credentials.accessToken.kind, "secret");
  assert.equal(integration.credentials.templateSlot.kind, "secret", "provider slots are opaque strings, not request-auth templates");
  const definition = projected.project.resources.find((resource) => resource.kind === "schema");
  assert.ok(definition?.kind === "schema" && definition.source.type === "registry");
  assert.equal(definition.source.credential?.kind, "secret");
  assert.deepEqual(integration.config, { nested: { kind: "plain", value: "public-provider-config" }, template: "{{PUBLIC}}" });
});

test("pending workspace protection preserves opaque extension config even when its keys resemble core credentials", async () => {
  const workspace = createWorkspace("Extension fixture", "extension-roles");
  const config = { source: { type: "registry", credential: { kind: "plain", value: "public-vendor-value" } },
    cookieLabel: { name: "Cookie", value: "public-vendor-label" } };
  const document = createExtensionDocument("private.example", "Opaque extension", 1, config);
  document.savedConfig = structuredClone(config); workspace.documents = [document];
  const secure = new SecretPreparationStore(new MemorySecureStore());
  const protectedWorkspace = await protectRuntime(workspace, secure, workspace.id, "legacy-definition-draft") as typeof workspace;
  const restored = protectedWorkspace.documents[0]; assert.equal(restored.kind, "extension");
  if (restored.kind === "extension") { assert.deepEqual(restored.config, config); assert.deepEqual(restored.savedConfig, config); }
  assert.deepEqual((await secure.batch()).mutations, []);
});

test("lazy pending workspace restoration leaves vendor marker-shaped JSON opaque", async () => {
  const config = { sentinel: { __purrSecret: { kind: "secret", ref: "purr/vendor/opaque/value" } }, credentialStates: { public: "value" } };
  const workspace = createWorkspace("Opaque restore", "opaque-restore");
  workspace.documents = [createExtensionDocument("private.example", "Opaque extension", 1, config)];
  workspace.extraResources = [integrationDefinitionSchema.parse({ kind: "integration", id: "provider", name: "Provider", provider: "private.example", config })];
  const restored = await resolveRuntime(workspace, new MemorySecureStore(), false) as typeof workspace;
  const extension = restored.documents[0]; assert.ok(extension.kind === "extension"); assert.deepEqual(extension.config, config);
  const integration = restored.extraResources?.[0]; assert.ok(integration?.kind === "integration"); assert.deepEqual(integration.config, config);
});

test("v1 integration and schema registry literals upgrade atomically through their declared credential slots", async () => {
  const secure = new MemorySecureStore(); const backend = new MemoryPersistenceBackend(secure);
  const files = {
    "purr.yaml": "purr: 1\nworkspace: { id: legacy-roles, name: Legacy role fixture }\n",
    "integrations/provider.yaml": "purr: 1\nkind: integration\nid: provider\nname: Opaque provider\nprovider: private.example\ncredentials:\n  accessToken: { kind: plain, value: synthetic-integration-token }\n  templateSlot: { kind: plain, value: '{{OPAQUE_PROVIDER_TOKEN}}' }\nconfig:\n  nested: { kind: plain, value: public-provider-config }\n",
    "schemas/registry.yaml": "purr: 1\nkind: schema\nid: registry-schema\nname: Registry fixture\nsource:\n  type: registry\n  provider: example\n  resource: fixture\n  credential: { kind: plain, value: synthetic-registry-token }\npin: false\n",
  };
  backend.snapshot = { activeWorkspaceId: "legacy-roles", workspaces: [{ id: "legacy-roles", local: [], files: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, { content, revision: `original-${path}` }])) }] };
  const persistence = new WorkspacePersistence(backend, secure); const store = await persistence.load();
  await persistence.save(store);
  for (const [path, content] of Object.entries(files)) assert.equal(backend.snapshot.workspaces[0].files[path].content, content);
  await persistence.upgradeWorkspace(store.workspaces[0]);
  const updated = backend.snapshot.workspaces[0].files;
  for (const [path, file] of Object.entries(updated)) if (path.endsWith(".yaml")) assert.match(file.content, /^purr: 2\n/);
  const integration = deserializeResource(updated["integrations/provider.yaml"].content);
  assert.equal(integration.kind, "integration");
  if (integration.kind === "integration") for (const [slot, expected] of Object.entries({ accessToken: "synthetic-integration-token", templateSlot: "{{OPAQUE_PROVIDER_TOKEN}}" })) {
    const credential = integration.credentials[slot]; assert.equal(credential.kind, "secret");
    if (credential.kind === "secret") assert.equal(await secure.get(credential.ref), expected);
  }
  const schema = deserializeResource(updated["schemas/registry.yaml"].content);
  assert.ok(schema.kind === "schema" && schema.source.type === "registry" && schema.source.credential?.kind === "secret");
  assert.equal(await secure.get(schema.source.credential.ref), "synthetic-registry-token");
  assert.ok(!JSON.stringify(backend.snapshot).includes("synthetic-registry-token"));
  assert.ok(!JSON.stringify(backend.snapshot).includes("synthetic-integration-token"));
});

test("a new v1 OAuth profile and acquired token survive local autosave and restart before explicit upgrade", async () => {
  const secure = new MemorySecureStore(); const backend = new MemoryPersistenceBackend(secure);
  const manifest = "purr: 1\nworkspace: { id: pending-profile, name: Legacy profile }\n";
  backend.snapshot = { activeWorkspaceId: "pending-profile", workspaces: [{ id: "pending-profile", local: [], files: { "purr.yaml": { content: manifest, revision: "original" } } }] };
  const persistence = new WorkspacePersistence(backend, secure); const store = await persistence.load();
  const value = createRequestAuth(); value.type = "oauth2"; value.oauth2.clientId = "public-client";
  value.oauth2.clientSecret = "synthetic-new-profile-client";
  value.oauth2.token = { accessToken: "synthetic-new-profile-access", refreshToken: "synthetic-new-profile-refresh", obtainedAt: 1, tokenType: "Bearer" };
  store.workspaces[0].requestConfig.auth.push({ id: "new-profile", name: "New OAuth", scope: "all", enabled: true, value });
  await persistence.save(store);
  assert.equal(backend.snapshot.workspaces[0].files["purr.yaml"].content, manifest);
  for (const marker of [value.oauth2.clientSecret, value.oauth2.token.accessToken, value.oauth2.token.refreshToken!]) assert.ok(!JSON.stringify(backend.snapshot).includes(marker));
  const restarted = new WorkspacePersistence(backend, secure); const reopened = await restarted.load();
  const auth = reopened.workspaces[0].requestConfig.auth.find((profile) => profile.id === "new-profile")?.value;
  assert.ok(auth?.oauth2.token);
  assert.equal(await resolveSecretField(auth.oauth2.clientSecret, auth.credentialStates?.["client-secret"], secure), "synthetic-new-profile-client");
  assert.equal(await resolveSecretField(auth.oauth2.token.accessToken, auth.credentialStates?.["oauth-access-token"], secure), "synthetic-new-profile-access");
  assert.equal(backend.snapshot.workspaces[0].files["purr.yaml"].content, manifest);
  await restarted.upgradeWorkspace(reopened.workspaces[0]);
  assert.match(backend.snapshot.workspaces[0].files["purr.yaml"].content, /^purr: 2\n/);
  const upgraded = await new WorkspacePersistence(backend, secure).load();
  const finalAuth = upgraded.workspaces[0].requestConfig.auth.find((profile) => profile.id === "new-profile")?.value;
  assert.ok(finalAuth?.oauth2.token);
  assert.equal(await resolveSecretField(finalAuth.oauth2.clientSecret, finalAuth.credentialStates?.["client-secret"], secure), "synthetic-new-profile-client");
  assert.equal(await resolveSecretField(finalAuth.oauth2.token.accessToken, finalAuth.credentialStates?.["oauth-access-token"], secure), "synthetic-new-profile-access");
  assert.equal(await resolveSecretField(finalAuth.oauth2.token.refreshToken ?? "", finalAuth.credentialStates?.["oauth-refresh-token"], secure), "synthetic-new-profile-refresh");
});

test("v1 local autosave and restart preserve template credentials without declassifying an intentional SecretRef", async () => {
  const secure = new MemorySecureStore(); const backend = new MemoryPersistenceBackend(secure);
  const reference = "purr/template-upgrade/requests/opaque/saved/bearer"; await secure.set(reference, "{{TOKEN}}");
  const before = await secure.read(reference);
  const files = {
    "purr.yaml": "purr: 1\nworkspace: { id: template-upgrade, name: Legacy templates }\n",
    "documents/template.yaml": "purr: 1\nkind: http\nid: template\nname: Template\nurl: https://example.test\nmethod: GET\nauth: { type: bearer, token: { kind: plain, value: '{{TOKEN}}' } }\nheaders:\n  - { name: X-Protected, value: '{{HEADER}}', secret: true }\n",
    "documents/opaque.yaml": `purr: 1\nkind: http\nid: opaque\nname: Opaque credential\nurl: https://example.test\nmethod: GET\nauth: { type: bearer, token: { kind: secret, ref: '${reference}' } }\n`,
    "schemas/registry-template.yaml": "purr: 1\nkind: schema\nid: registry-template\nname: Registry template\npin: false\nsource: { type: registry, provider: example, resource: fixture, credential: { kind: plain, value: '{{REGISTRY_TOKEN}}' } }\n",
  };
  backend.snapshot = { activeWorkspaceId: "template-upgrade", workspaces: [{ id: "template-upgrade", local: [], files: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, { content, revision: `original-${path}` }])) }] };
  const first = new WorkspacePersistence(backend, secure); const opened = await first.load(); await first.save(opened);
  const restarted = new WorkspacePersistence(backend, secure); const reopened = await restarted.load();
  for (const [path, content] of Object.entries(files)) assert.equal(backend.snapshot.workspaces[0].files[path].content, content);
  await restarted.upgradeWorkspace(reopened.workspaces[0]);
  const template = deserializeResource(backend.snapshot.workspaces[0].files["documents/template.yaml"].content);
  assert.ok(template.kind === "http" && template.auth.type === "bearer");
  assert.deepEqual(template.auth.token, { kind: "template", value: "{{TOKEN}}" });
  assert.deepEqual(template.headers[0].value, { kind: "template", value: "{{HEADER}}" });
  assert.equal(template.headers[0].sensitive, true);
  const opaque = deserializeResource(backend.snapshot.workspaces[0].files["documents/opaque.yaml"].content);
  assert.ok(opaque.kind === "http" && opaque.auth.type === "bearer");
  assert.deepEqual(opaque.auth.token, { kind: "secret", ref: reference });
  const registry = deserializeResource(backend.snapshot.workspaces[0].files["schemas/registry-template.yaml"].content);
  assert.ok(registry.kind === "schema" && registry.source.type === "registry");
  assert.deepEqual(registry.source.credential, { kind: "template", value: "{{REGISTRY_TOKEN}}" });
  assert.deepEqual(await secure.read(reference), before);
});

test("new v1 registry schemas keep local credentials and typed templates without creating saved credential owners before upgrade", async () => {
  const secure = new MemorySecureStore(); const backend = new MemoryPersistenceBackend(secure);
  const manifest = "purr: 1\nworkspace: { id: pending-schema, name: Legacy schemas }\n";
  backend.snapshot = { activeWorkspaceId: "pending-schema", workspaces: [{ id: "pending-schema", local: [], files: { "purr.yaml": { content: manifest, revision: "original" } } }] };
  const persistence = new WorkspacePersistence(backend, secure); const store = await persistence.load();
  const literal = createSchemaDocument(); literal.id = "new-literal"; literal.saved = true; literal.pinned = false;
  literal.schemaSource = { type: "registry", provider: "example", resource: "fixture", credential: { kind: "plain", value: "synthetic-new-registry" } };
  const template = createSchemaDocument(); template.id = "new-template"; template.saved = true; template.pinned = false;
  template.schemaSource = { type: "registry", provider: "example", resource: "fixture", credential: { kind: "template", value: "{{REGISTRY_TOKEN}}" } };
  store.workspaces[0].documents.push(literal, template); await persistence.save(store);
  assert.deepEqual(Object.keys(backend.snapshot.workspaces[0].files), ["purr.yaml"]);
  assert.equal(await secure.get("purr/pending-schema/schemas/new-literal/registry/credential"), null);
  assert.ok(!JSON.stringify(backend.snapshot).includes("synthetic-new-registry"));
  const restarted = new WorkspacePersistence(backend, secure); const reopened = await restarted.load();
  const restoredTemplate = reopened.workspaces[0].documents.find((document) => document.id === template.id);
  assert.ok(restoredTemplate?.kind === "schema" && restoredTemplate.schemaSource?.type === "registry");
  assert.deepEqual(restoredTemplate.schemaSource.credential, { kind: "template", value: "{{REGISTRY_TOKEN}}" });
  assert.equal(backend.snapshot.workspaces[0].files["purr.yaml"].content, manifest);
  await restarted.upgradeWorkspace(reopened.workspaces[0]);
  const resources = Object.entries(backend.snapshot.workspaces[0].files).filter(([path]) => path !== "purr.yaml" && path.endsWith(".yaml")).map(([, file]) => deserializeResource(file.content));
  const savedLiteral = resources.find((resource) => resource.id === literal.id);
  assert.ok(savedLiteral?.kind === "schema" && savedLiteral.source.type === "registry" && savedLiteral.source.credential?.kind === "secret");
  assert.equal(await secure.get(savedLiteral.source.credential.ref), "synthetic-new-registry");
  const savedTemplate = resources.find((resource) => resource.id === template.id);
  assert.ok(savedTemplate?.kind === "schema" && savedTemplate.source.type === "registry");
  assert.deepEqual(savedTemplate.source.credential, { kind: "template", value: "{{REGISTRY_TOKEN}}" });
});

test("a working SecretRef-to-template edit remains dirty through autosave and restart without composing the old saved secret", async () => {
  const secure = new MemorySecureStore(); const backend = new MemoryPersistenceBackend(secure);
  const workspace = createWorkspace("Working template", "working-template"); const document = workspace.documents[0]; assert.ok(isRequestDocument(document));
  document.saved = true; document.request.auth.type = "bearer"; document.request.auth.bearer.token = "synthetic-old-saved-token";
  document.request.headers = [{ id: "protected", name: "X-Protected", value: "synthetic-old-saved-header", enabled: true, secret: true }];
  document.savedRequest = cloneRequestDraft(document.request);
  const store = { activeWorkspaceId: workspace.id, workspaces: [workspace], globalVariables: [] };
  const persistence = new WorkspacePersistence(backend, secure); await persistence.save(store);
  const originalFiles = structuredClone(backend.snapshot.workspaces[0].files);
  const authState = document.request.auth.credentialStates?.bearer; const headerState = document.request.headers[0].secretState;
  assert.ok(authState && headerState);
  const savedToken = await secure.read(authState.ref); const savedHeader = await secure.read(headerState.ref);
  document.request.auth.bearer.token = "{{NEW_TOKEN}}";
  document.request.auth.credentialStates = { bearer: { ...authState, edit: { kind: "set", value: "{{NEW_TOKEN}}" } } };
  document.request.headers[0].value = "{{NEW_HEADER}}";
  document.request.headers[0].secretState = { ...headerState, edit: { kind: "set", value: "{{NEW_HEADER}}" } };
  assert.equal(isDocumentDirty(document), true); await persistence.save(store);
  assert.deepEqual(backend.snapshot.workspaces[0].files, originalFiles);
  const reopened = await new WorkspacePersistence(backend, secure).load(); const working = reopened.workspaces[0].documents.find((item) => item.id === document.id);
  assert.ok(working && isRequestDocument(working)); assert.equal(isDocumentDirty(working), true);
  assert.equal(working.request.auth.secretRefs?.bearer, undefined); assert.equal(working.request.auth.credentialStates?.bearer, undefined);
  assert.equal(working.request.headers[0].secretRef, undefined); assert.equal(working.request.headers[0].secretState, undefined);
  const prepared = await resolveRequestSecrets(working.request, { secretStore: secure, variables: { NEW_TOKEN: "replacement-token", NEW_HEADER: "replacement-header" } });
  assert.equal(prepared.draft.auth.bearer.token, "{{NEW_TOKEN}}"); assert.equal(prepared.draft.headers[0].value, "{{NEW_HEADER}}");
  assert.deepEqual(await secure.read(authState.ref), savedToken); assert.deepEqual(await secure.read(headerState.ref), savedHeader);
});
