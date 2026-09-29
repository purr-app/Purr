import type { ResponseContentPort } from "../../../application/ports/response-content";
import type { AuthRuntime } from "../hooks/use-auth-runtime";
import type { RequestDraft } from "../model/request";
import { resolveAuth, type AuthContext, type OAuthToken } from "../model/request-auth";
import type { HttpTransport } from "./http-client";
import { fetchOAuthToken, resolvedOAuth } from "./oauth-client";

/** OAuth acquisition belongs to the dependency snapshot, never the open editor. */
export function createDependencyAuthRuntime(
  draft: RequestDraft,
  context: AuthContext,
  transport: HttpTransport,
  responseContent?: ResponseContentPort,
  signal?: AbortSignal,
): AuthRuntime {
  const abort = new AbortController();
  let pending: Promise<OAuthToken | null> | undefined;
  const runtime: AuthRuntime = {
    busy: false,
    authorizing: false,
    error: "",
    now: Date.now(),
    cancel: () => abort.abort(),
    clearError: () => { runtime.error = ""; },
    run: (action) => {
      if (pending) return pending;
      runtime.busy = true;
      runtime.error = "";
      const cancel = () => abort.abort();
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
      pending = Promise.resolve().then(async () => {
        abort.signal.throwIfAborted();
        const effective = resolveAuth(draft.auth, context);
        if (effective.error) throw new Error(effective.error);
        if (effective.auth.type !== "oauth2") return null;
        const config = resolvedOAuth(effective.auth.oauth2, context);
        if (action === "initial" && config.grantType === "authorization_code") {
          throw new Error("Open the dependency request and authorize in your browser first.");
        }
        const token = await fetchOAuthToken(config, action, undefined, transport, responseContent, abort.signal);
        abort.signal.throwIfAborted();
        // The token is execution-local. Saved source and inherited auth remain unchanged.
        return token;
      }).catch((cause: unknown) => {
        runtime.error = cause instanceof Error ? cause.message : String(cause);
        throw cause;
      }).finally(() => {
        signal?.removeEventListener("abort", cancel);
        runtime.busy = false;
        pending = undefined;
      });
      return pending;
    },
  };
  return runtime;
}
