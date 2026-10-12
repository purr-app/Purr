import type { SecretProtectionScope } from "../application/ports/credentials";

export type BrowserProtectionScope = SecretProtectionScope | { owner: "application"; kind: "journal" };
export type BrowserScopeKey = { id: string; key: CryptoKey };
export type BrowserEnvelope = { version: 1; scope: BrowserProtectionScope; keyId: string; generation: 1; context: string; iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer };
export class BrowserProtectedError extends Error {
  constructor(readonly status: "unavailable" | "corrupt", readonly code: string) { super(code); }
}
export const scopeIdentity = (scope: BrowserProtectionScope): string => JSON.stringify(scope.owner === "workspace"
  ? [scope.owner, scope.workspaceId, scope.kind] : [scope.owner, scope.kind]);
const aad = (scope: BrowserProtectionScope, keyId: string, context: string) => new TextEncoder().encode(JSON.stringify(["purr-preview-v3", 1, scopeIdentity(scope), keyId, 1, context]));
/** Preview keys are independent non-extractable browser keys, not desktop keys. */
export class BrowserScopeCrypto {
  constructor(private readonly getKey: (scope: BrowserProtectionScope, create: boolean) => Promise<BrowserScopeKey>) {}
  async seal(value: unknown, scope: BrowserProtectionScope, context: string): Promise<BrowserEnvelope> {
    const key = await this.getKey(scope, true);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(scope, key.id, context) }, key.key, new TextEncoder().encode(JSON.stringify(value)));
    return { version: 1, scope, keyId: key.id, generation: 1, context, iv, data };
  }
  async unseal<T>(value: BrowserEnvelope, scope: BrowserProtectionScope, context: string): Promise<T> {
    if (value.version !== 1 || value.generation !== 1 || value.context !== context || !value.scope || scopeIdentity(value.scope) !== scopeIdentity(scope))
      throw new BrowserProtectedError("corrupt", "browser-protected-scope-mismatch");
    const key = await this.getKey(scope, false);
    if (key.id !== value.keyId) throw new BrowserProtectedError("corrupt", "browser-protected-key-mismatch");
    try { return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: value.iv, additionalData: aad(scope, key.id, context) }, key.key, value.data))); }
    catch { throw new BrowserProtectedError("corrupt", "browser-protected-data-corrupt"); }
  }
}
