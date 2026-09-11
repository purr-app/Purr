import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SecretRef } from "../domain/project";
import type { FileChange, LocalChange, PersistenceBackend, ProjectFile, SecureStore, StorageSnapshot, StoredWorkspace } from "./contracts";
export class NativeSecureStore implements SecureStore {
  get(reference: SecretRef) { return invoke<string | null>("secure_get", { reference }); }
  set(reference: SecretRef, value: string) { return invoke<void>("secure_set", { reference, value }); }
  delete(reference: SecretRef) { return invoke<void>("secure_delete", { reference }); }
  exists(reference: SecretRef) { return invoke<boolean>("secure_exists", { reference }); }
}
export class NativePersistenceBackend implements PersistenceBackend {
  private cache = new Map<string, Record<string, ProjectFile>>();
  async load() {
    const snapshot = await invoke<StorageSnapshot>("load_persistence");
    for (const workspace of snapshot.workspaces) this.cache.set(workspace.id, workspace.files); return snapshot;
  }
  async loadWorkspace(id: string) { const workspace = await invoke<StoredWorkspace>("load_project", { id }); this.cache.set(id, workspace.files); return workspace; }
  async readLocal(id: string) { return (await this.loadWorkspace(id)).local; }
  async commit(id: string, files: FileChange[], local: LocalChange[]) {
    const changed = await invoke<Record<string, ProjectFile | null>>("commit_project", { id, files, local }); const next = { ...(this.cache.get(id) ?? {}) };
    for (const [path, file] of Object.entries(changed)) { if (file) next[path] = file; else delete next[path]; } this.cache.set(id, next); return next;
  }
  async writeLocal(id: string, local: LocalChange[]) { await this.commit(id, [], local); }
  async saveResource(id: string, change: FileChange) { return this.commit(id, [change], []); }
  async deleteResource(id: string, path: string, expectedRevision: string) { await this.commit(id, [{ path, content: null, expectedRevision }], []); }
  async moveResource(id: string, from: string, to: string, expectedRevision: string) {
    const file = await this.reloadResource(id, from); if (!file) throw new Error("Resource does not exist");
    await this.commit(id, [{ path: from, content: null, expectedRevision }, { path: to, content: file.content, expectedRevision: null }], []);
  }
  async reloadResource(id: string, path: string) {
    const file = await invoke<ProjectFile | null>("reload_project_file", { id, path });
    const files = { ...(this.cache.get(id) ?? {}) }; if (file) files[path] = file; else delete files[path];
    this.cache.set(id, files); return file;
  }
  setActiveWorkspace(id: string) { return invoke<void>("set_local_active_workspace", { id }); }
  finishMigration() { return invoke<void>("finish_legacy_migration"); }
  async watchChanges(listener: (id: string, paths: string[]) => void) { return listen<Array<{ id: string; paths: string[] }>>("project-files-changed", (event) => { for (const change of event.payload) listener(change.id, change.paths); }); }
  async attachDirectory(id: string, directory: string) { const workspace = await invoke<StoredWorkspace>("attach_project_directory", { id, directory }); this.cache.set(id, workspace.files); return workspace; }
}
