import assert from "node:assert/strict";
import test from "node:test";
import { WorkspacePersistence } from "../src/application/workspace-persistence";
import { validateProject, workspaceDefinitionSchema } from "../src/domain/project";
import { MemorySecureStore } from "../src/storage/secrets";
import { MemoryPersistenceBackend } from "./helpers/memory-persistence";

test("unavailable global storage preserves its records while workspace edits remain writable", async () => {
  const secure = new MemorySecureStore();
  const backend = new MemoryPersistenceBackend(secure);
  const global = [{ table: "workspace_local_state", id: "variables", value: "opaque-unreadable-original" }];
  backend.snapshot = { activeWorkspaceId: "", workspaces: [], global,
    globalProtectedState: { status: "corrupt", code: "global-scope-unavailable" },
    storageNotice: { legacyDirectory: "/synthetic/old-profile" } };
  let globalWrites = 0;
  backend.writeGlobal = async () => { globalWrites++; throw new Error("Must not overwrite unavailable globals"); };
  const persistence = new WorkspacePersistence(backend, secure);
  const store = await persistence.load();
  assert.equal(persistence.getGlobalProtectedState().status, "corrupt");
  assert.deepEqual(persistence.getStorageNotice(), backend.snapshot.storageNotice);
  assert.deepEqual(store.globalVariables, []);
  store.workspaces[0].name = "Still writable";
  await persistence.save(store);
  assert.ok(backend.snapshot.workspaces[0].files["purr.yaml"].content.includes("Still writable"));
  assert.equal(globalWrites, 0);
  assert.deepEqual(backend.snapshot.global, global);
  await assert.rejects(persistence.setSecretValue(store.workspaces[0], "purr/global/credentials/variables/token", "replacement"), /Global protected storage is unavailable/);
});

test("canonical workspaces reject reserved owners and runtime credential references", () => {
  for (const id of ["global", "__global__"]) assert.equal(workspaceDefinitionSchema.safeParse({ id, name: "Reserved" }).success, false);
  const workspace = workspaceDefinitionSchema.parse({ id: "alpha", name: "Alpha", variables: [
    { id: "token", kind: "static", name: "TOKEN", enabled: true, sensitive: true, secretRef: "purr/alpha/runtime/variables/token" },
  ] });
  assert.throws(() => validateProject({ workspace, resources: [] }), /runtime secrets/);
  workspace.variables[0] = { ...workspace.variables[0], secretRef: "purr/alpha/credentials/variables/token" } as typeof workspace.variables[0];
  assert.doesNotThrow(() => validateProject({ workspace, resources: [] }));
});
