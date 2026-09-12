import type { FileChange, LocalChange, LocalRecord, PersistenceBackend, StorageSnapshot, StoredWorkspace } from "../../src/storage/contracts";
import { createHash } from "node:crypto";

export class MemoryPersistenceBackend implements PersistenceBackend {
  snapshot: StorageSnapshot = { activeWorkspaceId: "", workspaces: [] };
  writes: FileChange[] = [];
  listener?: (id: string, paths: string[]) => void;
  async load() { return structuredClone(this.snapshot); }
  async loadWorkspace(id: string) { return structuredClone(this.snapshot.workspaces.find((item) => item.id === id) ?? { id, files: {}, local: [] }); }
  async readLocal(id: string) { return (await this.loadWorkspace(id)).local; }
  async commit(id: string, files: FileChange[], local: LocalChange[]) {
    const workspace: StoredWorkspace = await this.loadWorkspace(id);
    for (const file of files) if ((workspace.files[file.path]?.revision ?? null) !== file.expectedRevision) throw new Error("External file conflict");
    for (const file of files) {
      if (file.content === null) delete workspace.files[file.path]; else workspace.files[file.path] = { content: file.content, revision: createHash("sha256").update(file.content).digest("hex") };
    }
    for (const record of local) {
      workspace.local = workspace.local.filter((item) => !(item.id === record.id && item.table === record.table));
      if (record.value !== null) workspace.local.push(record as LocalRecord);
    }
    this.snapshot.workspaces = [...this.snapshot.workspaces.filter((item) => item.id !== id), workspace]; this.writes.push(...files);
    return structuredClone(workspace.files);
  }
  async saveResource(id: string, file: FileChange) { return this.commit(id, [file], []); }
  async deleteResource(id: string, path: string, expectedRevision: string) { await this.commit(id, [{ path, content: null, expectedRevision }], []); }
  async moveResource(id: string, from: string, to: string, expectedRevision: string) {
    const file = await this.reloadResource(id, from); if (!file) throw new Error("Missing resource");
    await this.commit(id, [{ path: from, content: null, expectedRevision }, { path: to, content: file.content, expectedRevision: null }], []);
  }
  async reloadResource(id: string, path: string) { return (await this.loadWorkspace(id)).files[path] ?? null; }
  async writeLocal(id: string, local: LocalChange[]) { await this.commit(id, [], local); }
  async setActiveWorkspace(id: string) { this.snapshot.activeWorkspaceId = id; }
  async writeGlobal(local: LocalChange[]) {
    const records = new Map((this.snapshot.global ?? []).map((record) => [`${record.table}/${record.id}`, record]));
    for (const change of local) { const key = `${change.table}/${change.id}`; if (change.value === null) records.delete(key); else records.set(key, change as LocalRecord); }
    this.snapshot.global = [...records.values()];
  }
  async deleteWorkspace(id: string) { this.snapshot.workspaces = this.snapshot.workspaces.filter((workspace) => workspace.id !== id); }
  async finishMigration() { delete this.snapshot.legacy; }
  async watchChanges(listener: (id: string, paths: string[]) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
}
