import type { SecretBatch } from "../../src/application/ports/credentials";
import { MemorySecureStore } from "../../src/storage/secrets";
import type { FileChange, LocalChange, LocalRecord, PersistenceBackend, StorageSnapshot, StoredWorkspace } from "../../src/storage/contracts";
import { createHash } from "node:crypto";

export class MemoryPersistenceBackend implements PersistenceBackend {
  constructor(private secure = new MemorySecureStore()) {}
  snapshot: StorageSnapshot = { activeWorkspaceId: "", workspaces: [] };
  writes: FileChange[] = [];
  listener?: (id: string, paths: string[]) => void;
  async load() {
    const snapshot = structuredClone(this.snapshot);
    if (snapshot.protectedState && snapshot.protectedState.status !== "available") { snapshot.global = []; delete snapshot.legacy; }
    snapshot.workspaces = await Promise.all(snapshot.workspaces.map((workspace) => this.loadWorkspace(workspace.id)));
    return snapshot;
  }
  async retryProtectedStorage() { return this.load(); }
  async loadWorkspace(id: string) {
    const workspace = structuredClone(this.snapshot.workspaces.find((item) => item.id === id) ?? { id, files: {}, local: [] });
    const state = workspace.protectedState ?? this.snapshot.protectedState;
    if (state && state.status !== "available") { workspace.local = []; workspace.protectedState = state; }
    return workspace;
  }
  async readLocal(id: string) {
    const workspace = await this.loadWorkspace(id);
    if (workspace.protectedState && workspace.protectedState.status !== "available") throw new Error(workspace.protectedState.code);
    return workspace.local;
  }
  async commit(id: string, files: FileChange[], local: LocalChange[], batch?: SecretBatch) {
    const publish = () => {
      const state = this.snapshot.workspaces.find((workspace) => workspace.id === id)?.protectedState ?? this.snapshot.protectedState;
      if (state && state.status !== "available") throw new Error(state.code);
      if (batch?.mutations.some((mutation) => !mutation.ref.startsWith(`purr/${id}/`))) throw new Error("Secret changes must belong to the workspace");
      const workspace: StoredWorkspace = structuredClone(this.snapshot.workspaces.find((item) => item.id === id) ?? { id, files: {}, local: [] });
      for (const file of files) if ((workspace.files[file.path]?.revision ?? null) !== file.expectedRevision) throw new Error("External file conflict");
      for (const file of files) {
        if (file.content === null) delete workspace.files[file.path]; else workspace.files[file.path] = { content: file.content, revision: createHash("sha256").update(file.content).digest("hex") };
      }
      for (const record of local) {
        workspace.local = workspace.local.filter((item) => !(item.id === record.id && item.table === record.table));
        if (record.value !== null) workspace.local.push(structuredClone(record) as LocalRecord);
      }
      const nextWorkspaces = [...this.snapshot.workspaces.filter((item) => item.id !== id), workspace];
      const nextWrites = [...this.writes, ...structuredClone(files)];
      this.snapshot.workspaces = nextWorkspaces;
      this.writes = nextWrites;
    };
    if (batch) await this.secure.commitWith(batch, publish, { kind: "workspace", id, files, local }); else publish();
    return (await this.loadWorkspace(id)).files;
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
  async writeGlobal(local: LocalChange[], batch?: SecretBatch) {
    const publish = () => {
      if (this.snapshot.protectedState && this.snapshot.protectedState.status !== "available") throw new Error(this.snapshot.protectedState.code);
      if (batch?.mutations.some((mutation) => !mutation.ref.startsWith("purr/global/"))) throw new Error("Secret changes must belong to global scope");
      const records = new Map((this.snapshot.global ?? []).map((record) => [`${record.table}/${record.id}`, record]));
      for (const change of local) {
        const key = `${change.table}/${change.id}`;
        if (change.value === null) records.delete(key); else records.set(key, structuredClone(change) as LocalRecord);
      }
      this.snapshot.global = [...records.values()];
    };
    if (batch) await this.secure.commitWith(batch, publish, { kind: "global", local }); else publish();
  }
  async deleteWorkspace(id: string) {
    await this.secure.deletePrefixes([`purr/${id}/`], () => {
      const workspaces = this.snapshot.workspaces.filter((workspace) => workspace.id !== id);
      this.snapshot.workspaces = workspaces;
      if (this.snapshot.activeWorkspaceId === id) this.snapshot.activeWorkspaceId = "";
    });
  }
  async finishMigration() {
    if (this.snapshot.protectedState && this.snapshot.protectedState.status !== "available") throw new Error(this.snapshot.protectedState.code);
    delete this.snapshot.legacy;
  }
  async watchChanges(listener: (id: string, paths: string[]) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
}
