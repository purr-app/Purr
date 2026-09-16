import type { AuthRuntime } from "../hooks/use-auth-runtime";
import { getAuthBindingForRequest, resolveAuth, type AuthContext } from "../model/request-auth";
import { applyRequestPathParamsToUrl, applyRequestQueryParamsToUrl, getRequestHeaders, getRequestQueryParams, normalizeRequestUrlProtocol, type RequestDraft } from "../model/request";
import { getActiveBodyFields, getRequestBodyValidationMessage, serializeRequestBody, type RequestBody } from "../model/request-body";
import type { SessionCookieJar } from "../model/cookie-jar";
import { resolveRequestEnvironment } from "../../workspaces/model/environment";
import { prepareGraphqlRequest } from "../../graphql/model/graphql";
import { encodeBody, executeHttp, requireHttpUrl } from "./http-client";
import type { HttpRequestBodySummary, HttpRequestSnapshot } from "../../../domain/http";
import type { HttpTransportPort, PreparedHttpTransportRequest, PreparedRequestBody, RequestFileRef } from "../../../application/ports/http";
import type { HttpTransportOptions } from "../../../application/ports/http";
import type { ResponseContentPort } from "../../../application/ports/response-content";
import type { RequestBodyPort } from "../../../application/ports/platform";

async function prepareBody(
  body: RequestBody,
  options: {
    fileMode: "inline" | "native" | "summary";
    requestBodies?: RequestBodyPort;
  },
): Promise<{
  bodyBase64: string | null;
  bodySource?: PreparedRequestBody;
  bodySummary?: HttpRequestBodySummary;
  references: RequestFileRef[];
}> {
  const fallback = async () => ({
    bodyBase64: await encodeBody(serializeRequestBody(body)),
    references: [] as RequestFileRef[],
  });
  const activeFields = body.type === "form-data" ? getActiveBodyFields(body) : [];
  const hasMultipartFile = activeFields.some(
    (field) => field.fieldType === "file" && field.attachment,
  );
  if (options.fileMode === "summary") {
    if (body.type === "binary" && body.binary)
      return {
        bodyBase64: null,
        bodySummary: {
          kind: "file",
          fileName: body.binary.file.name,
          byteLength: body.binary.file.size,
          mediaType: body.binary.file.type || "application/octet-stream",
        },
        references: [],
      };
    if (body.type === "form-data" && hasMultipartFile)
      return {
        bodyBase64: null,
        bodySummary: {
          kind: "multipart",
          partCount: activeFields.length,
          files: activeFields.flatMap((field) =>
            field.fieldType === "file" && field.attachment
              ? [{
                  fileName: field.attachment.name,
                  byteLength: field.attachment.size,
                  mediaType: field.attachment.type || "application/octet-stream",
                }]
              : [],
          ),
        },
        references: [],
      };
    return fallback();
  }
  if (options.fileMode === "inline") return fallback();
  const requestBodies = options.requestBodies;
  if (!requestBodies)
    throw new Error("Native request body storage is unavailable.");
  if (body.type === "binary") {
    if (!body.binary) return { bodyBase64: null, references: [] };
    const reference = await requestBodies.stage(body.binary.file);
    return { bodyBase64: null, bodySource: { kind: "file", reference }, references: [reference] };
  }
  if (body.type !== "form-data" || !hasMultipartFile)
    return fallback();

  const references: RequestFileRef[] = [];
  try {
    const parts: Extract<PreparedRequestBody, { kind: "multipart" }>["parts"][number][] = [];
    for (const field of activeFields) {
      if (field.fieldType === "file" && field.attachment) {
        const reference = await requestBodies.stage(field.attachment);
        references.push(reference);
        parts.push({ kind: "file", name: field.key, reference });
      } else {
        parts.push({
          kind: "text",
          name: field.key,
          value: field.value.replace(/\r?\n/g, "\r\n"),
          mediaType: field.contentType || "text/plain",
        });
      }
    }
    return { bodyBase64: null, bodySource: { kind: "multipart", parts }, references };
  } catch (cause) {
    await Promise.all(references.map((reference) => requestBodies.release(reference).catch(() => {})));
    throw cause;
  }
}

export async function prepareWireRequest(
  draft: RequestDraft,
  context: AuthContext,
  options: {
    fileMode?: "inline" | "native" | "summary";
    requestBodies?: RequestBodyPort;
  } = {},
): Promise<{
  request: PreparedHttpTransportRequest;
  displayRequest: HttpRequestSnapshot;
  sensitiveHeaders: string[];
  sensitiveQueryParams: string[];
  bodyReferences: RequestFileRef[];
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
  const preparedBody = await prepareBody(outgoing.body, {
    fileMode: options.fileMode ?? (options.requestBodies ? "native" : "inline"),
    requestBodies: options.requestBodies,
  });
  try {
    const bodySummary: HttpRequestBodySummary | undefined = preparedBody.bodySummary ?? (preparedBody.bodySource?.kind === "file"
      ? {
          kind: "file",
          fileName: preparedBody.bodySource.reference.name,
          byteLength: preparedBody.bodySource.reference.size,
          mediaType: preparedBody.bodySource.reference.mediaType,
        }
      : preparedBody.bodySource?.kind === "multipart"
        ? {
            kind: "multipart",
            partCount: preparedBody.bodySource.parts.length,
            files: preparedBody.bodySource.parts.flatMap((part) => part.kind === "file"
              ? [{
                  fileName: part.reference.name,
                  byteLength: part.reference.size,
                  mediaType: part.reference.mediaType,
                }]
              : []),
          }
        : undefined);
    const maskedBodyBase64 = preparedBody.bodySource || preparedBody.bodySummary
      ? null
      : await encodeBody(serializeRequestBody(maskedOutgoing.body));
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
      return {
        url: url.toString(),
        method: source.method,
        headers,
        bodyBase64: maskCredentials ? maskedBodyBase64 : preparedBody.bodyBase64,
        ...(bodySummary ? { bodySummary } : {}),
      };
    };
    const request = await makeRequest(outgoing, context, false);
    return {
      request: { ...request, ...(outgoing.tracePropagation ? { tracePropagation: outgoing.tracePropagation } : {}), ...(preparedBody.bodySource ? { bodySource: preparedBody.bodySource } : {}) },
      displayRequest: await makeRequest(maskedOutgoing, maskedContext, true),
      sensitiveHeaders: authResult.binding?.target === "header" ? [authResult.binding.name] : [],
      sensitiveQueryParams: authResult.binding?.target === "query" ? [authResult.binding.name] : [],
      bodyReferences: preparedBody.references,
    };
  } catch (cause) {
    if (options.requestBodies)
      await Promise.all(preparedBody.references.map((reference) => options.requestBodies!.release(reference).catch(() => {})));
    throw cause;
  }
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
  requestBodies?: RequestBodyPort,
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
  const prepared = await prepareWireRequest(
    { ...draft, auth: effective.auth },
    context,
    {
      fileMode: requestBodies ? "native" : "inline",
      requestBodies,
    },
  );
  try {
    return await executeHttp(prepared.request, {
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
  } finally {
    if (requestBodies)
      await Promise.all(prepared.bodyReferences.map((reference) => requestBodies.release(reference).catch(() => {})));
  }
}
