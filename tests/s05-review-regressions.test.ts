import { test } from "node:test";
import assert from "node:assert/strict";
import { projectWorkspace, restoreWorkspace } from "../src/application/project-projection";
import { protectResponseSnapshot } from "../src/application/response-snapshot";
import { MemorySecureStore, SecretPreparationStore } from "../src/storage/secrets";
import { createHttpDocument, createSchemaDocument, createWorkspace } from "../src/features/workspaces/model/workspace";
import { executeHttp } from "../src/features/request-workbench/services/http-client";

test("captured schema encryption survives workspace Off and restart without publishing SDL", async () => {
  const workspace = createWorkspace("Schema policy", "schema-policy");
  const schema = createSchemaDocument();
  Object.assign(schema, { saved: true, source: "introspection", schemaSource: { type: "introspection" }, endpoint: "https://fixture.invalid/graphql", sdl: "type Query { syntheticPrivateField: String }", pinned: false, cacheProtection: "encrypted" });
  workspace.documents = [schema];
  workspace.responseStorage = "plaintext";
  const secure = new MemorySecureStore();
  const first = await projectWorkspace(workspace, secure);
  const row = first.local.find((record) => record.table === "schema_cache")!;
  assert.equal(row.protection, "encrypted");
  assert.ok(!JSON.stringify(first.project).includes("syntheticPrivateField"));
  await secure.commit(first.secrets);
  const restored = await restoreWorkspace(first.project, first.local, secure, {});
  const second = await projectWorkspace(restored, secure);
  assert.equal(second.local.find((record) => record.table === "schema_cache")?.protection, "encrypted");
  assert.ok(!JSON.stringify(second.project).includes("syntheticPrivateField"));
  schema.cacheProtection = "plaintext";
  workspace.responseStorage = "encrypted";
  assert.equal((await projectWorkspace(workspace, secure)).local.find((record) => record.table === "schema_cache")?.protection, "plaintext", "changing the default does not rewrite old capture protection");
});

test("dynamic cache drops orphan values and retains captured sensitivity after variable changes", async () => {
  const workspace = createWorkspace("Cache provenance", "cache-provenance");
  workspace.variables = [{ id: "token", name: "token", enabled: true, sensitive: false, kind: "dynamic-request", documentId: workspace.documents[0].id, expression: "$.token", language: "jsonpath", refresh: "session", environment: { type: "current" } }];
  const common = { status: "success" as const, resolvedAt: new Date(0).toISOString(), durationMs: 1, environmentId: null, fingerprint: "synthetic" };
  workspace.dynamicVariableCache = {
    "token:none": { ...common, sensitivity: true, protection: "plaintext", value: "SYNTHETIC_CAPTURED_SECRET" },
    "deleted:none": { ...common, sensitivity: true, protection: "plaintext", value: "SYNTHETIC_ORPHAN_SECRET" },
  };
  const secure = new MemorySecureStore();
  const projection = await projectWorkspace(workspace, secure);
  const record = projection.local.find((row) => row.id === "dynamic-variable-cache")!;
  assert.ok(!JSON.stringify(record).includes("SYNTHETIC_"));
  assert.ok(!Object.hasOwn(record.value as object, "deleted:none"));
  assert.equal(record.protection, "plaintext", "sensitive value has its own SecretRef");
  assert.ok(projection.secrets.mutations.some((mutation) => mutation.value === "SYNTHETIC_CAPTURED_SECRET"));
  assert.ok(!projection.secrets.mutations.some((mutation) => mutation.value === "SYNTHETIC_ORPHAN_SECRET"));
  workspace.dynamicVariableCache["token:none"].protection = "encrypted";
  assert.equal((await projectWorkspace(workspace, secure)).local.find((row) => row.id === "dynamic-variable-cache")?.protection, "encrypted", "On-derived cache cannot become public when the current workspace default is Off");
});

test("Off response masks protocol credential headers and declared sensitive header names", async () => {
  const response = await executeHttp({ url: "https://fixture.invalid/", method: "GET", headers: [], bodyBase64: null }, {
    sensitivity: { url: false, headers: ["X-Declared-Secret"], body: false }, responseStorage: { protection: "plaintext" },
    transport: async () => ({ status: 200, statusText: "OK", durationMs: 1, bodyBase64: btoa("ordinary response"), headers: [["Authorization", "SYNTHETIC_AUTH"], ["Proxy-Authorization", "SYNTHETIC_PROXY"], ["x-declared-secret", "SYNTHETIC_DECLARED"], ["X-Public", "ordinary header"]] }),
  });
  const publicSnapshot = await protectResponseSnapshot(response, new SecretPreparationStore(new MemorySecureStore()), "review", "history/headers");
  assert.ok(!JSON.stringify(publicSnapshot).includes("SYNTHETIC_"));
  assert.ok(JSON.stringify(publicSnapshot).includes("ordinary header"));
  assert.ok(publicSnapshot.protectedSnapshot);
});


test("append-only history ownership does not stage duplicate execution secrets during workspace projection", async () => {
  const workspace = createWorkspace("History", "history-owner");
  const document = createHttpDocument();
  document.lastResponse = await executeHttp({ url: "https://fixture.invalid", method: "GET", headers: [["Authorization", "Bearer PRIVATE_WIRE"]], bodyBase64: null }, {
    responseStorage: { protection: "plaintext" },
    transport: async () => ({ status: 200, statusText: "OK", headers: [], durationMs: 1, bodyBase64: btoa("PUBLIC") }),
  });
  workspace.documents = [document];
  const projection = await projectWorkspace(workspace, new MemorySecureStore(), { includeExecutions: false });
  assert.ok(!projection.local.some((record) => record.table === "request_executions"));
  assert.ok(!projection.secrets.mutations.some((mutation) => mutation.ref.includes("/executions/")));
});
