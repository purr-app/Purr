import type { CommitState, SecretBatch, SecretResolution, SecretSnapshot, SecureStore } from "../application/ports/credentials";
import type { FileChange, LocalChange, LocalRecord, PersistencePort, ProjectFile, ProtectedState, StorageSnapshot, StoredWorkspace } from "../application/ports/persistence";
import { secretRefSchema, type SecretRef } from "../domain/project";
import { secretProtectionScope, validateSecretScope } from "./secrets";
import { BrowserProtectedError, BrowserScopeCrypto, scopeIdentity, type BrowserProtectionScope, type BrowserScopeKey, type BrowserEnvelope } from "./browser-crypto";
import { BrowserHistory } from "./browser-history";

const storageFailure = () => new BrowserProtectedError("unavailable", "browser-storage-unavailable");
const protectedFailure = (error: unknown): ProtectedState => error instanceof BrowserProtectedError
  ? { status: error.status, code: error.code } : { status: "unavailable", code: "browser-storage-unavailable" };

// Browser preview only; desktop always uses SQLite + the native secure store.
const database = () => new Promise<IDBDatabase>((resolve, reject) => {
  const open = indexedDB.open("purr-preview-v3", 1);
  open.onupgradeneeded = () => { for (const name of ["projects", "local", "secrets", "app", "keys", "operations"]) if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name); };
  open.onsuccess = () => resolve(open.result); open.onerror = () => reject(storageFailure());
});
async function read<T>(store: string, key: string): Promise<T | undefined> {
  const db = await database();
  try { return await new Promise<T | undefined>((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(storageFailure());
  }); } finally { db.close(); }
}
async function keys(store: string): Promise<string[]> {
  const db = await database();
  try { return await new Promise<string[]>((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAllKeys();
    request.onsuccess = () => resolve(request.result.filter((value): value is string => typeof value === "string"));
    request.onerror = () => reject(storageFailure());
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
// Key and durable scope marker are initialized together. A missing known key is
// never silently regenerated; there is intentionally no old-preview adoption.
async function scopeKey(scope: BrowserProtectionScope, create: boolean): Promise<BrowserScopeKey> {
  const identity = scopeIdentity(scope);
  const candidate = create ? { id: crypto.randomUUID(), key: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]) } : undefined;
  const db = await database();
  try { return await new Promise<BrowserScopeKey>((resolve, reject) => {
    const tx = db.transaction(["keys", "local", "secrets", "app", "operations"], "readwrite"); const store = tx.objectStore("keys");
    const keyRequest = store.get(`key/${identity}`); const markerRequest = store.get(`scope/${identity}`);
    let result: BrowserScopeKey | undefined; let failure: Error | undefined;
    markerRequest.onsuccess = () => {
      const existing = keyRequest.result as BrowserScopeKey | undefined; const marker = markerRequest.result as string | undefined;
      if (existing && marker === existing.id) result = existing;
      else if (existing || marker || !candidate) failure = new BrowserProtectedError("unavailable", "browser-scope-key-missing");
      else {
        let remaining = 4; let known = false;
        for (const name of ["local", "secrets", "app", "operations"]) {
          const request = tx.objectStore(name).getAll();
          request.onsuccess = () => {
            known ||= request.result.some((record) => {
              const envelope = name === "operations" ? record?.request : record;
              return envelope?.scope && scopeIdentity(envelope.scope) === identity;
            });
            if (--remaining) return;
            if (known) failure = new BrowserProtectedError("unavailable", "browser-scope-key-missing");
            else { result = candidate; store.put(candidate, `key/${identity}`); store.put(candidate.id, `scope/${identity}`); }
          };
        }
      }
    };
    tx.oncomplete = () => result ? resolve(result) : reject(failure ?? storageFailure());
    tx.onabort = tx.onerror = () => reject(storageFailure());
  }); } finally { db.close(); }
}
const scopeCrypto = new BrowserScopeCrypto(scopeKey);
function contextScope(context: string): BrowserProtectionScope {
  if (context.startsWith("purr/")) return secretProtectionScope(context);
  if (context.startsWith("operation/")) return { owner: "application", kind: "journal" };
  if (context.startsWith("history/")) return { owner: "workspace", workspaceId: context.split("/")[1], kind: "runtime" };
  return context === "__global__" ? { owner: "global", kind: "runtime" } : { owner: "workspace", workspaceId: context, kind: "runtime" };
}
const seal = (value: unknown, context: string) => scopeCrypto.seal(value, contextScope(context), context);
const unseal = <T>(value: BrowserEnvelope, context: string): Promise<T> => scopeCrypto.unseal<T>(value, contextScope(context), context);
async function validateOwnerKeys(id: string): Promise<void> {
  const owner = id === "__global__" ? "global" : id;
  const refs = (await keys("secrets")).filter((ref) => ref.startsWith(`purr/${owner}/`));
  for (const kind of ["credentials", "runtime"] as const) {
    const scope: BrowserProtectionScope = owner === "global" ? { owner: "global", kind } : { owner: "workspace", workspaceId: owner, kind };
    const identity = scopeIdentity(scope);
    const [marker, storedKey] = await Promise.all([read("keys", `scope/${identity}`), read("keys", `key/${identity}`)]);
    const firstRef = refs.find((ref) => ref.startsWith(`purr/${owner}/${kind}/`));
    const runtimeRecord = kind === "runtime" ? await read<BrowserEnvelope>("local", id) : undefined;
    if (marker !== undefined || storedKey !== undefined || firstRef || runtimeRecord) {
      await scopeKey(scope, false);
      // An existing key object with changed material must also fail closed.
      if (firstRef) { const record = await read<BrowserEnvelope>("secrets", firstRef); if (record) await unseal(record, firstRef); }
    }
  }
}
type StoredSecret = Awaited<ReturnType<typeof seal>> & { revision?: number; deleted?: boolean };
type BrowserReceipt = CommitState & { request: Awaited<ReturnType<typeof seal>> };
async function verifyReceipt(batch: SecretBatch, receipt: BrowserReceipt, identity: unknown = { kind: "secrets" }) {
  const fingerprint = await contentRevision(JSON.stringify({ batch, identity }));
  const payload = await unseal<{ fingerprint: string; status: CommitState["status"] }>(receipt.request, `operation/${batch.operationId}`);
  if (payload.fingerprint !== fingerprint || payload.status !== receipt.status)
    throw new Error("operation-conflict: Operation identifier already used for a different secret batch");
}
type BrowserChange = { store: string; key: string; value?: unknown };
type BrowserMembership = { store: string; prefix: string; keys: string[] };
const secretRevision = (value: StoredSecret | undefined) => value?.revision ?? (value ? 1 : 0);
const comparable = (value: unknown): string | undefined => JSON.stringify(value, (_name, child) =>
  child instanceof ArrayBuffer ? Array.from(new Uint8Array(child)) : ArrayBuffer.isView(child) ? Array.from(new Uint8Array(child.buffer, child.byteOffset, child.byteLength)) : child);

/** All revision checks and publication happen in one IndexedDB transaction.
 * Encryption happens beforehand: awaiting WebCrypto inside a transaction lets it close. */
async function publish(changes: BrowserChange[], batch?: SecretBatch, checks: BrowserChange[] = [], identity: unknown = { kind: "secrets" }, memberships: BrowserMembership[] = []) {
  if (batch && (!batch.operationId || new Set(batch.mutations.map((mutation) => mutation.ref)).size !== batch.mutations.length))
    throw new Error("Invalid secret operation");
  for (const mutation of batch?.mutations ?? []) {
    validateSecretScope(mutation.ref, mutation.scope);
    if (!Number.isSafeInteger(mutation.expectedRevision) || mutation.expectedRevision < 0 || mutation.expectedRevision >= Number.MAX_SAFE_INTEGER)
      throw new Error("Invalid secret revision");
  }
  const prepared = await Promise.all((batch?.mutations ?? []).map(async (mutation) => {
    return { ...mutation, stored: { ...await seal({ value: mutation.value, revision: mutation.expectedRevision + 1 }, mutation.ref), revision: mutation.expectedRevision + 1, deleted: mutation.value === null } };
  }));
  const fingerprint = batch ? await contentRevision(JSON.stringify({ batch, identity })) : undefined;
  const encryptedRequest = batch ? await seal({ fingerprint, status: "committed" }, `operation/${batch.operationId}`) : undefined;
  const abortedRequest = batch ? await seal({ fingerprint, status: "aborted" }, `operation/${batch.operationId}`) : undefined;
  let replay: BrowserReceipt | undefined;
  const db = await database();
  try { await new Promise<void>((resolve, reject) => {
    const stores = [...new Set([...changes, ...checks, ...memberships].map((change) => change.store).concat(["secrets", "operations"]))];
    const transaction = db.transaction(stores, "readwrite");
    let failure: Error | undefined;
    transaction.oncomplete = () => failure ? reject(failure) : resolve();
    transaction.onabort = transaction.onerror = () => reject(failure ?? new Error("Cannot save browser preview storage"));
    const fail = (message: string) => {
      failure = new Error(message);
      if (batch) transaction.objectStore("operations").put({ operationId: batch.operationId, status: "aborted", request: abortedRequest }, batch.operationId);
      else transaction.abort();
    };
    const apply = () => {
      for (const change of changes) {
        const store = transaction.objectStore(change.store);
        if (change.value === undefined) store.delete(change.key); else store.put(change.value, change.key);
      }
      for (const mutation of prepared) transaction.objectStore("secrets").put(mutation.stored, mutation.ref);
      if (batch) transaction.objectStore("operations").put({ operationId: batch.operationId, status: "committed", request: encryptedRequest }, batch.operationId);
    };
    const verify = () => {
      const pending = [...checks.map((check) => ({ ...check, revision: undefined as number | undefined })),
        ...prepared.map((mutation) => ({ store: "secrets", key: mutation.ref, value: undefined, revision: mutation.expectedRevision }))];
      let remaining = pending.length + memberships.length;
      if (!remaining) { apply(); return; }
      for (const check of pending) {
        const request = transaction.objectStore(check.store).get(check.key);
        request.onsuccess = () => {
          if (failure) return;
          if (check.revision === undefined ? comparable(request.result) !== comparable(check.value) : secretRevision(request.result) !== check.revision) {
            fail("Storage changed externally. Reload before saving."); return;
          }
          if (--remaining === 0) apply();
        };
      }
      for (const membership of memberships) {
        const request = transaction.objectStore(membership.store).getAllKeys();
        request.onsuccess = () => {
          if (failure) return;
          const current = request.result.filter((value): value is string => typeof value === "string" && value.startsWith(membership.prefix)).sort();
          if (comparable(current) !== comparable([...membership.keys].sort())) {
            fail("Storage changed externally. Reload before deleting."); return;
          }
          if (--remaining === 0) apply();
        };
      }
    };
    if (!batch) { verify(); return; }
    const receipt = transaction.objectStore("operations").get(batch.operationId);
    receipt.onsuccess = () => {
      const state = receipt.result as BrowserReceipt | undefined;
      if (state?.status === "committed") { replay = state; return; }
      if (state) { failure = new Error(`Secret operation is ${state.status}`); return; }
      verify();
    };
  });
    if (replay && batch) await verifyReceipt(batch, replay, identity);
  } finally { db.close(); }
}
/** Delete owned records and secret namespaces as one publication. Membership
 * checks protect rows first created while encryption is being prepared. */
async function removeProtected(changes: BrowserChange[], prefixes: string[], checks: BrowserChange[] = [], memberships: BrowserMembership[] = []) {
  const allRefs = await keys("secrets");
  const refs = allRefs.filter((ref) => prefixes.some((prefix) => ref.startsWith(prefix)));
  const mutations = await Promise.all(refs.map(async (ref) => ({
    ref, scope: secretProtectionScope(ref), expectedRevision: secretRevision(await read<StoredSecret>("secrets", ref)), value: null,
  })));
  await publish(changes, { operationId: crypto.randomUUID(), mutations }, checks,
    { kind: "delete", changes, prefixes }, [...memberships,
      ...prefixes.map((prefix) => ({ store: "secrets", prefix, keys: refs.filter((ref) => ref.startsWith(prefix)) })),
    ]);
}
async function historyChecks(expected: { key: string; value?: unknown }[]): Promise<BrowserChange[]> {
  return Promise.all(expected.map(async ({ key, value }) => {
    const stored = await read<Awaited<ReturnType<typeof seal>>>("app", key);
    const current = stored ? await unseal(stored, key) : undefined;
    if (comparable(current) !== comparable(value)) throw new Error("History changed externally. Reload before saving.");
    return { store: "app", key, value: stored };
  }));
}
export class BrowserSecureStore implements SecureStore {
  async resolve(ref: SecretRef): Promise<SecretResolution> {
    secretRefSchema.parse(ref);
    let data: StoredSecret | undefined;
    try { data = await read<StoredSecret>("secrets", ref); }
    catch { return { status: "unavailable", code: "browser-storage-unavailable", retryable: true }; }
    if (data === undefined) return { status: "missing", revision: 0 };
    try {
      const payload = await unseal<{ value: unknown; revision: number }>(data, ref);
      const revision = secretRevision(data); const value = payload.value;
      if (payload.revision !== revision) throw new BrowserProtectedError("corrupt", "browser-protected-data-corrupt");
      if (!Number.isSafeInteger(revision) || revision < 0 || typeof value !== "string" && value !== null)
        throw new BrowserProtectedError("corrupt", "browser-protected-data-corrupt");
      return value === null ? { status: "missing", revision } : { status: "available", value, revision };
    } catch (error) {
      return error instanceof BrowserProtectedError ? { status: error.status, code: error.code, retryable: error.status === "unavailable" }
        : { status: "corrupt", code: "browser-protected-data-corrupt", retryable: false };
    }
  }
  async read(ref: SecretRef): Promise<SecretSnapshot> {
    secretRefSchema.parse(ref);
    const data = await read<StoredSecret>("secrets", ref);
    if (data === undefined) return { value: null, revision: 0 };
    const payload = await unseal<{ value: unknown; revision: number }>(data, ref); const revision = secretRevision(data); const value = payload.value;
    if (payload.revision !== revision) throw new BrowserProtectedError("corrupt", "browser-protected-data-corrupt");
    if (!Number.isSafeInteger(revision) || revision < 0 || typeof value !== "string" && value !== null)
      throw new BrowserProtectedError("corrupt", "browser-protected-data-corrupt");
    return { value, revision };
  }
  async get(ref: SecretRef) { return (await this.read(ref)).value; }
  async commit(batch: SecretBatch) { await publish([], batch); }
  async operationStatus(operationId: string): Promise<CommitState> {
    const receipt = await read<BrowserReceipt>("operations", operationId);
    if (!receipt) return { operationId, status: "missing" };
    const payload = await unseal<{ status: CommitState["status"] }>(receipt.request, `operation/${operationId}`);
    if (payload.status !== receipt.status || !["committed", "aborted", "recovery-required"].includes(payload.status))
      throw new BrowserProtectedError("corrupt", "browser-protected-data-corrupt");
    return { operationId, status: payload.status };
  }
  async set(ref: SecretRef, value: string) { const previous = await this.read(ref); await this.commit({ operationId: crypto.randomUUID(), mutations: [{ ref, scope: secretProtectionScope(ref), expectedRevision: previous.revision, value }] }); }
  async delete(ref: SecretRef) { const previous = await this.read(ref); await this.commit({ operationId: crypto.randomUUID(), mutations: [{ ref, scope: secretProtectionScope(ref), expectedRevision: previous.revision, value: null }] }); }
  async exists(ref: SecretRef) { return (await this.get(ref)) !== null; }
}
export class BrowserPersistenceBackend implements PersistencePort {
  readonly history = new BrowserHistory({
    read: async <T>(key: string) => {
      const data = await read<Awaited<ReturnType<typeof seal>>>("app", key);
      return data ? unseal<T>(data, key) : undefined;
    },
    write: async (changes) => publish(await Promise.all(changes.map(async ({ key, value }) => ({
      store: "app", key, ...(value === undefined ? {} : { value: await seal(value, key) }),
    })))),
    commit: async (changes, batch, expected = [], identity) => {
      const prior = await read<BrowserReceipt>("operations", batch.operationId);
      if (prior?.status === "committed") { await verifyReceipt(batch, prior, identity); return; }
      const checks = await historyChecks(expected);
      await publish(await Promise.all(changes.map(async ({ key, value }) => ({
        store: "app", key, ...(value === undefined ? {} : { value: await seal(value, key) }),
      }))), batch, checks, identity);
    },
    remove: async (changes, prefixes, expected = []) => {
      const checks = await historyChecks(expected);
      const storedChanges = await Promise.all(changes.map(async ({ key, value }) => ({
        store: "app", key, ...(value === undefined ? {} : { value: await seal(value, key) }),
      })));
      await removeProtected(storedChanges, prefixes, checks);
    },
    operationStatus: (operationId) => new BrowserSecureStore().operationStatus(operationId),
    legacy: (id) => this.readRawLocal(id),
    finishLegacy: async (id) => {
      const local = await this.readRawLocal(id);
      if (local.some((record) => record.table === "request_executions")) await writeMany([{ store: "local", key: id,
        value: await seal(local.filter((record) => record.table !== "request_executions"), id) }]);
    },
    deleteSecrets: async (prefix) => removeProtected([], [prefix]),
  });
  async load(): Promise<StorageSnapshot> {
    const ids = await read<string[]>("app", "workspaces") ?? [];
    const workspaces = await Promise.all(ids.map((id) => this.loadWorkspace(id)));
    let global: LocalRecord[] = []; let protectedState: ProtectedState = { status: "available" };
    try { await validateOwnerKeys("__global__"); global = await this.readLocal("__global__"); } catch (error) { protectedState = protectedFailure(error); }
    return { activeWorkspaceId: await read<string>("app", "active") ?? "", workspaces, global, globalProtectedState: protectedState, protectedState: { status: "available" } };
  }
  async retryProtectedStorage() { return this.load(); }
  async loadWorkspace(id: string): Promise<StoredWorkspace> {
    const files = await read<Record<string, ProjectFile>>("projects", id) ?? {};
    try { await validateOwnerKeys(id); return { id, files, local: await this.readLocal(id), protectedState: { status: "available" } }; }
    catch (error) { return { id, files, local: [], protectedState: protectedFailure(error) }; }
  }
  private async readRawLocal(id: string): Promise<LocalRecord[]> {
    const data = await read<Awaited<ReturnType<typeof seal>>>("local", id);
    if (data === undefined) return [];
    const value = await unseal<unknown>(data, id);
    if (!Array.isArray(value)) throw new BrowserProtectedError("corrupt", "browser-protected-data-corrupt");
    return value as LocalRecord[];
  }
  async readLocal(id: string): Promise<LocalRecord[]> {
    const local = await this.readRawLocal(id);
    return id === "__global__" ? local : [...local.filter((record) => record.table !== "request_executions"), ...await this.history.latestExecutions(id)];
  }
  async commit(id: string, changes: FileChange[], local: LocalChange[], batch?: SecretBatch) {
    if (batch?.mutations.some((mutation) => !mutation.ref.startsWith(`purr/${id === "__global__" ? "global" : id}/`))) throw new Error("Secret changes must belong to the workspace");
    await validateOwnerKeys(id);
    const identity = { kind: "workspace", id, changes, local };
    if (batch) {
      const receipt = await read<BrowserReceipt>("operations", batch.operationId);
      if (receipt?.status === "committed") { await verifyReceipt(batch, receipt, identity); return (await this.loadWorkspace(id)).files; }
    }
    const oldFiles = await read<Record<string, ProjectFile>>("projects", id);
    const oldLocal = await read<Awaited<ReturnType<typeof seal>>>("local", id);
    const oldIds = await read<string[]>("app", "workspaces");
    const existing = { files: oldFiles ?? {}, local: oldLocal ? await unseal<LocalRecord[]>(oldLocal, id) : [] }; const files = { ...existing.files };
    for (const change of changes) if ((files[change.path]?.revision ?? null) !== change.expectedRevision) throw new Error("Project changed externally. Reload before saving.");
    for (const change of changes) { if (change.content === null) delete files[change.path]; else files[change.path] = { content: change.content, revision: await contentRevision(change.content) }; }
    const records = new Map(existing.local.map((record) => [`${record.table}/${record.id}`, record]));
    for (const change of local) { const key = `${change.table}/${change.id}`; if (change.value === null) records.delete(key); else records.set(key, change as LocalRecord); }
    const ids = new Set(oldIds ?? []); if (id !== "__global__") ids.add(id);
    await publish([{ store: "projects", key: id, value: files }, { store: "local", key: id, value: await seal([...records.values()], id) }, { store: "app", key: "workspaces", value: [...ids] }], batch,
      [{ store: "projects", key: id, value: oldFiles }, { store: "local", key: id, value: oldLocal }, { store: "app", key: "workspaces", value: oldIds }], identity);
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
  async writeGlobal(local: LocalChange[], batch?: SecretBatch) { await this.commit("__global__", [], local, batch); }
  async deleteWorkspace(id: string) {
    const [oldFiles, oldLocal, oldIds, oldActive, appKeys] = await Promise.all([
      read("projects", id), read("local", id), read<string[]>("app", "workspaces"), read<string>("app", "active"), keys("app"),
    ]);
    const historyPrefix = `history/${id}/`;
    const historyKeys = appKeys.filter((key) => key.startsWith(historyPrefix));
    const history = await Promise.all(historyKeys.map(async (key) => ({ store: "app", key, value: await read("app", key) })));
    const changes: BrowserChange[] = [
      { store: "projects", key: id }, { store: "local", key: id },
      { store: "app", key: "workspaces", value: (oldIds ?? []).filter((candidate) => candidate !== id) },
      ...historyKeys.map((key) => ({ store: "app", key })),
      ...(oldActive === id ? [{ store: "app", key: "active" }] : []),
    ];
    const checks = [
      { store: "projects", key: id, value: oldFiles }, { store: "local", key: id, value: oldLocal },
      { store: "app", key: "workspaces", value: oldIds }, { store: "app", key: "active", value: oldActive }, ...history,
    ];
    await removeProtected(changes, [`purr/${id}/`], checks, [{ store: "app", prefix: historyPrefix, keys: historyKeys }]);
  }
  async finishMigration() { /* Clean v3 preview never imports or deletes old preview storage. */ }
  async watchChanges(_listener: (id: string, paths: string[]) => void) { return () => {}; }
}
export async function contentRevision(content: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
