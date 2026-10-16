import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspacePersistence } from "../src/application/workspace-persistence";
import { MemorySecureStore } from "../src/storage/secrets";
import { MemoryPersistenceBackend } from "./helpers/memory-persistence";
import { portableSecretRef, portableWorkspace, portableWorkspaceId } from "./fixtures/open-workspace-mock";
import type { StoredWorkspace } from "../src/application/ports/persistence";

class DirectoryBackend extends MemoryPersistenceBackend {
  inspected: string[] = [];
  opened: { directory: string; expectedRevisions: Record<string, string> }[] = [];
  constructor(readonly candidate: StoredWorkspace | null) { super(); }
  async inspectDirectory(directory: string) { this.inspected.push(directory); return structuredClone(this.candidate); }
  async openDirectory(directory: string, expectedRevisions: Record<string, string>) {
    this.opened.push({ directory, expectedRevisions });
    if (!this.candidate) throw new Error("Not a Purr workspace");
    if (!this.snapshot.workspaces.some((workspace) => workspace.id === this.candidate.id)) this.snapshot.workspaces.push(structuredClone(this.candidate));
    return structuredClone(this.candidate);
  }
}

test("opening a copied canonical folder preserves workspace identity, refs and file bytes without saving", async () => {
  const source = await portableWorkspace();
  source.files["purr.yaml"].content = "# Preserve external formatting on open\n" + source.files["purr.yaml"].content;
  const backend = new DirectoryBackend(source);
  const persistence = new WorkspacePersistence(backend, new MemorySecureStore());
  const workspace = await persistence.openDirectory("/synthetic/copied-workspace");
  assert.equal(workspace.id, portableWorkspaceId);
  assert.equal(workspace.name, "Portable workspace");
  const variable = workspace.variables.find((item) => item.name === "API_TOKEN");
  assert.ok(variable?.kind === "static");
  assert.equal(variable.secretRef, portableSecretRef);
  assert.equal(variable.value, "");
  assert.equal((await persistence.secure.inspect([portableSecretRef]))[0]?.status, "missing");
  assert.deepEqual(backend.opened, [{ directory: "/synthetic/copied-workspace", expectedRevisions: Object.fromEntries(Object.entries(source.files).map(([path, file]) => [path, file.revision])) }]);
  assert.deepEqual(backend.writes, []);
  assert.deepEqual(backend.snapshot.workspaces[0]?.files, source.files);
  assert.equal((await persistence.openDirectory("/synthetic/copied-workspace")).id, portableWorkspaceId);
  assert.equal(backend.snapshot.workspaces.length, 1);
  await persistence.saveWorkspace(workspace);
  assert.deepEqual(backend.writes, [], "ordinary autosave must not normalize untouched external YAML");
  assert.deepEqual(backend.snapshot.workspaces[0]?.files, source.files);
});

test("invalid canonical data is rejected before native registration or writes", async () => {
  const source = await portableWorkspace();
  source.files["purr.yaml"].content = "purr: 999\nworkspace: {}\n";
  const backend = new DirectoryBackend(source);
  const persistence = new WorkspacePersistence(backend, new MemorySecureStore());
  await assert.rejects(persistence.openDirectory("/synthetic/invalid"), /Invalid|unsupported/);
  assert.deepEqual(backend.opened, []);
  assert.deepEqual(backend.snapshot.workspaces, []);
  assert.deepEqual(backend.writes, []);
});

test("non-Purr sources are left for collection import without registration", async () => {
  const backend = new DirectoryBackend(null);
  const persistence = new WorkspacePersistence(backend, new MemorySecureStore());
  assert.equal(await persistence.tryOpenDirectory("/synthetic/postman.json"), null);
  assert.deepEqual(backend.opened, []);
  assert.deepEqual(backend.writes, []);
});
