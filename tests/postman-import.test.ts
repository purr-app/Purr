import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspacePersistence } from "../src/application/workspace-persistence";
import { importEnvironment } from "../src/application/import-environment";
import { importWorkspace } from "../src/application/import-workspace";
import { persistImport } from "../src/application/import-project";
import { MemoryPersistenceBackend } from "./helpers/memory-persistence";
import { MemorySecureStore } from "../src/storage/secrets";
import { createWorkspace, getEffectiveVariableValues, getVariableNamespace, validateWorkspace, cloneRequestDraft, isRequestDocument } from "../src/features/workspaces/model/workspace";
import { resolveDynamicVariables } from "../src/features/workspaces/services/dynamic-variable-resolver";
import { validateProject } from "../src/domain/project";
import { projectWorkspace } from "../src/application/project-projection";
import type { NormalizedImportResult } from "../src/importing/contracts";
import type { ImportPort } from "../src/application/ports/platform";

const source = { kind: "text" as const, name: "environment.json", content: "{}" };
const staticVariable = (id: string, name: string, value: string, enabled = true) => ({ id, name, value, enabled, kind: "static" as const, sensitive: false });
function environmentResult(workspaceId: string, id = "imported-env"): NormalizedImportResult {
  const ref = `purr/${workspaceId}/imports/postman/${id}`;
  return { adapter: "postman-environment", workspace: { id: workspaceId, name: "Foreign name", headers: [], auth: [], variables: [] },
    resources: [{ id, name: "Local", kind: "environment", variables: [staticVariable(`${id}-url`, "baseUrl", "https://environment.test"),
      staticVariable(`${id}-disabled`, "disabled", "off", false), { id: `${id}-secret`, name: "token", kind: "static", sensitive: true, enabled: true, secretRef: ref }] }],
    secrets: [{ ref, value: "private-test-token" }], diagnostics: [] };
}
async function setup() {
  const backend = new MemoryPersistenceBackend(); const secure = new MemorySecureStore(); const persistence = new WorkspacePersistence(backend, secure);
  const workspace = createWorkspace("Original", "project");
  workspace.variables = [staticVariable("workspace-url", "baseUrl", "https://workspace.test")];
  workspace.environments = [{ id: "old-env", name: "Local", variables: [] }];
  workspace.activeEnvironmentId = "old-env";
  const document = workspace.documents[0]; assert.ok(isRequestDocument(document));
  document.saved = true; document.request.url = "https://saved.test"; document.savedRequest = cloneRequestDraft(document.request);
  document.request.url = "https://draft.test";
  await persistence.save({ activeWorkspaceId: workspace.id, workspaces: [workspace], globalVariables: [] });
  return { backend, secure, persistence, workspace };
}

test("environment import is additive, renames collisions, preserves runtime and persists vault-only secrets", async () => {
  const { backend, secure, persistence, workspace } = await setup();
  const importer: ImportPort = { normalize: async (_source, workspaceId, target) => {
    assert.equal(target, "environment"); return environmentResult(workspaceId);
  } };
  const result = await importEnvironment(source, workspace, [], persistence, importer);
  assert.equal(result.workspace.name, "Original"); assert.equal(result.workspace.activeEnvironmentId, "old-env");
  assert.deepEqual(result.workspace.documents, workspace.documents); assert.deepEqual(result.workspace.ui, workspace.ui);
  assert.equal(result.workspace.environments[1].name, "Local (2)");
  assert.equal(result.report.counts.variables, 3); assert.equal(result.report.counts.secrets, 1);
  assert.equal(result.report.diagnostics[0].code, "duplicate-name");
  assert.equal(await secure.get("purr/project/imports/postman/imported-env"), "private-test-token");
  assert.ok(!JSON.stringify(backend.snapshot).includes("private-test-token"));
  const restored = (await new WorkspacePersistence(backend, secure).load()).workspaces[0];
  assert.equal(restored.environments.length, 2); assert.deepEqual(restored.ui, workspace.ui);
  assert.ok(isRequestDocument(restored.documents[0])); assert.equal(restored.documents[0].request.url, "https://draft.test");
  assert.equal(restored.documents[0].savedRequest?.url, "https://saved.test");
  assert.equal(getEffectiveVariableValues(restored, [], result.environmentId).baseUrl, "https://environment.test");
  const again = await importEnvironment(source, result.workspace, [], persistence, { normalize: async () => environmentResult("project", "second-env") });
  assert.equal(again.workspace.environments[2].name, "Local (3)");
});

