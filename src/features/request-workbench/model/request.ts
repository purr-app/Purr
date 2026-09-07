import type { HttpMethod } from "../../../shared/model/http-method";
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
};

export type RequestQueryParam = {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
};

const validHeaderName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export type RequestDraft = {
  method: HttpMethod;
  url: string;
  params: RequestQueryParam[];
  headers: RequestHeader[];
  body: RequestBody;
};

export const initialRequestDraft: RequestDraft = {
  method: "GET",
  url: "https://api.example.com/users/42",
  params: [{ id: "param-1", key: "", value: "", enabled: false }],
  headers: [{ id: "header-1", name: "", value: "", enabled: false }],
  body: createRequestBody(),
};

const bodyContentTypeHeaderId = "body-content-type";
const isContentTypeHeader = (header: RequestHeader) =>
  header.name.trim().toLowerCase() === "content-type";

// Body owns the effective Content-Type. A manual value is kept in the draft and
// becomes visible again when None is selected, without sending duplicate headers.
export function getRequestHeaders(draft: RequestDraft): RequestHeader[] {
  const contentType = getBodyContentType(draft.body);
  if (!contentType) return draft.headers;
  return [
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
}

export function updateRequestHeaders(
  draft: RequestDraft,
  headers: RequestHeader[],
): RequestDraft {
  if (!getBodyContentType(draft.body)) return { ...draft, headers };
  const manualContentTypes = draft.headers.filter(isContentTypeHeader);
  return {
    ...draft,
    headers: [
      ...manualContentTypes,
      ...headers.filter(
        (header) =>
          header.id !== bodyContentTypeHeaderId && !isContentTypeHeader(header),
      ),
    ],
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
  return name.length === 0 || validHeaderName.test(name);
}

export function hasRequestHeaderValidationError(headers: RequestHeader[]) {
  return headers.some((header) => !isRequestHeaderNameValid(header.name));
}
