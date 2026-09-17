import type { ApplicationServices } from "../app/composition/application-services";
import type { IntegrationDefinition } from "../domain/project";
import { createRequestAuth, normalizeRequestAuth, resolveAuth, type AuthContext } from "../features/request-workbench/model/request-auth";
import { initialRequestDraft } from "../features/request-workbench/model/request";
import { prepareWireRequest } from "../features/request-workbench/services/execute-request";
import { fetchOAuthToken, resolvedOAuth } from "../features/request-workbench/services/oauth-client";

/** Reuse request composition, auth and variable resolution before crossing native IPC. */
export async function prepareIntegrationConnection(integration: IntegrationDefinition, workspaceId: string, context: AuthContext, services: ApplicationServices, signal: AbortSignal) {
  if (typeof integration.config.endpoint !== "string") return undefined;
  let auth = createRequestAuth();
  if (integration.config.auth === "request") {
    const ref = `purr/${workspaceId}/integrations/${integration.id}/auth`;
    const stored = await services.secureStore.get(ref);
    if (!stored) throw new Error("Integration authentication is unavailable. Open its settings to configure it.");
    auth = normalizeRequestAuth(JSON.parse(stored));
    const resolved = resolveAuth(auth, context);
    if (resolved.error) throw new Error(resolved.error);
    auth = resolved.auth;
    if (auth.type === "oauth2") {
      const token = auth.oauth2.token;
      if (!token || (auth.oauth2.autoRefresh && token.expiresAt !== undefined && token.expiresAt <= Date.now())) {
        if (!token && auth.oauth2.grantType === "authorization_code") throw new Error("Authorize this integration in its authentication settings first.");
        const next = await fetchOAuthToken(resolvedOAuth(auth.oauth2, context), token ? "refresh" : "initial", undefined, services.httpTransport, services.responseContent, signal);
        auth = { ...auth, oauth2: { ...auth.oauth2, token: next } };
        // Inherited profiles retain ownership of their tokens; do not overwrite the binding.
        if (normalizeRequestAuth(JSON.parse(stored)).type !== "inherit") await services.secureStore.set(ref, JSON.stringify(auth));
      }
    }
  } else if (integration.config.auth === "bearer") {
    auth.type = "bearer";
    auth.bearer.token = await services.secureStore.get(`purr/${workspaceId}/integrations/${integration.id}/apiToken`) ?? "";
  }
  const { request } = await prepareWireRequest({ ...initialRequestDraft, url: integration.config.endpoint, auth }, context);
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  return { endpoint: request.url, headers: request.headers };
}
