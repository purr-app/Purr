import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspacePersistence } from "../src/application/workspace-persistence";
import { invalidateSecretBuffers } from "../src/application/invalidate-secret-buffers";
import { MemorySecureStore } from "../src/storage/secrets";
import { MemoryPersistenceBackend } from "./helpers/memory-persistence";
import { createWorkspace } from "../src/features/workspaces/model/workspace";

test("native transfer shares the save queue and invalidates cached values even after a lost reply", async () => {
  const secure = new MemorySecureStore();
  const backend = new MemoryPersistenceBackend(secure);
  const persistence = new WorkspacePersistence(backend, secure);
  const workspace = createWorkspace("Transfer queue", "transfer-queue");
  const state = { activeWorkspaceId: workspace.id, workspaces: [workspace], globalVariables: [] };
  await persistence.save(state);
  const reference = "purr/transfer-queue/credentials/variables/token";
  await secure.set(reference, "old");
  assert.equal(await persistence.secure.get(reference), "old");
  const events: string[] = [];
  const commit = backend.commit.bind(backend);
  backend.commit = async (...args) => { events.push("save"); return commit(...args); };
  let finish!: () => void;
  const barrier = new Promise<void>((resolve) => { finish = resolve; });
  const transfer = persistence.runSecretTransfer(async () => {
    events.push("transfer");
    await barrier;
    await secure.set(reference, "imported");
    throw new Error("Synthetic lost native reply");
  });
  const failed = assert.rejects(transfer, /lost native reply/);
  workspace.name = "Saved after transfer";
  const save = persistence.save(state);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["transfer"]);
  finish();
  await failed;
  await save;
  assert.deepEqual(events, ["transfer", "save"]);
  assert.equal(await persistence.secure.get(reference), "imported");
});

test("post-import invalidation preserves unsaved edits and invalidates only imported references", () => {
  const reference = "purr/transfer/credentials/variables/token";
  const current = {
    variables: [
      { value: "stale", secretState: { ref: reference, status: "available", edit: { kind: "keep" } } },
      { value: "new edit", secretState: { ref: reference, status: "available", edit: { kind: "set", value: "new edit" } } },
      { value: "other", secretState: { ref: "purr/transfer/credentials/variables/other", status: "available", edit: { kind: "keep" } } },
    ],
    draftUrl: "https://unsaved.example",
  };
  const result = invalidateSecretBuffers(current, reference);
  assert.equal(result.variables[0].value, "");
  assert.equal(result.variables[0].secretState.status, "unresolved");
  assert.deepEqual(result.variables.slice(1), current.variables.slice(1));
  assert.equal(result.draftUrl, current.draftUrl);
  assert.equal(current.variables[0].value, "stale");
});
