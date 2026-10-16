import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspacePersistence } from "../src/application/workspace-persistence";
import { MemoryPersistenceBackend } from "./helpers/memory-persistence";
import { MemorySecureStore } from "../src/storage/secrets";
import { createWorkspace, createHttpDocument, isRequestDocument } from "../src/features/workspaces/model/workspace";
import type { FileChange, LocalChange } from "../src/application/ports/persistence";
import type { SecretBatch } from "../src/application/ports/credentials";

class PublicBackend extends MemoryPersistenceBackend {
  degraded = false;
  override async loadWorkspace(id: string) {
    const snapshot = structuredClone(this.snapshot.workspaces.find((item) => item.id === id)!);
    if (this.degraded) return { ...snapshot, protectedState: { status: "unavailable" as const, code: "key-unavailable" }, unavailableLocal: [{ table: "cookie_jar" as const, id: "opaque", state: { status: "unavailable" as const, code: "key-unavailable" } }] };
    return snapshot;
  }
  override async commit(id: string, files: FileChange[], local: LocalChange[], batch?: SecretBatch) {
    if (this.degraded) {
      assert.equal(batch?.mutations.length ?? 0, 0);
      assert.ok(local.every((row) => row.protection === "plaintext"));
      assert.ok(local.every((row) => row.id !== "opaque"));
    }
    return super.commit(id, files, local, batch);
  }
}

test("public projections can restore and save with an unavailable cookie row without deleting or replacing it", async () => {
  const secure = new MemorySecureStore(); const backend = new PublicBackend(secure);
  const workspace = createWorkspace("Public", "public"); workspace.documents = [createHttpDocument()];
  const original = new WorkspacePersistence(backend, secure);
  await original.save({ activeWorkspaceId: workspace.id, workspaces: [workspace], globalVariables: [] });
  backend.degraded = true;
  secure.read = async () => { throw new Error("key unavailable"); };
  const persistence = new WorkspacePersistence(backend, secure);
  const loaded = await persistence.load();
  const restored = loaded.workspaces[0];
  assert.equal(restored.documents.length, 1, "public draft survives key outage");
  assert.equal(restored.protectedState?.status, "unavailable");
  assert.equal(persistence.getWorkspaceStatus(workspace.id).publicWritable, true);
  restored.responseStorage = "encrypted";
  const document = restored.documents[0]; assert.ok(isRequestDocument(document));
  document.request.url = "http://127.0.0.1:18765/health";
  await persistence.save(loaded);
  assert.equal((backend.snapshot.workspaces[0].local.find((row) => row.id === "state")?.value as { responseStorage: string }).responseStorage, "encrypted");
  assert.equal(persistence.getWorkspaceStatus(workspace.id).protectedState.status, "unavailable", "public save must not mark keys available");
});
