import { secretRefSchema, type Credential, type SecretRef } from "../domain/project";
import { isPureTemplateReference } from "../domain/template-expression";
import { SecretUnavailableError, type CommitState, type SecretBatch, type SecretSnapshot, type SecureStore, type SecretResolution, type SecretFieldState, type SecretProtectionScope } from "../application/ports/credentials";

export function secretRef(workspace: string, owner: string, field: string, kind: SecretProtectionScope["kind"] = "credentials"): SecretRef {
  return secretRefSchema.parse(`purr/${workspace}/${kind}/${owner}/${field}`);
}
/** Scoped refs make ownership explicit at every storage boundary. Legacy refs are readable
 * as missing in clean storage, but can never receive a new value. */
export function secretProtectionScope(ref: SecretRef): SecretProtectionScope {
  secretRefSchema.parse(ref);
  const [, owner, kind, ...path] = ref.split("/");
  if (!owner || owner === "__global__" || !path.length || path.some((segment) => !segment) || (kind !== "credentials" && kind !== "runtime")) throw new Error("Secret reference requires an explicit protection scope");
  return owner === "global" ? { owner: "global", kind } : { owner: "workspace", workspaceId: owner, kind };
}
export function validateSecretScope(ref: SecretRef, scope: SecretProtectionScope): void {
  const expected = secretProtectionScope(ref);
  if (!scope || expected.owner !== scope.owner || expected.kind !== scope.kind ||
    expected.owner === "workspace" && (scope.owner !== "workspace" || expected.workspaceId !== scope.workspaceId))
    throw new Error("Secret protection scope does not match reference");
}
export function credentialRef(workspace: string, owner: string, field: string, existing?: SecretRef): SecretRef {
  if (existing?.startsWith(`purr/${workspace}/credentials/`)) return existing;
  return secretRef(workspace, owner, field);
}
export class MemorySecureStore implements SecureStore {
  private values = new Map<string, string>();
  private revisions = new Map<string, number>();
  private operations = new Map<string, { identity: string; status: CommitState["status"] }>();
  async get(ref: SecretRef) { return this.values.get(ref) ?? null; }
  async read(ref: SecretRef): Promise<SecretSnapshot> { secretRefSchema.parse(ref); return { value: await this.get(ref), revision: this.revisions.get(ref) ?? 0 }; }
  async resolve(ref: SecretRef): Promise<SecretResolution> { const snapshot = await this.read(ref); return snapshot.value === null ? { status: "missing", revision: snapshot.revision } : { status: "available", ...snapshot, value: snapshot.value }; }
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
        validateSecretScope(mutation.ref, mutation.scope);
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
      .map((ref) => ({ ref, scope: secretProtectionScope(ref), value: null, expectedRevision: this.revisions.get(ref) ?? 0 }));
    await this.commitWith({ operationId: crypto.randomUUID(), mutations }, publish, { kind: "delete-scopes", prefixes });
  }
  async set(ref: SecretRef, value: string) { const snapshot = await this.read(ref); await this.commit({ operationId: crypto.randomUUID(), mutations: [{ ref, scope: secretProtectionScope(ref), value, expectedRevision: snapshot.revision }] }); }
  async delete(ref: SecretRef) { const snapshot = await this.read(ref); await this.commit({ operationId: crypto.randomUUID(), mutations: [{ ref, scope: secretProtectionScope(ref), value: null, expectedRevision: snapshot.revision }] }); }
  async exists(ref: SecretRef) { return this.values.has(ref); }
}
export async function storeCredential(store: SecureStore, ref: SecretRef, value: string, mode: "plain" | "secret" = "secret", state?: SecretFieldState): Promise<Credential> {
  if (mode === "plain") return { kind: "plain", value };
  if (state?.edit?.kind === "keep" && state.ref === ref) return { kind: "secret", ref };
  if (state?.edit?.kind === "delete") {
    if (await store.get(ref) !== null) await store.delete(ref);
    return { kind: "secret", ref };
  }
  if (state && (state.edit?.kind ?? "keep") === "keep" && state.ref !== ref) {
    const result = await store.resolve(state.ref);
    if (result.status !== "available") return { kind: "secret", ref };
    value = result.value;
  } else if (state?.edit?.kind === "set") value = state.edit.value;
  const existing = await store.get(ref);
  if (existing !== value) await store.set(ref, value);
  return { kind: "secret", ref };
}
export async function resolveCredential(store: SecureStore, value: Credential): Promise<string> {
  if (value.kind !== "secret") return value.value;
  const result = await store.resolve(value.ref);
  if (result.status === "available") return result.value;
  throw new SecretUnavailableError(value.ref, result.status, "code" in result ? result.code : "credential-missing");
}
/** Materialization may be lazy; the empty buffer always carries its actual state. */
export async function materializeCredential(store: SecureStore, credential: Credential, hydrate = true): Promise<{ value: string; secretState?: SecretFieldState }> {
  if (credential.kind !== "secret") return { value: credential.value };
  if (!hydrate && store instanceof SecretPreparationStore) {
    const staged = store.preparedValue(credential.ref);
    if (staged) return { value: staged.value ?? "", secretState: { ref: credential.ref, status: staged.value === null ? "missing" : "available", edit: staged.value === null ? { kind: "delete" } : { kind: "set", value: staged.value } } };
  }
  if (!hydrate) return { value: "", secretState: { ref: credential.ref, status: "unresolved", edit: { kind: "keep" } } };
  const result = await store.resolve(credential.ref);
  return { value: result.status === "available" ? result.value : "", secretState: { ref: credential.ref, status: result.status, edit: { kind: "keep" }, ...("code" in result ? { code: result.code } : {}) } };
}
export class CachedSecureStore implements SecureStore {
  private values = new Map<SecretRef, SecretSnapshot>();
  constructor(private source: SecureStore) {}
  async read(ref: SecretRef) { if (!this.values.has(ref)) this.values.set(ref, await this.source.read(ref)); return { ...this.values.get(ref)! }; }
  async get(ref: SecretRef) { return (await this.read(ref)).value; }
  async resolve(ref: SecretRef): Promise<SecretResolution> {
    const result = await this.source.resolve(ref);
    if (result.status === "available") this.values.set(ref, { value: result.value, revision: result.revision });
    else if (result.status === "missing") this.values.set(ref, { value: null, revision: result.revision });
    else this.values.delete(ref);
    return result;
  }
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
  private acknowledgements: Array<() => void> = [];
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
  async resolve(ref: SecretRef): Promise<SecretResolution> {
    if (!this.staged.has(ref)) return this.source.resolve(ref);
    const snapshot = await this.read(ref);
    return snapshot.value === null ? { status: "missing", revision: snapshot.revision } : { status: "available", value: snapshot.value, revision: snapshot.revision };
  }
  onCommitted(callback: () => void) { this.acknowledgements.push(callback); }
  preparedValue(ref: SecretRef): { value: string | null } | undefined { return this.staged.has(ref) ? { value: this.staged.get(ref)! } : undefined; }
  acknowledge() { for (const callback of this.acknowledgements) callback(); this.acknowledgements = []; }
  async set(ref: SecretRef, value: string) { secretProtectionScope(ref); await this.baseline(ref); this.staged.set(ref, value); }
  async delete(ref: SecretRef) { secretProtectionScope(ref); await this.baseline(ref); this.staged.set(ref, null); }
  async exists(ref: SecretRef) { return (await this.get(ref)) !== null; }
  async commit(): Promise<void> { throw new Error("Prepared secrets must be published with their owning commit"); }
  operationStatus(operationId: string) { return this.source.operationStatus(operationId); }
  async batch(): Promise<SecretBatch> {
    const mutations = [];
    for (const [ref, value] of this.staged) {
      const baseline = await this.baseline(ref);
      if (baseline.value !== value) mutations.push({ ref, scope: secretProtectionScope(ref), value, expectedRevision: baseline.revision });
    }
    return { operationId: this.operationId, mutations };
  }
}

