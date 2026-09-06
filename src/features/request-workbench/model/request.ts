import type { HttpMethod } from "../../../shared/model/http-method";

export type { HttpMethod } from "../../../shared/model/http-method";

export type RequestHeader = {
  id: string;
  name: string;
  value: string;
  enabled: boolean;
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
};

export const initialRequestDraft: RequestDraft = {
  method: "GET",
  url: "https://api.example.com/users/42",
  params: [{ id: "param-1", key: "", value: "", enabled: false }],
  headers: [{ id: "header-1", name: "", value: "", enabled: false }],
};

function getHighestQueryParamId(params: RequestQueryParam[]) {
  return params.reduce((highest, param) => {
    const id = Number(param.id.replace("param-", ""));
    return Number.isFinite(id) ? Math.max(highest, id) : highest;
  }, 0);
}

export function createEmptyRequestQueryParam(params: RequestQueryParam[] = []): RequestQueryParam {
  return {
    id: `param-${getHighestQueryParamId(params) + 1}`,
    key: "",
    value: "",
    enabled: false,
  };
}

export function getEnabledRequestQueryParamCount(params: RequestQueryParam[]) {
  return params.filter((param) => param.enabled && param.key.trim().length > 0).length;
}

export function getRequestQueryParamsFromUrl(url: string, currentParams: RequestQueryParam[] = []) {
  const hashIndex = url.indexOf("#");
  const urlWithoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = urlWithoutHash.indexOf("?");
  const query = queryIndex >= 0 ? urlWithoutHash.slice(queryIndex + 1) : "";
  const searchParams = new URLSearchParams(query);
  const populatedParams = currentParams.filter((param) => param.key.length > 0 || param.value.length > 0);
  const nextId = getHighestQueryParamId(currentParams);
  const params = Array.from(searchParams.entries()).map(([key, value], index) => ({
    id: populatedParams[index]?.id ?? `param-${nextId + index + 1}`,
    key,
    value,
    enabled: true,
  }));
  const emptyParam = currentParams.find((param) => param.key.length === 0 && param.value.length === 0);

  return [...params, emptyParam ? { ...emptyParam, enabled: false } : createEmptyRequestQueryParam([...currentParams, ...params])];
}

export function applyRequestQueryParamsToUrl(url: string, params: RequestQueryParam[]) {
  const hashIndex = url.indexOf("#");
  const urlWithoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const queryIndex = urlWithoutHash.indexOf("?");
  const baseUrl = queryIndex >= 0 ? urlWithoutHash.slice(0, queryIndex) : urlWithoutHash;
  const searchParams = new URLSearchParams();

  params.forEach((param) => {
    if (param.enabled && param.key.trim().length > 0) searchParams.append(param.key, param.value);
  });

  const query = searchParams.toString();
  return `${baseUrl}${query ? `?${query}` : ""}${hash}`;
}

export function getEnabledRequestHeaderCount(headers: RequestHeader[]) {
  return headers.filter((header) => header.enabled && header.name.trim().length > 0).length;
}

export function isRequestHeaderNameValid(name: string) {
  return name.length === 0 || validHeaderName.test(name);
}

export function hasRequestHeaderValidationError(headers: RequestHeader[]) {
  return headers.some((header) => !isRequestHeaderNameValid(header.name));
}
