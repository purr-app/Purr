import type { SecretFieldState } from "./ports/credentials";

/** A committed local-value change invalidates loaded buffers, preserving new edits. */
export function invalidateSecretBuffers<T>(input: T, ref: string): T {
  const invalidate = (input: unknown): unknown => {
    if (!input || typeof input !== "object" || input instanceof File) return input;
    if (Array.isArray(input)) return input.map(invalidate);
    const object = input as Record<string, unknown>;
    // Provider configuration and extension JSON are not runtime credential buffers.
    if (object.kind === "integration" || object.kind === "extension") return object;
    const copy = Object.fromEntries(Object.entries(object).map(([key, child]) => [key, invalidate(child)]));
    const state = object.secretState as SecretFieldState | undefined;
    if ((state?.ref === ref || object.secretRef === ref) && (!state?.edit || state.edit.kind === "keep")) {
      copy.value = ""; copy.loaded = false; copy.secretState = { ref, status: "unresolved", edit: { kind: "keep" } };
    }
    if (object.credentialStates) {
      const states = copy.credentialStates as Record<string, SecretFieldState>;
      for (const [slot, state] of Object.entries(states)) if (state.ref === ref && (!state.edit || state.edit.kind === "keep")) {
        states[slot] = { ref, status: "unresolved", edit: { kind: "keep" } };
        const pair = { bearer: ["bearer", "token"], password: ["basic", "password"], "api-key": ["apiKey", "value"], "client-secret": ["oauth2", "clientSecret"] }[slot];
        if (pair) (copy[pair[0]] as Record<string, unknown>)[pair[1]] = "";
        else if (slot.startsWith("oauth-") && (copy.oauth2 as Record<string, unknown>)?.token)
          ((copy.oauth2 as Record<string, unknown>).token as Record<string, unknown>)[slot === "oauth-access-token" ? "accessToken" : "refreshToken"] = "";
      }
    }
    return copy;
  };
  return invalidate(input) as T;
}
