import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspacePersistence } from "../src/application/workspace-persistence";
import { createWorkspace } from "../src/features/workspaces/model/workspace";
import { createRequestAuth } from "../src/features/request-workbench/model/request-auth";
import { MemorySecureStore, protectRuntime } from "../src/storage/secrets";
import { MemoryPersistenceBackend } from "./helpers/memory-persistence";
import { deserializeManifest, serializeManifest } from "../src/storage/yaml";
import { resolveSecretField } from "../src/application/resolve-request-secrets";

async function fixture() {
  const workspace = createWorkspace("Auth migration", "auth-migration");
  const bearer = createRequestAuth(); bearer.type = "bearer";
  bearer.bearer.token = "saved-bearer";
  const oauth = createRequestAuth(); oauth.type = "oauth2";
  oauth.oauth2.clientId = "client"; oauth.oauth2.clientSecret = "client-secret";
  oauth.oauth2.tokenUrl = "https://example.com/token";
  oauth.oauth2.token = { accessToken: "access-token", refreshToken: "refresh-token", tokenType: "Bearer", obtainedAt: 1 };
  workspace.requestConfig.auth = [
    { id: "http-auth", name: "HTTP", scope: "http", enabled: true, value: bearer },
    { id: "gql-auth", name: "GraphQL", scope: "graphql", enabled: true, value: oauth },
  ];
  const secure = new MemorySecureStore(); const backend = new MemoryPersistenceBackend(secure);
  await new WorkspacePersistence(backend, secure).save({ activeWorkspaceId: workspace.id, workspaces: [workspace] });
  return { workspace, backend, secure };
}

test("pre-canonical auth runtime is discarded without losing saved credentials or project data", async () => {
  const { workspace, backend, secure } = await fixture();
  const files = structuredClone(backend.snapshot.workspaces[0].files);
  await backend.writeLocal(workspace.id, [{ table: "workspace_local_state", id: "auth-runtime",
    value: await protectRuntime(workspace.requestConfig.auth, secure, workspace.id, "auth-runtime") }]);
  const persistence = new WorkspacePersistence(backend, secure); const restored = await persistence.load();
  const auth = restored.workspaces[0].requestConfig.auth;
  assert.equal(auth[0].value.bearer.token, "");
  assert.equal(await resolveSecretField(auth[0].value.bearer.token, auth[0].value.credentialStates?.bearer, secure), "saved-bearer");
  assert.equal(await resolveSecretField(auth[1].value.oauth2.clientSecret, auth[1].value.credentialStates?.["client-secret"], secure), "client-secret");
  assert.equal(auth[1].value.oauth2.token, null);
  assert.equal(restored.workspaces[0].documents[0].id, workspace.documents[0].id);
  assert.equal(persistence.getWorkspaceStatus(workspace.id).protectedState.status, "available");
  const migrated = backend.snapshot.workspaces[0].local.find((record) => record.id === "auth-runtime")?.value as { version: number; entries: unknown[] };
  assert.equal(migrated.version, 1); assert.deepEqual(migrated.entries, []);
  assert.deepEqual(backend.snapshot.workspaces[0].files, files);
  const local = JSON.stringify(backend.snapshot.workspaces[0].local);
  for (const value of ["saved-bearer", "client-secret", "access-token", "refresh-token"]) assert.ok(!local.includes(`"${value}"`));
  const reloaded = await new WorkspacePersistence(backend, secure).load();
  const reloadedAuth = reloaded.workspaces[0].requestConfig.auth[0].value;
  assert.equal(await resolveSecretField(reloadedAuth.bearer.token, reloadedAuth.credentialStates?.bearer, secure), "saved-bearer");
});

test("an intermediate unversioned auth envelope is replaced by canonical empty runtime", async () => {
  const { workspace, backend, secure } = await fixture();
  const definitions = deserializeManifest(backend.snapshot.workspaces[0].files["purr.yaml"].content).auth;
  await backend.writeLocal(workspace.id, [{ table: "workspace_local_state", id: "auth-runtime",
    value: await protectRuntime({ definitions, entries: workspace.requestConfig.auth }, secure, workspace.id, "auth-runtime") }]);
  const persistence = new WorkspacePersistence(backend, secure); const restored = await persistence.load();
  assert.equal(restored.workspaces[0].requestConfig.auth[1].value.oauth2.token, null);
  assert.equal(persistence.getWorkspaceStatus(workspace.id).protectedState.status, "available");
  assert.deepEqual(backend.snapshot.workspaces[0].local.find((record) => record.id === "auth-runtime")?.value, { version: 1, entries: [] });
});

test("discarded runtime tokens are not reused after canonical auth configuration changes", async () => {
  const { workspace, backend, secure } = await fixture();
  await backend.writeLocal(workspace.id, [{ table: "workspace_local_state", id: "auth-runtime",
    value: await protectRuntime(workspace.requestConfig.auth, secure, workspace.id, "auth-runtime") }]);
  const file = backend.snapshot.workspaces[0].files["purr.yaml"];
  const manifest = deserializeManifest(file.content); const config = manifest.auth[1].config;
  assert.ok(config.type === "oauth2"); config.clientId = "different-client";
  await backend.saveResource(workspace.id, { path: "purr.yaml", content: serializeManifest(manifest), expectedRevision: file.revision });
  const restored = await new WorkspacePersistence(backend, secure).load();
  assert.equal(restored.workspaces[0].requestConfig.auth[1].value.oauth2.clientId, "different-client");
  assert.equal(restored.workspaces[0].requestConfig.auth[1].value.oauth2.token, null);
});

test("missing and empty pre-migration auth runtime do not prevent configured workspaces from loading", async () => {
  for (const value of [null, []]) {
    const { workspace, backend, secure } = await fixture();
    await backend.writeLocal(workspace.id, [{ table: "workspace_local_state", id: "auth-runtime", value }]);
    const restored = await new WorkspacePersistence(backend, secure).load();
    const auth = restored.workspaces[0].requestConfig.auth[0].value;
    assert.equal(await resolveSecretField(auth.bearer.token, auth.credentialStates?.bearer, secure), "saved-bearer");
  }
});

test("malformed or future auth runtime remains opaque while canonical project data opens read-only", async () => {
  for (const value of [{ entries: {}, definitions: [] }, { entries: [], definitions: {} }, { version: 99, entries: [], definitions: [] },
    { version: 1, entries: [{ id: "http-auth", definitionHash: "hash", unknownToken: { kind: "secret", ref: "purr/another-workspace/credentials/token" } }] }]) {
    const { workspace, backend, secure } = await fixture();
    await backend.writeLocal(workspace.id, [{ table: "workspace_local_state", id: "auth-runtime", value }]);
    const files = structuredClone(backend.snapshot.workspaces[0].files);
    const local = structuredClone(backend.snapshot.workspaces[0].local);
    const persistence = new WorkspacePersistence(backend, secure); const restored = await persistence.load();
    const auth = restored.workspaces[0].requestConfig.auth[0].value;
    assert.equal(await resolveSecretField(auth.bearer.token, auth.credentialStates?.bearer, secure), "saved-bearer");
    assert.equal(persistence.getWorkspaceStatus(workspace.id).protectedState.status, "corrupt");
    await persistence.save(restored);
    await assert.rejects(persistence.saveWorkspace(restored.workspaces[0]), /protected|corrupt|read.only/i);
    assert.deepEqual(backend.snapshot.workspaces[0].files, files);
    assert.deepEqual(backend.snapshot.workspaces[0].local, local);
  }
});
