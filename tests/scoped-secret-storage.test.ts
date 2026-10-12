import { schemaConnectionIdentity } from "../src/features/graphql/model/schema-connection";
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserScopeCrypto, scopeIdentity, type BrowserProtectionScope, type BrowserScopeKey } from "../src/storage/browser-crypto";
import { MemorySecureStore, protectRuntime, SecretPreparationStore, secretProtectionScope, secretRef } from "../src/storage/secrets";
import { createRequestAuth } from "../src/features/request-workbench/model/request-auth";
import { projectWorkspace } from "../src/application/project-projection";
import { cloneRequestDraft, createSchemaDocument, createWorkspace, isRequestDocument } from "../src/features/workspaces/model/workspace";
import { integrationCredentialRef, integrationTokenRef, readIntegrationCredential, stageIntegrationCredential } from "../src/integrations/auth-storage";

test("scope contracts reject cross-owner, cross-kind and unscoped mutations before publication", async () => {
  const secure = new MemorySecureStore(); const ref = secretRef("alpha", "request", "password");
  for (const scope of [{ owner: "workspace", workspaceId: "beta", kind: "credentials" }, { owner: "workspace", workspaceId: "alpha", kind: "runtime" }] as const) {
    let published = false;
    await assert.rejects(secure.commitWith({ operationId: crypto.randomUUID(), mutations: [{ ref, scope, value: "A", expectedRevision: 0 }] }, () => { published = true; }));
    assert.equal(published, false); assert.deepEqual(await secure.read(ref), { value: null, revision: 0 });
  }
  assert.deepEqual(await secure.resolve("purr/alpha/request/password"), { status: "missing", revision: 0 });
  assert.throws(() => secretProtectionScope("purr/__global__/credentials/token"));
  await assert.rejects(secure.set("purr/alpha/request/password", "must-not-adopt"), /explicit protection scope/);
});

test("runtime snapshots have independent refs and freeze the dispatched credential buffer", async () => {
  const secure = new MemorySecureStore(); const saved = secretRef("alpha", "request", "password");
  await secure.set(saved, "new-live-B");
  const auth = createRequestAuth(); auth.type = "basic"; auth.basic.password = "dispatched-A";
  auth.secretRefs = { password: saved };
  auth.credentialStates = { password: { ref: saved, status: "available", edit: { kind: "keep" } } };
  const staged = new SecretPreparationStore(secure);
  const stored = await protectRuntime(auth, staged, "alpha", "history/entry/request/auth") as typeof auth;
  const encoded = JSON.stringify(stored);
  assert.ok(!encoded.includes(saved)); assert.ok(encoded.includes("purr/alpha/runtime/history/entry/"));
  const batch = await staged.batch(); assert.equal(batch.mutations.length, 1);
  assert.deepEqual(batch.mutations[0].scope, { owner: "workspace", workspaceId: "alpha", kind: "runtime" });
  assert.equal(batch.mutations[0].value, "dispatched-A");
  await secure.commit(batch); assert.equal(await secure.get(saved), "new-live-B");
});

test("saved definitions never retain runtime refs; drafts and inactive auth use runtime scope", async () => {
  const secure = new MemorySecureStore(); const workspace = createWorkspace("Scopes", "scope-projection");
  const document = workspace.documents.find(isRequestDocument)!;
  const runtime = secretRef(workspace.id, "drafts/source", "password", "runtime"); await secure.set(runtime, "saved-A");
  document.request.auth.type = "basic"; document.request.auth.basic.password = "saved-A";
  document.request.auth.credentialStates = { password: { ref: runtime, status: "available", edit: { kind: "keep" } } };
  document.request.auth.secretRefs = { password: runtime }; document.request.auth.bearer.token = "inactive-token";
  document.saved = true; document.savedRequest = cloneRequestDraft(document.request);
  const projected = await projectWorkspace(workspace, secure);
  assert.ok(!JSON.stringify(projected.project).includes("/runtime/"));
  const password = projected.secrets.mutations.find((mutation) => mutation.scope.kind === "credentials" && mutation.value === "saved-A");
  const inactive = projected.secrets.mutations.find((mutation) => mutation.scope.kind === "runtime" && mutation.value === "inactive-token");
  assert.ok(password); assert.ok(inactive); assert.equal(await secure.get(password.ref), null, "projection remains pure");
});

test("preview envelopes bind scope, record, key identity and generation; independent scopes cannot decrypt", async () => {
  const keys = new Map<string, BrowserScopeKey>();
  const provider = async (scope: BrowserProtectionScope, create: boolean) => {
    const id = scopeIdentity(scope); const existing = keys.get(id); if (existing) return existing;
    if (!create) throw new Error("known scope key missing");
    const key = { id: crypto.randomUUID(), key: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]) };
    keys.set(id, key); return key;
  };
  const vault = new BrowserScopeCrypto(provider);
  const credentials = { owner: "workspace", workspaceId: "alpha", kind: "credentials" } as const;
  const runtime = { ...credentials, kind: "runtime" } as const;
  const other = { ...credentials, workspaceId: "beta" };
  const encrypted = await vault.seal("synthetic-A", credentials, "secret/a");
  await vault.seal("synthetic-runtime", runtime, "session"); await vault.seal("synthetic-other", other, "secret/a");
  assert.equal(new Set([...keys.values()].map((item) => item.key)).size, 3);
  assert.equal(await vault.unseal(encrypted, credentials, "secret/a"), "synthetic-A");
  await assert.rejects(vault.unseal(encrypted, runtime, "secret/a"));
  await assert.rejects(vault.unseal(encrypted, other, "secret/a"));
  await assert.rejects(vault.unseal(encrypted, credentials, "secret/b"));
  await assert.rejects(vault.unseal({ ...encrypted, scope: runtime, keyId: keys.get(scopeIdentity(runtime))!.id }, runtime, "secret/a"));
  await assert.rejects(vault.unseal({ ...encrypted, generation: 2 } as unknown as typeof encrypted, credentials, "secret/a"));
  keys.delete(scopeIdentity(credentials));
  await assert.rejects(vault.unseal(encrypted, credentials, "secret/a"), /key missing/);
  assert.equal(keys.has(scopeIdentity(credentials)), false, "decrypt must never regenerate a key");
});

