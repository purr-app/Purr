import type { HttpMethod } from "../../../shared/model/http-method";
import {
  createRequestAuth,
  getAuthBindingForRequest,
  type AuthContext,
  type RequestAuth,
} from "./request-auth";
import {
  createRequestBody,
  getBodyContentType,
  type RequestBody,
} from "./request-body";

export {
  createEmptyRequestBodyField,
  getRequestBodyValidationMessage,
} from "./request-body";
export type {
  RequestBody,
  RequestBodyField,
  RequestBinaryFile,
  RequestBodyType,
} from "./request-body";

export type { HttpMethod } from "../../../shared/model/http-method";

export type RequestHeader = {
  id: string;
  name: string;
  value: string;
  enabled: boolean;
  readOnly?: boolean;
  readOnlyReason?: string;
  secret?: boolean;
  workspaceHeaderId?: string;
};

export type RequestQueryParam = {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  readOnly?: boolean;
  readOnlyReason?: string;
  secret?: boolean;
};

export type RequestPathParam = {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
};

const validHeaderName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export type RequestDraft = {
  environmentId?: string;
  graphql?: { query: string; variables: string; operationName: string; schemaId?: string };
  documentation: string;
  method: HttpMethod;
  url: string;
  params: RequestQueryParam[];
  pathParams?: RequestPathParam[];
  headers: RequestHeader[];
  body: RequestBody;
  auth: RequestAuth;
  useCookieJar: boolean;
  workspace: RequestWorkspaceOverrides;
};

export type RequestWorkspaceOverrides = {
  headersEnabled: boolean;
  authEnabled: boolean;
  headerOverrides: Record<string, boolean>;
};

export function createRequestWorkspaceOverrides(): RequestWorkspaceOverrides {
  return { headersEnabled: true, authEnabled: true, headerOverrides: {} };
}

export const initialRequestDraft: RequestDraft = {
  documentation: "",
  method: "GET",
  url: "https://api.example.com/users/42",
  params: [{ id: "param-1", key: "", value: "", enabled: false }],
  pathParams: [],
  headers: [{ id: "header-1", name: "", value: "", enabled: false }],
  body: createRequestBody(),
  auth: createRequestAuth(),
  useCookieJar: true,
  workspace: createRequestWorkspaceOverrides(),
};

const bodyContentTypeHeaderId = "body-content-type";
const isContentTypeHeader = (header: RequestHeader) =>
  header.name.trim().toLowerCase() === "content-type";

// Body owns the effective Content-Type. A manual value is kept in the draft and
// becomes visible again when None is selected, without sending duplicate headers.
export function getRequestHeaders(
  draft: RequestDraft,
  context: AuthContext = {},
): RequestHeader[] {
  const contentType = draft.graphql ? "application/json" : getBodyContentType(draft.body);
  let headers = draft.headers;
  if (contentType)
    headers = [
      {
        id: bodyContentTypeHeaderId,
        name: "Content-Type",
        value: contentType,
        enabled: true,
        readOnly: true,
        readOnlyReason: "Set automatically by the selected body type",
      },
      ...draft.headers.filter((header) => !isContentTypeHeader(header)),
    ];
  const { binding } = getAuthBindingForRequest(
    draft.auth,
    draft.url,
    context,
  );
  if (binding?.target === "header") {
    headers = [
      {
        id: "auth-header",
        name: binding.name,
        value: binding.value,
        enabled: true,
        readOnly: true,
        secret: true,
        readOnlyReason:
          "Managed by Auth. Edit the credentials in the Auth tab.",
      },
      ...headers.filter(
        (header) =>
          header.name.trim().toLowerCase() !== binding.name.toLowerCase(),
      ),
    ];
  }
  if (binding?.target === "cookie") {
    const manual = headers
      .filter(
        (header) => header.enabled && header.name.toLowerCase() === "cookie",
      )
      .flatMap((header) => header.value.split(";"))
      .map((part) => part.trim())
      .filter((part) => part && part.split("=")[0] !== binding.name);
    headers = [
      {
        id: "auth-header",
        name: "Cookie",
        value: [...manual, `${binding.name}=${binding.value}`].join("; "),
        enabled: true,
        readOnly: true,
        secret: true,
        readOnlyReason:
          "API key cookie managed by Auth. Session cookies are added from the cookie jar on send.",
      },
      ...headers.filter((header) => header.name.toLowerCase() !== "cookie"),
    ];
  }
  return headers;
}

