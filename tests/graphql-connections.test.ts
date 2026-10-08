import { test } from "node:test";
import assert from "node:assert/strict";
import { bindGraphqlSchema, createGraphqlDocument, createSchemaDocument, createWorkspace, defaultGraphqlSchema, deleteDocument, detachGraphqlSchema, migrateSchemaConnections, openDocument, validateWorkspace } from "../src/features/workspaces/model/workspace";
import { applyWorkspaceRequestConfig, createWorkspaceRequestConfig, snapshotSchemaRequest, withSchemaAuthContext } from "../src/features/request-workbench/model/request-workspace-config";
import { createRequestAuth, getAuthBinding, resolveAuth } from "../src/features/request-workbench/model/request-auth";
import { effectiveDynamicRequest } from "../src/features/workspaces/services/dynamic-variable-resolver";
import { schemaConnectionIdentity, schemaConnectionStatus } from "../src/features/graphql/model/schema-connection";
import { projectWorkspace, restoreWorkspace } from "../src/application/project-projection";
import { MemorySecureStore } from "../src/storage/secrets";
import { deserializeResource, serializeResource } from "../src/storage/yaml";

function fixture() {
  const connection = createSchemaDocument();
  connection.saved = true; connection.endpoint = "https://api.example/graphql";
  connection.auth.type = "bearer"; connection.auth.bearer.token = "connection-private-token";
  const request = createGraphqlDocument();
  request.request = bindGraphqlSchema(request.request, connection, true) as typeof request.request;
  const config = { ...createWorkspaceRequestConfig(), schemaConnections: [connection] };
  return { connection, request, config };
}

test("default schema precedes last-used and missing references fall back safely", () => {
  const workspace = createWorkspace(); const first = createSchemaDocument(); const second = createSchemaDocument();
  workspace.documents.push(first, second); workspace.ui.lastGraphqlSchemaId = second.id;
  assert.equal(defaultGraphqlSchema(workspace)?.id, second.id);
  workspace.defaultGraphqlSchemaId = first.id; assert.equal(defaultGraphqlSchema(workspace)?.id, first.id);
  workspace.defaultGraphqlSchemaId = "missing"; assert.equal(defaultGraphqlSchema(workspace)?.id, second.id);
  workspace.ui.lastGraphqlSchemaId = "missing"; assert.equal(defaultGraphqlSchema(workspace), undefined);
  assert.equal(defaultGraphqlSchema(openDocument(workspace, first.id))?.id, first.id);
});

test("bound requests resolve live endpoint/auth across execution, dependencies and snapshots", () => {
  const { connection, request, config } = fixture();
  connection.endpoint = "https://api.example/v2/graphql?tenant=one";
  request.request.params = [{ id: "other", key: "tenant", value: "bypass", enabled: true }];
  const effective = applyWorkspaceRequestConfig(request.request, "graphql", config);
  assert.equal(effective.url, connection.endpoint);
  assert.equal(effective.params[0].value, "one");
  const context = withSchemaAuthContext(request.request, config, {});
  assert.equal(getAuthBinding(effective.auth, context).binding?.value, "Bearer connection-private-token");
  const dependency = effectiveDynamicRequest(request, config);
  assert.equal(dependency.url, connection.endpoint); assert.equal(dependency.auth.bearer.token, connection.auth.bearer.token);
  const snapshot = snapshotSchemaRequest(request.request, config, context);
  connection.endpoint = "https://changed.example/graphql"; connection.auth.bearer.token = "new";
  assert.equal(snapshot.url, "https://api.example/v2/graphql?tenant=one");
  assert.equal(snapshot.auth.bearer.token, "connection-private-token"); assert.equal(snapshot.graphql?.schemaId, undefined);
});

test("request auth including None overrides connection and workspace defaults", () => {
  const { connection, request, config } = fixture();
  const workspaceAuth = createRequestAuth(); workspaceAuth.type = "basic"; workspaceAuth.basic = { username: "workspace", password: "workspace-password" };
  config.auth.push({ id: "workspace-auth", name: "Workspace", enabled: true, scope: "graphql", value: workspaceAuth });
  request.request.auth = createRequestAuth();
  assert.equal(applyWorkspaceRequestConfig(request.request, "graphql", config).auth.type, "none");
  request.request.auth.type = "bearer"; request.request.auth.bearer.token = "own";
  assert.equal(effectiveDynamicRequest(request, config).auth.bearer.token, "own");
  connection.auth = { ...createRequestAuth(), type: "inherit", inherit: { source: "workspace", profileId: "workspace-auth" } };
  request.request = bindGraphqlSchema(request.request, connection, true) as typeof request.request;
  assert.equal(effectiveDynamicRequest(request, config).auth.basic.username, "workspace");
});

