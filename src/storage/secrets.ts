import { secretRefSchema, type Credential, type SecretRef } from "../domain/project";
import type { CommitState, SecretBatch, SecretSnapshot, SecureStore } from "../application/ports/credentials";

export function secretRef(workspace: string, owner: string, field: string): SecretRef {
  return secretRefSchema.parse(`purr/${workspace}/${owner}/${field}`);
}
export class MemorySecureStore implements SecureStore {
  private values = new Map<string, string>();
  private revisions = new Map<string, number>();
  private operations = new Map<string, { identity: string; status: CommitState["status"] }>();
  async get(ref: SecretRef) { return this.values.get(ref) ?? null; }
  async read(ref: SecretRef): Promise<SecretSnapshot> { secretRefSchema.parse(ref); return { value: await this.get(ref), revision: this.revisions.get(ref) ?? 0 }; }
  async operationStatus(operationId: string): Promise<CommitState> { return { operationId, status: this.operations.get(operationId)?.status ?? "missing" }; }
  async commitWith<T>(batch: SecretBatch, publish: () => T, identity: unknown = batch): Promise<T | undefined> {
    const request = JSON.stringify({ batch, identity });
    const prior = this.operations.get(batch.operationId);
    if (prior) {
      if (prior.identity !== request) throw new Error("operation-conflict: Operation ID already used for different changes");
      if (prior.status === "committed") return undefined;
      throw new Error("Operation was aborted; prepare a new save");
    }
    const refs = new Set<string>();
    try {
      if (!batch.operationId) throw new Error("Invalid commit operation");
      for (const mutation of batch.mutations) {
        secretRefSchema.parse(mutation.ref);
        if (refs.has(mutation.ref) || !Number.isSafeInteger(mutation.expectedRevision) || mutation.expectedRevision < 0) throw new Error("Invalid secret changes");
        refs.add(mutation.ref);
        if ((this.revisions.get(mutation.ref) ?? 0) !== mutation.expectedRevision) throw new Error("Credential changed externally. Reload before saving.");
      }
      // No await inside publication: adapters prepare their state first and
      // synchronously publish it together with the value/revision maps.
      const result = publish();
      if (result instanceof Promise) throw new Error("Memory transaction publication must be synchronous");
      for (const mutation of batch.mutations) {
        if (mutation.value === null) this.values.delete(mutation.ref);
        else this.values.set(mutation.ref, mutation.value);
        this.revisions.set(mutation.ref, mutation.expectedRevision + 1);
      }
      this.operations.set(batch.operationId, { identity: request, status: "committed" });
      return result;
    } catch (error) {
      this.operations.set(batch.operationId, { identity: request, status: "aborted" });
      throw error;
    }
  }
  async commit(batch: SecretBatch) { await this.commitWith(batch, () => undefined); }
  async deletePrefixes(prefixes: readonly string[], publish: () => void = () => undefined) {
    const mutations = [...this.values.keys()].filter((ref) => prefixes.some((prefix) => ref.startsWith(prefix)))
      .map((ref) => ({ ref, value: null, expectedRevision: this.revisions.get(ref) ?? 0 }));
    await this.commitWith({ operationId: crypto.randomUUID(), mutations }, publish, { kind: "delete-scopes", prefixes });
  }
  async set(ref: SecretRef, value: string) { const snapshot = await this.read(ref); await this.commit({ operationId: crypto.randomUUID(), mutations: [{ ref, value, expectedRevision: snapshot.revision }] }); }
  async delete(ref: SecretRef) { const snapshot = await this.read(ref); await this.commit({ operationId: crypto.randomUUID(), mutations: [{ ref, value: null, expectedRevision: snapshot.revision }] }); }
  async exists(ref: SecretRef) { return this.values.has(ref); }
}
export async function storeCredential(store: SecureStore, ref: SecretRef, value: string, mode: "plain" | "secret" = "secret"): Promise<Credential> {
  if (mode === "plain") return { kind: "plain", value };
  const existing = await store.get(ref);
  if (!value) {
    if (existing !== null) await store.delete(ref);
  } else if (existing !== value) await store.set(ref, value);
  return { kind: "secret", ref };
}
export async function resolveCredential(store: SecureStore, value: Credential): Promise<string> {
  return value.kind === "plain" ? value.value : await store.get(value.ref) ?? "";
}
export class CachedSecureStore implements SecureStore {
  private values = new Map<SecretRef, SecretSnapshot>();
  constructor(private source: SecureStore) {}
  async read(ref: SecretRef) { if (!this.values.has(ref)) this.values.set(ref, await this.source.read(ref)); return { ...this.values.get(ref)! }; }
  async get(ref: SecretRef) { return (await this.read(ref)).value; }
  async commit(batch: SecretBatch) { try { await this.source.commit(batch); } finally { this.clear(); } }
  operationStatus(operationId: string) { return this.source.operationStatus(operationId); }
  async set(ref: SecretRef, value: string) { try { await this.source.set(ref, value); } finally { this.clear(); } }
  async delete(ref: SecretRef) { try { await this.source.delete(ref); } finally { this.clear(); } }
  async exists(ref: SecretRef) { return await this.get(ref) !== null; }
  clear() { this.values.clear(); }
}