export function updateRequestHeaders(
  draft: RequestDraft,
  headers: RequestHeader[],
  context: AuthContext = {},
): RequestDraft {
  const managedNames = new Set(
    getRequestHeaders(draft, context)
      .filter((header) => header.readOnly)
      .map((header) => header.name.toLowerCase()),
  );
  return {
    ...draft,
    headers: [
      ...draft.headers.filter((header) =>
        managedNames.has(header.name.toLowerCase()),
      ),
      ...headers.filter(
        (header) =>
          !header.readOnly && !managedNames.has(header.name.toLowerCase()),
      ),
    ],
  };
}

export function getRequestQueryParams(
  draft: RequestDraft,
  context: AuthContext = {},
): RequestQueryParam[] {
  const { binding } = getAuthBindingForRequest(
    draft.auth,
    draft.url,
    context,
  );
  if (binding?.target !== "query") return draft.params;
  return [
    {
      id: "auth-query",
      key: binding.name,
      value: binding.value,
      enabled: true,
      readOnly: true,
      secret: true,
      readOnlyReason:
        "Managed by Auth. Added to the URL when the request is sent.",
    },
    ...draft.params.filter((param) => param.key !== binding.name),
  ];
}

export function updateRequestQueryParams(
  draft: RequestDraft,
  params: RequestQueryParam[],
  context: AuthContext = {},
): RequestDraft {
  const managed = getRequestQueryParams(draft, context)
    .filter((param) => param.readOnly)
    .map((param) => param.key);
  const next = [
    ...draft.params.filter((param) => managed.includes(param.key)),
    ...params.filter(
      (param) => !param.readOnly && !managed.includes(param.key),
    ),
  ];
  return {
    ...draft,
    params: next,
    url: applyRequestQueryParamsToUrl(draft.url, next),
  };
}

function getHighestQueryParamId(params: RequestQueryParam[]) {
  return params.reduce((highest, param) => {
    const id = Number(param.id.replace("param-", ""));
    return Number.isFinite(id) ? Math.max(highest, id) : highest;
  }, 0);
}

export function createEmptyRequestQueryParam(
  params: RequestQueryParam[] = [],
): RequestQueryParam {
  return {
    id: `param-${getHighestQueryParamId(params) + 1}`,
    key: "",
    value: "",
    enabled: false,
  };
}

export function getEnabledRequestQueryParamCount(params: RequestQueryParam[]) {
  return params.filter((param) => param.enabled && param.key.trim().length > 0)
    .length;
}

export function getEnabledRequestPathParamCount(params: RequestPathParam[]) {
  return params.filter((param) => param.enabled && param.key.trim().length > 0)
    .length;
}

export function getRequestQueryParamsFromUrl(
  url: string,
  currentParams: RequestQueryParam[] = [],
) {
  const hashIndex = url.indexOf("#");
  const urlWithoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = urlWithoutHash.indexOf("?");
  const query = queryIndex >= 0 ? urlWithoutHash.slice(queryIndex + 1) : "";
  const searchParams = new URLSearchParams(query);
  const populatedParams = currentParams.filter(
    (param) => param.key.length > 0 || param.value.length > 0,
  );
  const nextId = getHighestQueryParamId(currentParams);
  const params = Array.from(searchParams.entries()).map(
    ([key, value], index) => ({
      id: populatedParams[index]?.id ?? `param-${nextId + index + 1}`,
      key,
      value,
      enabled: true,
    }),
  );
  const emptyParam = currentParams.find(
    (param) => param.key.length === 0 && param.value.length === 0,
  );

  return [
    ...params,
    emptyParam
      ? { ...emptyParam, enabled: false }
      : createEmptyRequestQueryParam([...currentParams, ...params]),
  ];
}

