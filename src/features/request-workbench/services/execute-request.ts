import type { AuthRuntime } from "../hooks/use-auth-runtime";
import { getAuthBindingForRequest, resolveAuth, type AuthContext } from "../model/request-auth";
import { applyRequestQueryParamsToUrl, getRequestHeaders, getRequestQueryParams, type RequestDraft } from "../model/request";
import { getRequestBodyValidationMessage, serializeRequestBody } from "../model/request-body";
import type { SessionCookieJar } from "../model/cookie-jar";
import { resolveRequestEnvironment } from "../../workspaces/model/environment";
import { prepareGraphqlRequest } from "../../graphql/model/graphql";
import { encodeBody, executeHttp } from "./http-client";

// HTTP and GraphQL (including introspection) share the same credential, cookie,
// environment and native transport path.
export async function executeRequest(draft: RequestDraft, context: AuthContext, jar: SessionCookieJar, runtime: AuthRuntime) {
  const resolved = prepareGraphqlRequest(resolveRequestEnvironment(draft, context.variables ?? {}));
  const bodyError = getRequestBodyValidationMessage(resolved.body);
  if (bodyError) throw new Error(bodyError);
  let effective = resolveAuth(draft.auth, context);
  if (effective.error) throw new Error(effective.error);
  if (effective.auth.type === "oauth2") {
    const config = effective.auth.oauth2;
    let token = config.token;
    if (!token || (config.autoRefresh && token.expiresAt !== undefined && token.expiresAt <= Date.now())) {
      if (!token && config.grantType === "authorization_code") throw new Error("Open Auth and authorize in your browser first.");
      token = await runtime.run(token ? "refresh" : "initial");
      if (!token) throw new Error("Could not obtain an access token. See Auth for details.");
    }
    if (token.expiresAt !== undefined && token.expiresAt <= Date.now()) throw new Error("Access token expired. Refresh it in Auth before sending.");
    effective = { ...effective, auth: { ...effective.auth, oauth2: { ...config, token } } };
  }
  const outgoing = { ...resolved, auth: effective.auth };
  const authResult = getAuthBindingForRequest(outgoing.auth, outgoing.url, context);
  if (authResult.error) throw new Error(authResult.error);
  return executeHttp({
    url: applyRequestQueryParamsToUrl(outgoing.url, getRequestQueryParams(outgoing, context)),
    method: outgoing.method,
    headers: getRequestHeaders(outgoing, context).filter((header) => header.enabled && header.name.trim()).map((header) => [header.name, header.value]),
    bodyBase64: await encodeBody(serializeRequestBody(outgoing.body)),
  }, {
    jar: draft.useCookieJar ? jar : undefined,
    sensitiveHeaders: authResult.binding?.target === "header" ? [authResult.binding.name] : [],
    sensitiveQueryParams: authResult.binding?.target === "query" ? [authResult.binding.name] : [],
  });
}