test("environment overrides survive projection and disabled values fall back to workspace", async () => {
  const { workspace, secure } = await setup();
  workspace.environments[0].variables = [staticVariable("environment-url", "baseUrl", "https://env.test")];
  assert.doesNotThrow(() => validateWorkspace(workspace));
  const projected = await projectWorkspace(workspace, secure); assert.doesNotThrow(() => validateProject(projected.project));
  assert.equal(getEffectiveVariableValues(workspace, []).baseUrl, "https://env.test");
  workspace.environments[0].variables[0].enabled = false;
  assert.equal(getEffectiveVariableValues(workspace, []).baseUrl, "https://workspace.test");
  workspace.environments[0].variables.push(staticVariable("duplicate", "baseUrl", "bad"));
  assert.throws(() => validateWorkspace(workspace), /unique inside their scope/);
});

test("environment import rejects wrong targets, Global collisions and duplicate variables before commit", async () => {
  const { backend, persistence, workspace } = await setup(); const before = structuredClone(backend.snapshot);
  const importer: ImportPort = { normalize: async () => environmentResult("project") };
  await assert.rejects(importEnvironment(source, workspace, [staticVariable("global", "baseUrl", "global")], persistence, importer), /Global/);
  const malformed = environmentResult("project"); const env = malformed.resources[0]; assert.equal(env.kind, "environment");
  if (env.kind === "environment") env.variables.push({ ...env.variables[0], id: "duplicate" });
  await assert.rejects(importEnvironment(source, workspace, [], persistence, { normalize: async () => malformed }), /Duplicate environment variable/);
  await assert.rejects(importEnvironment(source, workspace, [], persistence, { normalize: async () => ({ ...environmentResult("project"), resources: [] }) }), /environment export/);
  assert.deepEqual(backend.snapshot, before);
});

test("failed commit rolls back new credentials and leaves the existing workspace intact", async () => {
  const { backend, persistence, secure, workspace } = await setup(); const before = structuredClone(backend.snapshot);
  backend.commit = async () => { throw new Error("Simulated revision conflict"); };
  await assert.rejects(importEnvironment(source, workspace, [], persistence, { normalize: async () => environmentResult("project") }), /revision conflict/);
  assert.equal(await secure.exists("purr/project/imports/postman/imported-env"), false);
  assert.deepEqual(backend.snapshot, before);
});

test("failed secret writes roll back earlier values and existing refs cannot be overwritten", async () => {
  const { persistence, secure } = await setup();
  const result = environmentResult("project");
  result.secrets.push({ ref: "purr/project/imports/postman/failing", value: "second" });
  const originalSet = secure.set.bind(secure);
  secure.set = async (ref, value) => { if (ref.endsWith("failing")) throw new Error("Vault unavailable"); await originalSet(ref, value); };
  await assert.rejects(persistImport({ ...result, resources: [] }, persistence), /Vault unavailable/);
  assert.equal(await secure.exists(result.secrets[0].ref), false);
  await originalSet(result.secrets[0].ref, "existing-secret"); persistence.secure.clear();
  await assert.rejects(persistImport({ ...result, resources: [] }, persistence), /overwrite/);
  assert.equal(await secure.get(result.secrets[0].ref), "existing-secret");
});

test("workspace imports return a report after saving and propagate diagnostics", async () => {
  const backend = new MemoryPersistenceBackend(); const persistence = new WorkspacePersistence(backend, new MemorySecureStore());
  const result = await importWorkspace(source, persistence, { normalize: async (_source, id) => ({
    workspace: { id, name: "Imported", headers: [], auth: [], variables: [] }, resources: [], secrets: [], adapter: "postman-collection",
    diagnostics: [{ severity: "warning", code: "unsupported-script", message: "Script omitted", sourcePath: "#/event/0" }],
  }) });
  assert.equal(result.workspace.name, "Imported"); assert.equal(result.report.diagnostics.length, 1);
  assert.equal(backend.snapshot.workspaces.length, 1);
});


test("request resolution uses the same environment precedence, fallback and disabled diagnostics as the UI", async () => {
  const { workspace } = await setup();
  workspace.environments[0].variables = [staticVariable("environment-url", "baseUrl", "https://env.test")];
  const root = workspace.documents[0]; assert.ok(isRequestDocument(root)); root.request.url = "{{baseUrl}}/users";
  const resolve = (id: string | null) => resolveDynamicVariables({ root, environmentId: id, documents: [root],
    variablesForEnvironment: async (environmentId) => getVariableNamespace(workspace, [], environmentId),
    persistentCache: {}, sessionCache: new Map(), execute: async () => { throw new Error("Static variables must not execute dependencies"); } });
  assert.equal((await resolve("old-env")).values.baseUrl, "https://env.test");
  assert.equal((await resolve(null)).values.baseUrl, "https://workspace.test");
  workspace.environments[0].variables[0].enabled = false;
  assert.equal((await resolve("old-env")).values.baseUrl, "https://workspace.test");
  workspace.variables[0].enabled = false;
  await assert.rejects(resolve("old-env"), /disabled/);
});
