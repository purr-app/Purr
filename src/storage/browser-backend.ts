import type { FileChange, LocalChange, LocalRecord, PersistenceBackend, ProjectFile, SecureStore, StorageSnapshot, StoredWorkspace } from "./contracts";
import type { SecretRef } from "../domain/project";

// Browser preview only; desktop always uses SQLite + the native secure store.
const database = () => new Promise<IDBDatabase>((resolve, reject) => {
  const open = indexedDB.open("purr-preview-v2", 1);
  open.onupgradeneeded = () => { for (const name of ["projects", "local", "secrets", "app", "keys"]) open.result.createObjectStore(name); };
  open.onsuccess = () => resolve(open.result); open.onerror = () => reject(new Error("Cannot open browser preview storage"));
});
async function read<T>(store: string, key: string): Promise<T | undefined> {
  const db = await database();
  try { return await new Promise<T | undefined>((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("Cannot read browser preview storage"));
  }); } finally { db.close(); }
}
async function keys(store: string): Promise<string[]> {
  const db = await database();
  try { return await new Promise<string[]>((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAllKeys();
    request.onsuccess = () => resolve(request.result.filter((value): value is string => typeof value === "string"));
    request.onerror = () => reject(new Error("Cannot read browser preview storage"));
  }); } finally { db.close(); }
}
async function writeMany(changes: Array<{ store: string; key: string; value?: unknown }>) {
  const db = await database();
  try { await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([...new Set(changes.map((change) => change.store))], "readwrite");
    for (const change of changes) { const store = transaction.objectStore(change.store); if (change.value === undefined) store.delete(change.key); else store.put(change.value, change.key); }
    transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(new Error("Cannot save browser preview storage"));
  }); } finally { db.close(); }
}
let keyPromise: Promise<CryptoKey> | undefined;
const key = () => keyPromise ??= (async () => {
  const existing = await read<CryptoKey>("keys", "local"); if (existing) return existing;
  const created = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await writeMany([{ store: "keys", key: "local", value: created }]); return created;
})();
async function seal(value: unknown, context: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) }, await key(), new TextEncoder().encode(JSON.stringify(value)));
  return { iv, data };
}
async function unseal<T>(value: { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer }, context: string): Promise<T> {
  try { return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: value.iv, additionalData: new TextEncoder().encode(context) }, await key(), value.data))); }
  catch { throw new Error("Cannot decrypt browser preview data"); }
}
export class BrowserSecureStore implements SecureStore {
  async get(ref: SecretRef) { const data = await read<Awaited<ReturnType<typeof seal>>>("secrets", ref); return data ? unseal<string>(data, ref) : null; }
  async set(ref: SecretRef, value: string) { await writeMany([{ store: "secrets", key: ref, value: await seal(value, ref) }]); }
  async delete(ref: SecretRef) { await writeMany([{ store: "secrets", key: ref }]); }
  async exists(ref: SecretRef) { return (await this.get(ref)) !== null; }
}
export class BrowserPersistenceBackend implements PersistenceBackend {
  async load(): Promise<StorageSnapshot> {
    const ids = await read<string[]>("app", "workspaces") ?? [];
    const raw = localStorage.getItem("purr.workspaces.v1"); let legacy: unknown;
    if (raw && !await read("app", "migrated")) {
      try { legacy = JSON.parse(raw); } catch { throw new Error("Unsupported or damaged workspace index. The original data has not been changed."); }
    }
    return { activeWorkspaceId: await read<string>("app", "active") ?? "", workspaces: await Promise.all(ids.map((id) => this.loadWorkspace(id))), global: await this.readLocal("__global__"), legacy };
  }
  async loadWorkspace(id: string): Promise<StoredWorkspace> { return { id, files: await read<Record<string, ProjectFile>>("projects", id) ?? {}, local: await this.readLocal(id) }; }
  async readLocal(id: string): Promise<LocalRecord[]> { const data = await read<Awaited<ReturnType<typeof seal>>>("local", id); return data ? unseal(data, id) : []; }
  async commit(id: string, changes: FileChange[], local: LocalChange[]) {
    const existing = await this.loadWorkspace(id); const files = { ...existing.files };
    for (const change of changes) if ((files[change.path]?.revision ?? null) !== change.expectedRevision) throw new Error("Project changed externally. Reload before saving.");
    for (const change of changes) { if (change.content === null) delete files[change.path]; else files[change.path] = { content: change.content, revision: await contentRevision(change.content) }; }
    const records = new Map(existing.local.map((record) => [`${record.table}/${record.id}`, record]));
    for (const change of local) { const key = `${change.table}/${change.id}`; if (change.value === null) records.delete(key); else records.set(key, change as LocalRecord); }
    const ids = new Set(await read<string[]>("app", "workspaces") ?? []); ids.add(id);
    await writeMany([{ store: "projects", key: id, value: files }, { store: "local", key: id, value: await seal([...records.values()], id) }, { store: "app", key: "workspaces", value: [...ids] }]);
    return files;
  }
  async saveResource(id: string, change: FileChange) { return this.commit(id, [change], []); }
  async deleteResource(id: string, path: string, expectedRevision: string) { await this.commit(id, [{ path, expectedRevision, content: null }], []); }
  async moveResource(id: string, from: string, to: string, expectedRevision: string) {
    const file = await this.reloadResource(id, from); if (!file) throw new Error("Resource does not exist");
    await this.commit(id, [{ path: from, content: null, expectedRevision }, { path: to, content: file.content, expectedRevision: null }], []);
  }
  async reloadResource(id: string, path: string) { return (await this.loadWorkspace(id)).files[path] ?? null; }
  async writeLocal(id: string, local: LocalChange[]) { await this.commit(id, [], local); }
  async setActiveWorkspace(id: string) { await writeMany([{ store: "app", key: "active", value: id }]); }
  async writeGlobal(local: LocalChange[]) { await this.writeLocal("__global__", local); }
  async deleteWorkspace(id: string) {
    const ids = (await read<string[]>("app", "workspaces") ?? []).filter((candidate) => candidate !== id);
    const prefix = `purr/${id}/`;
    const secrets = (await keys("secrets")).filter((reference) => reference.startsWith(prefix));
    await writeMany([{ store: "projects", key: id }, { store: "local", key: id }, { store: "app", key: "workspaces", value: ids },
      ...secrets.map((reference) => ({ store: "secrets", key: reference }))]);
  }
  async finishMigration() {
    const legacy = localStorage.getItem("purr.workspaces.v1");
    await writeMany([{ store: "app", key: "migrated", value: true }, ...(legacy ? [{ store: "app", key: "legacy-archive", value: await seal(legacy, "legacy") }] : [])]);
    localStorage.removeItem("purr.workspaces.v1");
  }
  async watchChanges(_listener: (id: string, paths: string[]) => void) { return () => {}; }
}
export async function contentRevision(content: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