test("detach and deletion materialize settings while preserving saved and dirty operations", () => {
  const { connection, request } = fixture();
  request.saved = true; request.savedRequest = structuredClone(request.request);
  request.request.graphql.query = "query Dirty { ping }";
  request.savedRequest.graphql!.query = "query Saved { ping }";
  connection.endpoint = "https://updated.example/graphql";
  connection.auth.secretRefs = { bearer: "purr/workspace/schemas/connection/bearer" };
  const detached = detachGraphqlSchema(request.request, connection);
  assert.equal(detached.url, connection.endpoint); assert.equal(detached.auth.type, "bearer");
  assert.equal(detached.auth.secretRefs, undefined); // independent owner on the next projection
  const workspace = createWorkspace(); workspace.documents = [request, connection]; workspace.defaultGraphqlSchemaId = connection.id; workspace.ui.lastGraphqlSchemaId = connection.id;
  const deleted = deleteDocument(workspace, connection.id); const result = deleted.documents[0];
  assert.ok(result.kind === "graphql"); assert.equal(result.request.graphql?.query, "query Dirty { ping }");
  assert.equal(result.savedRequest?.graphql?.query, "query Saved { ping }");
  assert.equal(result.savedRequest?.url, connection.endpoint); assert.equal(result.savedRequest?.graphql?.schemaId, undefined);
  assert.equal(deleted.defaultGraphqlSchemaId, undefined); assert.equal(deleted.ui.lastGraphqlSchemaId, undefined);
});

test("connection cache freshness tracks settings and environment but ignores rotating OAuth tokens", async () => {
  const { connection, config } = fixture();
  connection.sdl = "type Query { ping: String }";
  connection.endpoint = "{{base}}/graphql";
  const variables = { base: "https://api.example" };
  const identity = await schemaConnectionIdentity(connection, config, variables, "prod");
  connection.cacheIdentity = identity;
  assert.equal(schemaConnectionStatus(connection, identity), "Loaded");
  assert.equal(schemaConnectionStatus(connection, await schemaConnectionIdentity(connection, config, { base: "https://other.example" }, "prod")), "Stale");
  assert.notEqual(identity, await schemaConnectionIdentity(connection, config, variables, "stage"));
  connection.auth.bearer.token = "new"; assert.notEqual(identity, await schemaConnectionIdentity(connection, config, variables, "prod"));
  connection.auth.type = "oauth2";
  const oauthIdentity = await schemaConnectionIdentity(connection, config, variables);
  connection.auth.oauth2.token = { accessToken: "rotated", obtainedAt: 1, tokenType: "Bearer" };
  assert.equal(oauthIdentity, await schemaConnectionIdentity(connection, config, variables));
  connection.fetchStatus = "loading"; assert.equal(schemaConnectionStatus(connection), "Loading");
  connection.fetchStatus = "error"; assert.equal(schemaConnectionStatus(connection), "Error");
});

test("canonical connection config and protected runtime survive reload without leaking secrets", async () => {
  const { connection, request } = fixture(); const workspace = createWorkspace();
  workspace.defaultGraphqlSchemaId = connection.id; workspace.ui.lastGraphqlSchemaId = connection.id;
  connection.introspectionHeaders = [{ id: "tenant", name: "X-Tenant", value: "public", enabled: true }, { id: "key", name: "X-Api-Key", value: "header-private", enabled: false }];
  connection.sdl = "type Query { ping: String }"; connection.loadedAt = "2026-01-01T00:00:00.000Z"; connection.cacheIdentity = "cached-context";
  connection.auth.basic.password = "inactive-password";
  connection.auth.oauth2.token = { accessToken: "oauth-private", refreshToken: "refresh-private", obtainedAt: 1, tokenType: "Bearer" };
  request.saved = true; request.savedRequest = structuredClone(request.request);
  workspace.documents = [connection, request];
  const secure = new MemorySecureStore(); const projected = await projectWorkspace(workspace, secure);
  for (const secret of ["connection-private-token", "header-private", "inactive-password", "oauth-private", "refresh-private"]) assert.equal(JSON.stringify(projected).includes(secret), false);
  const definition = projected.project.resources.find((item) => item.kind === "schema")!;
  assert.deepEqual(deserializeResource(serializeResource(definition, `schemas/${connection.id}.graphql`), () => connection.sdl), definition);
  const restored = await restoreWorkspace(projected.project, projected.local, secure, projected.assets);
  const result = restored.documents.find((item) => item.kind === "schema")!;
  assert.equal(result.auth.bearer.token, "connection-private-token"); assert.equal(result.auth.basic.password, "inactive-password");
  assert.equal(result.auth.oauth2.token?.accessToken, "oauth-private");
  assert.equal(result.introspectionHeaders[1].value, "header-private"); assert.equal(result.introspectionHeaders[1].enabled, false);
  assert.equal(result.loadedAt, connection.loadedAt); assert.equal(result.cacheIdentity, "cached-context");
  assert.equal(restored.defaultGraphqlSchemaId, connection.id); assert.equal(restored.ui.lastGraphqlSchemaId, connection.id);
  assert.equal(restored.documents.find((item) => item.kind === "graphql")?.request.auth.inherit.source, "schema");
});

