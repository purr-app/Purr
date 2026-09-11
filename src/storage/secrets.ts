import { secretRefSchema, type Credential, type SecretRef } from "../domain/project";
import type { SecureStore } from "./contracts";

export function secretRef(workspace: string, owner: string, field: string): SecretRef {
  return secretRefSchema.parse(`purr/${workspace}/${owner}/${field}`);
}
export class MemorySecureStore implements SecureStore {
  private values = new Map<string, string>();
  async get(ref: SecretRef) { return this.values.get(ref) ?? null; }
  async set(ref: SecretRef, value: string) { secretRefSchema.parse(ref); this.values.set(ref, value); }
  async delete(ref: SecretRef) { this.values.delete(ref); }
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
  private values = new Map<SecretRef, string | null>();
  constructor(private source: SecureStore) {}
  async get(ref: SecretRef) { if (!this.values.has(ref)) this.values.set(ref, await this.source.get(ref)); return this.values.get(ref)!; }
  async set(ref: SecretRef, value: string) { await this.source.set(ref, value); this.values.set(ref, value); }
  async delete(ref: SecretRef) { await this.source.delete(ref); this.values.delete(ref); }
  async exists(ref: SecretRef) { return await this.get(ref) !== null; }
  clear() { this.values.clear(); }
}

// Only credential-bearing fields are replaced. This also protects inactive editor
// modes and unsaved credentials, which must never be copied to SQLite plaintext.
export async function protectRuntime(value: unknown, store: SecureStore, workspace: string, owner: string): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item, i) => protectRuntime(item, store, workspace, `${owner}/${i}`)));
  if (!value || typeof value !== "object" || value instanceof File) return value;
  const object = value as Record<string, unknown>;
  const auth = "bearer" in object && "oauth2" in object && "inherit" in object;
  if (auth) {
    const copy = structuredClone(object) as Record<string, Record<string, unknown>>;
    for (const [group, keys] of Object.entries({ bearer: ["token", "receivedToken"], basic: ["password"], apiKey: ["value"], oauth2: ["clientSecret"] })) {
      for (const key of keys) {
        const text = copy[group]?.[key];
        if (typeof text === "string" && text) copy[group][key] = { __purrSecret: (await storeCredential(store, secretRef(workspace, owner, `${group}/${key}`), text)) };
      }
    }
    copy.bearer.responseError = "";
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
