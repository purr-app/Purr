import type { HttpMethod } from "../../../shared/model/http-method";

export type { HttpMethod } from "../../../shared/model/http-method";

export type RequestHeader = {
  id: string;
  name: string;
  value: string;
  enabled: boolean;
};

const validHeaderName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export type RequestDraft = {
  method: HttpMethod;
  url: string;
  headers: RequestHeader[];
};

export const initialRequestDraft: RequestDraft = {
  method: "GET",
  url: "https://api.example.com/users/42",
  headers: [{ id: "header-1", name: "", value: "", enabled: false }],
};

export function getEnabledRequestHeaderCount(headers: RequestHeader[]) {
  return headers.filter((header) => header.enabled && header.name.trim().length > 0).length;
}

export function isRequestHeaderNameValid(name: string) {
  return name.length === 0 || validHeaderName.test(name);
}

export function hasRequestHeaderValidationError(headers: RequestHeader[]) {
  return headers.some((header) => !isRequestHeaderNameValid(header.name));
}