test("integration OAuth config and acquired token publish atomically in distinct scopes", async () => {
  const secure = new MemorySecureStore(); const stage = new SecretPreparationStore(secure);
  const auth = createRequestAuth(); auth.type = "oauth2"; auth.oauth2.clientSecret = "synthetic-client"; auth.basic.password = "synthetic-inactive";
  auth.oauth2.token = { accessToken: "synthetic-access", tokenType: "Bearer", obtainedAt: 1 };
  await stageIntegrationCredential(stage, "alpha", "provider", "auth", JSON.stringify(auth));
  assert.equal(await secure.get(integrationCredentialRef("alpha", "provider", "auth")), null);
  const batch = await stage.batch(); assert.equal(batch.mutations.length, 2);
  assert.deepEqual(new Set(batch.mutations.map((mutation) => mutation.scope.kind)), new Set(["credentials", "runtime"]));
  await secure.commit(batch);
  const config = await secure.get(integrationCredentialRef("alpha", "provider", "auth"));
  assert.ok(config?.includes("synthetic-client")); assert.ok(!config.includes("synthetic-access")); assert.ok(!config.includes("synthetic-inactive"));
  assert.ok((await secure.get(integrationTokenRef("alpha", "provider")))?.includes("synthetic-access"));
  assert.equal(JSON.parse((await readIntegrationCredential(secure, "alpha", "provider", "auth"))!).oauth2.token.accessToken, "synthetic-access");
  auth.oauth2.clientId = "changed-client"; auth.oauth2.token = null;
  await secure.set(integrationCredentialRef("alpha", "provider", "auth"), JSON.stringify(auth));
  assert.equal(JSON.parse((await readIntegrationCredential(secure, "alpha", "provider", "auth"))!).oauth2.token, null, "tokens are bound to their configuration");
  assert.deepEqual(secretProtectionScope(integrationTokenRef("alpha", "provider")), { owner: "workspace", workspaceId: "alpha", kind: "runtime" });
});


test("canonical schema acknowledgement keeps active identity while its private copy uses runtime scope", async () => {
  const workspace = createWorkspace("Schema scopes", "schema-scopes"); const schema = createSchemaDocument(); schema.saved = true;
  schema.auth.type = "bearer"; schema.auth.bearer.token = "synthetic-schema-token";
  const oldRef = secretRef(workspace.id, "schemas/source", "bearer");
  schema.auth.credentialStates = { bearer: { ref: oldRef, status: "available", edit: { kind: "set", value: "synthetic-schema-token" } } };
  workspace.documents = [schema]; const secure = new MemorySecureStore(); const prepared = new SecretPreparationStore(secure);
  const projection = await projectWorkspace(workspace, prepared); await secure.commit(projection.secrets); prepared.acknowledge();
  const definition = projection.project.resources.find((item) => item.kind === "schema"); assert.ok(definition?.kind === "schema" && definition.auth?.type === "bearer" && definition.auth.token.kind === "secret");
  assert.equal(schema.auth.credentialStates.bearer.ref, definition.auth.token.ref);
  assert.equal(schema.auth.credentialStates.bearer.edit?.kind, "keep");
  const runtime = projection.local.find((item) => item.table === "document_session_state" && item.id === schema.id)!;
  assert.ok(JSON.stringify(runtime.value).includes(`/runtime/schema-auth/${schema.id}/`));
});


test("a valid schema cache survives credential publication while genuine credential edits stay stale", async () => {
  const workspace = createWorkspace("Schema cache", "schema-cache"); const schema = createSchemaDocument(); schema.saved = true;
  schema.endpoint = "{{HOST}}/graphql"; schema.auth.type = "bearer"; schema.auth.bearer.token = "synthetic-before-save";
  const globals = [{ id: "host", name: "HOST", kind: "static" as const, value: "https://fixture.test", enabled: true, sensitive: false }];
  schema.cacheIdentity = await schemaConnectionIdentity(schema, workspace.requestConfig, { HOST: globals[0].value });
  schema.sdl = "type Query { fixture: String }"; workspace.documents = [schema];
  const secure = new MemorySecureStore(); const staged = new SecretPreparationStore(secure);
  const projected = await projectWorkspace(workspace, staged, { globalVariables: globals });
  const before = schema.cacheIdentity; await secure.commit(projected.secrets); staged.acknowledge();
  assert.notEqual(schema.cacheIdentity, before, "publication maps literal intent to stable canonical ref identity");
  assert.equal(schema.cacheIdentity, await schemaConnectionIdentity(schema, workspace.requestConfig, { HOST: globals[0].value }));
  assert.equal((projected.local.find((row) => row.table === "schema_cache")!.value as { cacheIdentity: string }).cacheIdentity, schema.cacheIdentity);
  const valid = schema.cacheIdentity; schema.auth.bearer.token = "changed-after-fetch";
  schema.auth.credentialStates!.bearer.edit = { kind: "set", value: "changed-after-fetch" };
  const changed = new SecretPreparationStore(secure); const next = await projectWorkspace(workspace, changed, { globalVariables: globals });
  await secure.commit(next.secrets); changed.acknowledge();
  assert.equal(schema.cacheIdentity, valid, "actual edits must not bless stale schema data");
});
