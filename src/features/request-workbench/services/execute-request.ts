import type { AuthRuntime } from "../hooks/use-auth-runtime";
import { getAuthBindingForRequest, resolveAuth, type AuthContext } from "../model/request-auth";
import { applyRequestPathParamsToUrl, applyRequestQueryParamsToUrl, getRequestHeaders, getRequestQueryParams, normalizeRequestUrlProtocol, type RequestDraft } from "../model/request";
import { getRequestBodyValidationMessage, serializeRequestBody } from "../model/request-body";
import type { SessionCookieJar } from "../model/cookie-jar";
import { resolveRequestEnvironment } from "../../workspaces/model/environment";
import { prepareGraphqlRequest } from "../../graphql/model/graphql";
import { encodeBody, executeHttp, requireHttpUrl } from "./http-client";
import type { HttpRequestSnapshot } from "../../../domain/http";
import type { HttpTransportPort } from "../../../application/ports/http";
import type { HttpTransportOptions } from "../../../application/ports/http";
import type { ResponseContentPort } from "../../../application/ports/response-content";

export async function prepareWireRequest(draft: RequestDraft, context: AuthContext): Promise<{
  request: HttpRequestSnapshot;
  displayRequest: HttpRequestSnapshot;
  sensitiveHeaders: string[];
  sensitiveQueryParams: string[];
}> {
  const resolved = resolveRequestEnvironment(draft, context.variables ?? {});
  const outgoing = prepareGraphqlRequest({
    ...resolved,
    url: applyRequestPathParamsToUrl(
      normalizeRequestUrlProtocol(resolved.url),
      resolved.pathParams,
    ),
  });
  const maskedVariables = Object.fromEntries(Object.entries(context.variables ?? {}).map(([name, value]) => [name,
    context.sensitiveVariableNames?.includes(name) ? "********" : value]));
  const maskedContext = { ...context, variables: maskedVariables };
  const maskedResolved = resolveRequestEnvironment(draft, maskedVariables);
  const maskedOutgoing = prepareGraphqlRequest({
    ...maskedResolved,
    url: applyRequestPathParamsToUrl(
      normalizeRequestUrlProtocol(maskedResolved.url),
      maskedResolved.pathParams,
    ),
  });
  const bodyError = getRequestBodyValidationMessage(outgoing.body);
  if (bodyError) throw new Error(bodyError);
  const authResult = getAuthBindingForRequest(outgoing.auth, outgoing.url, context);
  if (authResult.error) throw new Error(authResult.error);
  requireHttpUrl(outgoing.url);
  const makeRequest = async (source: RequestDraft, sourceContext: AuthContext, maskCredentials: boolean): Promise<HttpRequestSnapshot> => {
    const binding = getAuthBindingForRequest(source.auth, source.url, sourceContext).binding;
    const sensitiveQuery = maskCredentials && binding?.target === "query" ? binding.name.toLowerCase() : "";
    const url = new URL(applyRequestQueryParamsToUrl(source.url, getRequestQueryParams(source, sourceContext)));
    if (sensitiveQuery) for (const [name] of url.searchParams) if (name.toLowerCase() === sensitiveQuery) url.searchParams.set(name, "********");
    const headers = getRequestHeaders(source, sourceContext).filter((header) => header.enabled && header.name.trim()).map((header): [string, string] => {
      if (!maskCredentials || !header.secret) return [header.name, header.value];
      if (header.name.toLowerCase() === "authorization") return [header.name, `${header.value.split(/\s+/, 1)[0] || "Token"} ********`];
      if (header.name.toLowerCase() === "cookie") return [header.name, header.value.replace(/(^|;\s*)([^=;]+)=([^;]*)/g, "$1$2=********")];
      return [header.name, "********"];
    });
    return { url: url.toString(), method: source.method, headers, bodyBase64: await encodeBody(serializeRequestBody(source.body)) };
  };
  return {
    request: await makeRequest(outgoing, context, false),
    displayRequest: await makeRequest(maskedOutgoing, maskedContext, true),
    sensitiveHeaders: authResult.binding?.target === "header" ? [authResult.binding.name] : [],
    sensitiveQueryParams: authResult.binding?.target === "query" ? [authResult.binding.name] : [],
  };
}

// HTTP and GraphQL (including introspection) share the same credential, cookie,
// environment and native transport path.
export async function executeRequest(
  draft: RequestDraft,
  context: AuthContext,
  jar: SessionCookieJar,
  runtime: AuthRuntime,
  transport: HttpTransportPort,
  content?: ResponseContentPort,
  execution?: HttpTransportOptions,
) {
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
  const prepared = await prepareWireRequest({ ...draft, auth: effective.auth }, context);
  return executeHttp(prepared.request, {
    transport,
    jar: draft.useCookieJar ? jar : undefined,
    sensitiveHeaders: prepared.sensitiveHeaders,
    sensitiveQueryParams: prepared.sensitiveQueryParams,
    displayRequest: prepared.displayRequest,
    content,
    signal: execution?.signal,
    onProgress: execution?.onProgress,
    responseStorage: execution?.responseStorage,
  });
}