function getHighestPathParamId(params: RequestPathParam[]) {
  return params.reduce((highest, param) => {
    const id = Number(param.id.replace("path-param-", ""));
    return Number.isFinite(id) ? Math.max(highest, id) : highest;
  }, 0);
}

export function getRequestPathParamsFromUrl(
  url: string,
  currentParams: RequestPathParam[] = [],
): RequestPathParam[] {
  const path = url.split(/[?#]/, 1)[0] ?? "";
  const names = Array.from(
    path.matchAll(/(?:^|\/):([A-Za-z_][A-Za-z0-9_-]*)(?=\/|$)/g),
    (match) => match[1],
  );
  const remaining = [...currentParams];
  const highestId = getHighestPathParamId(currentParams);

  return names.map((key, index) => {
    const existingAt = remaining.findIndex((param) => param.key === key);
    const existing = existingAt >= 0 ? remaining.splice(existingAt, 1)[0] : undefined;
    return existing ?? {
      id: `path-param-${highestId + index + 1}`,
      key,
      value: "",
      enabled: true,
    };
  });
}

export function getRequestPathParams(draft: RequestDraft) {
  return getRequestPathParamsFromUrl(draft.url, draft.pathParams);
}

export function updateRequestPathParams(
  draft: RequestDraft,
  pathParams: RequestPathParam[],
): RequestDraft {
  return { ...draft, pathParams };
}

export function applyRequestPathParamsToUrl(
  url: string,
  pathParams: RequestPathParam[] = [],
) {
  const values = new Map(
    pathParams
      .filter((param) => param.enabled && param.key && param.value)
      .map((param) => [param.key, param.value]),
  );
  const [path, suffix = ""] = url.split(/([?#][\s\S]*)/, 2);
  return `${path.replace(/(?:^|\/):([A-Za-z_][A-Za-z0-9_-]*)(?=\/|$)/g, (segment, key: string) => {
    const value = values.get(key);
    return value === undefined ? segment : segment.replace(`:${key}`, encodeURIComponent(value));
  })}${suffix}`;
}

export function normalizeRequestUrlProtocol(url: string) {
  const value = url.trim();
  if (!value || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) || value.startsWith("{{")) return value;
  const host = value.split(/[/?#]/, 1)[0].toLowerCase();
  const isLocal = host === "localhost" || host.startsWith("localhost:")
    || /^(?:127(?:\.\d{1,3}){3}|0\.0\.0\.0)(?::\d+)?$/.test(host);
  return `${isLocal ? "http" : "https"}://${value}`;
}

export function applyRequestQueryParamsToUrl(
  url: string,
  params: RequestQueryParam[],
) {
  const hashIndex = url.indexOf("#");
  const urlWithoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const queryIndex = urlWithoutHash.indexOf("?");
  const baseUrl =
    queryIndex >= 0 ? urlWithoutHash.slice(0, queryIndex) : urlWithoutHash;
  const searchParams = new URLSearchParams();

  params.forEach((param) => {
    if (param.enabled && param.key.trim().length > 0)
      searchParams.append(param.key, param.value);
  });

  const query = searchParams.toString();
  return `${baseUrl}${query ? `?${query}` : ""}${hash}`;
}

export function getEnabledRequestHeaderCount(headers: RequestHeader[]) {
  return headers.filter(
    (header) => header.enabled && header.name.trim().length > 0,
  ).length;
}

export function isRequestHeaderNameValid(name: string) {
  return name.length === 0 || validHeaderName.test(name.replace(/\{\{\s*[^{}]+?\s*\}\}/g, "variable"));
}

export function hasRequestHeaderValidationError(headers: RequestHeader[]) {
  return headers.some((header) => !isRequestHeaderNameValid(header.name));
}
