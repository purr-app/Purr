import assert from "node:assert/strict";
import test from "node:test";
import type { SecretResolution } from "../src/application/ports/credentials";
import { MemoryPersistenceBackend } from "./helpers/memory-persistence";

test("memory protected snapshots preserve opaque records through unavailable load and retry", async () => {
  const backend = new MemoryPersistenceBackend();
  backend.snapshot = { activeWorkspaceId: "workspace", protectedState: { status: "locked", code: "synthetic-locked" },
    global: [{ table: "workspace_local_state", id: "variables", value: ["synthetic-global"] }],
    workspaces: [{ id: "workspace", files: { "purr.yaml": { content: "purr: 2", revision: "one" } },
      local: [{ table: "drafts", id: "draft", value: "synthetic-private-draft" }] }] };
  const original = structuredClone(backend.snapshot);
  const unavailable = await backend.load();
  assert.deepEqual(unavailable.workspaces[0].local, []);
  assert.deepEqual(unavailable.global, []);
  assert.equal(unavailable.workspaces[0].protectedState?.status, "locked");
  await assert.rejects(backend.writeLocal("workspace", []), /synthetic-locked/);
  await assert.rejects(backend.writeGlobal([]), /synthetic-locked/);
  assert.deepEqual(backend.snapshot, original);
  backend.snapshot.protectedState = { status: "available" };
  const retried = await backend.retryProtectedStorage();
  assert.deepEqual(retried.workspaces[0].local, original.workspaces[0].local);
  assert.deepEqual(retried.global, original.global);
});

test("native adapters preserve typed resolution, hide IPC errors, and refresh canonical cache on retry", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const reference = "purr/workspace/credential";
  let result: SecretResolution = { status: "missing", revision: 3 };
  let fail = false;
  const seen: string[] = [];
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: {
      invoke: async (command: string, args?: { reference?: string }) => {
        seen.push(command);
        if (command === "secure_resolve") { assert.equal(args?.reference, reference); if (fail) throw new Error("DO_NOT_EXPOSE_PLATFORM_DETAIL"); return result; }
        if (command === "load_persistence") return { activeWorkspaceId: "workspace", workspaces: [{ id: "workspace", files: { obsolete: { content: "old", revision: "old" } }, local: [] }] };
        if (command === "retry_protected_storage") return { activeWorkspaceId: "workspace", protectedState: { status: "available" }, workspaces: [{ id: "workspace", files: {}, local: [] }] };
        if (command === "commit_project") return { current: { content: "new", revision: "new" } };
        throw new Error(`Unexpected command ${command}`);
      },
    } } });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel" } });
    const { createTauriPlatformAdapters } = await import("../src/platform/tauri/application-services");
    const { secureStore, persistenceBackend } = createTauriPlatformAdapters();
    for (const value of [
      { status: "missing", revision: 3 }, { status: "available", value: "", revision: 4 },
      { status: "denied", code: "permission-denied", retryable: true },
      { status: "corrupt", code: "credential-corrupt", retryable: false },
    ] as SecretResolution[]) { result = value; assert.deepEqual(await secureStore.resolve(reference), value); }
    fail = true;
    assert.deepEqual(await secureStore.resolve(reference), { status: "unavailable", code: "secure-resolution-unavailable", retryable: true });
    await persistenceBackend.load();
    await persistenceBackend.retryProtectedStorage!();
    const files = await persistenceBackend.commit("workspace", [], []);
    assert.deepEqual(Object.keys(files), ["current"]);
    assert.ok(seen.includes("retry_protected_storage"));
    assert.equal(seen.includes("secure_get"), false);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else delete (globalThis as { window?: unknown }).window;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else delete (globalThis as { navigator?: unknown }).navigator;
  }
});