// Only credential-bearing fields are replaced. This also protects inactive editor
// modes and unsaved credentials, which must never be copied to SQLite plaintext.
export async function protectRuntime(value: unknown, store: SecureStore, workspace: string, owner: string): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item, i) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
    const identity = row && typeof row.id === "string" && ("name" in row || "key" in row) ? row.id : String(i);
    return protectRuntime(item, store, workspace, `${owner}/${identity}`);
  }));
  if (!value || typeof value !== "object" || value instanceof File) return value;
  const object = value as Record<string, unknown>;
  if (object.kind === "extension") return object;
  const envelope = async (ref: SecretRef, text: string, state?: SecretFieldState, allowTemplate = false) => {
    const history = owner.startsWith("history/");
    let credential: Credential;
    if (allowTemplate && (!state || state.edit?.kind === "set") && isPureTemplateReference(state?.edit?.kind === "set" ? state.edit.value : text))
      credential = { kind: "template", value: state?.edit?.kind === "set" ? state.edit.value : text };
    else if (history && state && state.status !== "available" && state.edit?.kind !== "set") credential = { kind: "secret", ref };
    else if (history) credential = await storeCredential(store, ref, state?.edit?.kind === "set" ? state.edit.value : text);
    else if (state && (state.edit?.kind ?? "keep") === "keep" && state.status === "available" && state.ref !== ref) credential = await storeCredential(store, ref, text);
    else credential = await storeCredential(store, ref, text, "secret", state);
    return { __purrSecret: credential, ...(state?.edit?.kind === "delete" && !history ? { __purrEdit: "delete" } : {}) };
  };
  if (object.kind === "integration" && object.credentials && typeof object.credentials === "object") {
    const credentials = Object.fromEntries(await Promise.all(Object.entries(object.credentials).map(async ([key, input]) => {
      const credential = input as Credential;
      return [key, await storeCredential(store, secretRef(workspace, `${owner}/credentials`, key, "runtime"), credential.kind === "secret" ? "" : credential.value, "secret", credential.kind === "secret" ? { ref: credential.ref, status: "unresolved", edit: { kind: "keep" } } : undefined)];
    })));
    // Provider configuration is user-owned opaque JSON, not a credential map.
    return { ...object, credentials };
  }
  if (object.type === "registry" && object.credential && typeof object.credential === "object") {
    const credential = object.credential as Credential;
    return { ...object, credential: credential.kind === "template" ? credential : credential.kind === "plain" && isPureTemplateReference(credential.value) ? { kind: "template", value: credential.value }
      : await storeCredential(store, secretRef(workspace, owner, "credential", "runtime"), credential.kind === "secret" ? "" : credential.value, "secret", credential.kind === "secret" ? { ref: credential.ref, status: "unresolved", edit: { kind: "keep" } } : undefined) };
  }
  if ((object.secret === true && typeof object.name === "string" || typeof object.name === "string" && ["cookie", "set-cookie"].includes(object.name.trim().toLowerCase()) || object.kind === "static" && object.sensitive === true || object.secretState)
    && typeof object.value === "string") {
    const { secretState, secretRef: _sourceRef, ...rest } = object;
    const stored = await envelope(secretRef(workspace, owner, "value", "runtime"), object.value, secretState as SecretFieldState | undefined ?? (object.loaded === false && typeof object.secretRef === "string" ? { ref: object.secretRef, status: "unresolved", edit: { kind: "keep" } } : undefined), object.kind !== "static" && typeof object.name === "string");
    if (store instanceof SecretPreparationStore && !owner.startsWith("history/")) store.onCommitted(() => {
      // A canonical acknowledgement or concurrent edit already owns this field.
      if (object.secretState !== secretState || (secretState as SecretFieldState | undefined)?.edit?.kind === "keep") return;
      const ref = stored.__purrSecret.kind === "secret" ? stored.__purrSecret.ref : undefined;
      if (ref) object.secretState = { ref, status: secretState && (secretState as SecretFieldState).edit?.kind === "delete" ? "missing" : secretState && (secretState as SecretFieldState).edit?.kind === "keep" ? (secretState as SecretFieldState).status : "available", edit: { kind: "keep" } };
      else { delete object.secretState; delete object.secretRef; }
    });
    return { ...rest, value: stored };
  }
  const auth = "bearer" in object && "oauth2" in object && "inherit" in object;
  if (auth) {
    const { credentialStates, secretRefs: _sourceRefs, credentialStorage: _storage, ...source } = object;
    const states = credentialStates as Record<string, SecretFieldState> | undefined;
    const copy = structuredClone(source) as Record<string, Record<string, unknown>>;
    for (const [group, key, slot] of [["bearer", "token", "bearer"], ["basic", "password", "password"], ["apiKey", "value", "api-key"], ["oauth2", "clientSecret", "client-secret"]]) {
      const text = copy[group]?.[key];
      if (typeof text === "string" && (text || states?.[slot])) {
        const stored = await envelope(secretRef(workspace, owner, `${group}/${key}`, "runtime"), text, states?.[slot], true); copy[group][key] = stored;
        if (store instanceof SecretPreparationStore && !owner.startsWith("history/")) store.onCommitted(() => {
          if ((object.credentialStates as Record<string, SecretFieldState> | undefined)?.[slot] !== states?.[slot] || states?.[slot]?.edit?.kind === "keep") return;
          if (stored.__purrSecret.kind === "secret") object.credentialStates = { ...(object.credentialStates as Record<string, SecretFieldState> | undefined), [slot]: { ref: stored.__purrSecret.ref, status: states?.[slot]?.edit?.kind === "delete" ? "missing" : "available", edit: { kind: "keep" } } };
          else {
            if (object.credentialStates) delete (object.credentialStates as Record<string, SecretFieldState>)[slot];
            if (object.secretRefs) delete (object.secretRefs as Record<string, string>)[slot];
          }
        });
      }
    }
    const token = copy.oauth2.token as Record<string, unknown> | null;
    if (token) for (const key of ["accessToken", "refreshToken"]) if (typeof token[key] === "string")
      token[key] = await envelope(secretRef(workspace, owner, `oauth2/${key}`, "runtime"), token[key], states?.[key === "accessToken" ? "oauth-access-token" : "oauth-refresh-token"]);
    return copy;
  }
  if (object.kind === "static" && typeof object.secretRef === "string" && !("value" in object)) {
    const credential = await storeCredential(store, secretRef(workspace, owner, "value", "runtime"), "", "secret", { ref: object.secretRef, status: "unresolved", edit: { kind: "keep" } });
    return { ...object, secretRef: credential.kind === "secret" ? credential.ref : undefined };
  }
  if (object.kind === "secret" && typeof object.ref === "string") {
    return storeCredential(store, secretRef(workspace, owner, "value", "runtime"), "", "secret", { ref: object.ref, status: "unresolved", edit: { kind: "keep" } });
  }
  // Availability/edit metadata is transient and can contain a staged plaintext
  // value. Credential envelopes above own persistence of those values.
  return Object.fromEntries(await Promise.all(Object.entries(object).filter(([key]) => key !== "secretState" && key !== "credentialStates")
    .map(async ([key, child]) => [key, await protectRuntime(child, store, workspace, `${owner}/${key}`)])));
}
export async function resolveRuntime(value: unknown, store: SecureStore, hydrate = true): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolveRuntime(item, store, hydrate)));
  if (!value || typeof value !== "object" || value instanceof File) return value;
  const object = value as Record<string, unknown>;
  if (object.kind === "integration" || object.kind === "extension") return object;
  if (object.__purrSecret) return (await materializeCredential(store, object.__purrSecret as Credential, hydrate)).value;
  const marker = (candidate: unknown) => candidate && typeof candidate === "object" && "__purrSecret" in candidate ? candidate as { __purrSecret: Credential; __purrEdit?: "delete" } : undefined;
  if ("bearer" in object && "oauth2" in object && "inherit" in object) {
    const copy = structuredClone(object);
    const states: Record<string, SecretFieldState> = {};
    for (const [group, key, slot] of [["bearer", "token", "bearer"], ["basic", "password", "password"], ["apiKey", "value", "api-key"], ["oauth2", "clientSecret", "client-secret"]]) {
      const fields = copy[group] as Record<string, unknown> | undefined;
      const stored = marker(fields?.[key]);
      if (!stored) continue;
      const field = await materializeCredential(store, stored.__purrSecret, hydrate);
      fields![key] = field.value;
      if (field.secretState) states[slot] = { ...field.secretState, ...(stored.__purrEdit ? { edit: { kind: "delete" as const } } : {}) };
      else if (copy.secretRefs) delete (copy.secretRefs as Record<string, string>)[slot];
    }
    const token = (copy.oauth2 as Record<string, unknown>).token as Record<string, unknown> | null;
    if (token) for (const key of ["accessToken", "refreshToken"]) {
      const stored = marker(token[key]);
      if (!stored) continue;
      const field = await materializeCredential(store, stored.__purrSecret, hydrate); token[key] = field.value;
      if (field.secretState) states[key === "accessToken" ? "oauth-access-token" : "oauth-refresh-token"] = field.secretState;
    }
    return { ...copy, ...(Object.keys(states).length ? { credentialStates: states } : {}) };
  }
  const storedValue = marker(object.value);
  if (storedValue) {
    const field = await materializeCredential(store, storedValue.__purrSecret, hydrate);
    if (!field.secretState) {
      const { secretState: _state, secretRef: _ref, ...source } = object;
      return { ...source, value: field.value };
    }
    return { ...object, value: field.value, ...(field.secretState ? { secretState: { ...field.secretState, ...(storedValue.__purrEdit ? { edit: { kind: "delete" } } : {}) } } : {}) };
  }
  return Object.fromEntries(await Promise.all(Object.entries(object).map(async ([key, child]) => [key, await resolveRuntime(child, store, hydrate)])));
}