test("unsaved connection auth and headers are protected and settings persist without a fetched schema", async () => {
  const { connection } = fixture(); const workspace = createWorkspace(); const secure = new MemorySecureStore();
  connection.saved = false; connection.introspectionHeaders = [{ id: "key", name: "Authorization", value: "header-private", enabled: true }]; workspace.documents = [connection];
  let projected = await projectWorkspace(workspace, secure); assert.equal(JSON.stringify(projected).includes("header-private"), false);
  let restored = await restoreWorkspace(projected.project, projected.local, secure, projected.assets);
  assert.equal(restored.documents[0].kind === "schema" && restored.documents[0].auth.bearer.token, "connection-private-token");
  connection.saved = true; projected = await projectWorkspace(workspace, secure); restored = await restoreWorkspace(projected.project, projected.local, secure, projected.assets);
  assert.equal(restored.documents[0].saved, true); assert.equal(restored.documents[0].kind === "schema" && restored.documents[0].sdl, "");
});

test("legacy schemas migrate once, retain credentials and detach mismatched requests", () => {
  const { connection, request } = fixture(); const other = createGraphqlDocument(); other.request.url = "https://other.example/graphql"; other.request.graphql.schemaId = connection.id;
  delete connection.connectionVersion; connection.sourceRequestId = request.id;
  request.request.auth.type = "basic"; request.request.auth.basic.password = "legacy";
  const workspace = createWorkspace(); workspace.documents = [connection, request, other];
  const migrated = migrateSchemaConnections(workspace); const schema = migrated.documents[0];
  assert.ok(schema.kind === "schema"); assert.equal(schema.auth.basic.password, "legacy"); assert.equal(schema.sourceRequestId, "");
  const independent = migrated.documents[2]; assert.ok(independent.kind === "graphql"); assert.equal(independent.request.url, other.request.url); assert.equal(independent.request.graphql?.schemaId, undefined);
  assert.deepEqual(migrateSchemaConnections(migrated), migrated);
  const missing = structuredClone(workspace); missing.documents = [request];
  assert.doesNotThrow(() => validateWorkspace(missing));
});

test("connection settings cannot form an authentication inheritance cycle silently", () => {
  const { connection, request, config } = fixture(); connection.auth = { ...connection.auth, type: "inherit", inherit: { source: "schema" } };
  assert.match(resolveAuth(request.request.auth, withSchemaAuthContext(request.request, config, {})).error ?? "", /cycle/);
});

test("damaged or unknown schema cache and auth runtime do not prevent opening a workspace", async () => {
  const { connection } = fixture(); const workspace = createWorkspace(); workspace.documents = [connection];
  connection.pinned = false; const secure = new MemorySecureStore(); const projected = await projectWorkspace(workspace, secure);
  for (const value of [{ version: 2, sdl: 12 }, { version: 99, sdl: "bad" }, null]) {
    const local = projected.local.map((record) => record.table === "schema_cache" ? { ...record, value } : record.table === "document_session_state" ? { ...record, value: { ...(record.value as object), auth: { oauth2: 42 } } } : record);
    const restored = await restoreWorkspace(projected.project, local, secure, projected.assets);
    const schema = restored.documents[0]; assert.ok(schema.kind === "schema"); assert.equal(schema.sdl, ""); assert.equal(schema.auth.bearer.token, "connection-private-token");
  }
});

test("detaching creates independent credential owners and introspection headers never enter operations", async () => {
  const { connection, request, config } = fixture(); const workspace = createWorkspace(); const secure = new MemorySecureStore();
  connection.introspectionHeaders = [{ id: "private", name: "X-Api-Key", value: "introspection-only", enabled: true }];
  assert.equal(applyWorkspaceRequestConfig(request.request, "graphql", config).headers.some((item) => item.value === "introspection-only"), false);
  request.request = detachGraphqlSchema(request.request, connection) as typeof request.request;
  request.saved = true; request.savedRequest = structuredClone(request.request); workspace.documents = [request, connection];
  let projected = await projectWorkspace(workspace, secure);
  const restored = await restoreWorkspace(projected.project, projected.local, secure, projected.assets);
  const restoredRequest = restored.documents.find((item) => item.kind === "graphql")!;
  restoredRequest.request.auth.bearer.token = "request-only-change"; restoredRequest.savedRequest = structuredClone(restoredRequest.request);
  projected = await projectWorkspace(restored, secure);
  const again = await restoreWorkspace(projected.project, projected.local, secure, projected.assets);
  assert.equal(again.documents.find((item) => item.kind === "schema")?.auth.bearer.token, "connection-private-token");
});