/** Read-only source plus private staged changes; discarding it changes nothing. */
export class SecretPreparationStore implements SecureStore {
  private snapshots = new Map<SecretRef, Promise<SecretSnapshot>>();
  private staged = new Map<SecretRef, string | null>();
  readonly operationId = crypto.randomUUID();
  constructor(private source: SecureStore) {}
  /** A new Save attempt retains its baseline and editor values, with a new ID. */
  fork(): SecretPreparationStore {
    const attempt = new SecretPreparationStore(this.source);
    attempt.snapshots = new Map(this.snapshots);
    attempt.staged = new Map(this.staged);
    return attempt;
  }
  private baseline(ref: SecretRef) {
    secretRefSchema.parse(ref);
    if (!this.snapshots.has(ref)) this.snapshots.set(ref, this.source.read(ref));
    return this.snapshots.get(ref)!;
  }
  async read(ref: SecretRef): Promise<SecretSnapshot> {
    const baseline = await this.baseline(ref);
    return { revision: baseline.revision, value: this.staged.has(ref) ? this.staged.get(ref)! : baseline.value };
  }
  async get(ref: SecretRef) { return (await this.read(ref)).value; }
  async set(ref: SecretRef, value: string) { await this.baseline(ref); this.staged.set(ref, value); }
  async delete(ref: SecretRef) { await this.baseline(ref); this.staged.set(ref, null); }
  async exists(ref: SecretRef) { return (await this.get(ref)) !== null; }
  async commit(): Promise<void> { throw new Error("Prepared secrets must be published with their owning commit"); }
  operationStatus(operationId: string) { return this.source.operationStatus(operationId); }
  async batch(): Promise<SecretBatch> {
    const mutations = [];
    for (const [ref, value] of this.staged) {
      const baseline = await this.baseline(ref);
      if (baseline.value !== value) mutations.push({ ref, value, expectedRevision: baseline.revision });
    }
    return { operationId: this.operationId, mutations };
  }
}

// Only credential-bearing fields are replaced. This also protects inactive editor
// modes and unsaved credentials, which must never be copied to SQLite plaintext.
export async function protectRuntime(value: unknown, store: SecureStore, workspace: string, owner: string): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item, i) => protectRuntime(item, store, workspace, `${owner}/${i}`)));
  if (!value || typeof value !== "object" || value instanceof File) return value;
  const object = value as Record<string, unknown>;
  if (object.secret === true && typeof object.value === "string" && typeof object.name === "string") {
    return { ...object, value: { __purrSecret: await storeCredential(store, secretRef(workspace, owner, "value"), object.value) } };
  }
  const auth = "bearer" in object && "oauth2" in object && "inherit" in object;
  if (auth) {
    const copy = structuredClone(object) as Record<string, Record<string, unknown>>;
    for (const [group, keys] of Object.entries({ bearer: ["token"], basic: ["password"], apiKey: ["value"], oauth2: ["clientSecret"] })) {
      for (const key of keys) {
        const text = copy[group]?.[key];
        if (typeof text === "string" && text) copy[group][key] = { __purrSecret: (await storeCredential(store, secretRef(workspace, owner, `${group}/${key}`), text)) };
      }
    }
    const token = copy.oauth2.token as Record<string, unknown> | null;
    if (token) for (const key of ["accessToken", "refreshToken"]) if (typeof token[key] === "string")
      token[key] = { __purrSecret: await storeCredential(store, secretRef(workspace, owner, `oauth2/${key}`), token[key]) };
    return copy;
  }
  return Object.fromEntries(await Promise.all(Object.entries(object).map(async ([key, child]) => [key, await protectRuntime(child, store, workspace, `${owner}/${key}`)])));
}
export async function resolveRuntime(value: unknown, store: SecureStore): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolveRuntime(item, store)));
  if (!value || typeof value !== "object" || value instanceof File) return value;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length === 1 && object.__purrSecret) return resolveCredential(store, object.__purrSecret as Credential);
  return Object.fromEntries(await Promise.all(Object.entries(object).map(async ([key, child]) => [key, await resolveRuntime(child, store)])));
}
