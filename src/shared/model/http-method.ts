import { httpMethodShortcutIds, keyboardShortcuts } from "../config/keyboard-shortcuts";

export const httpMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "QUERY"] as const;

export type HttpMethod = (typeof httpMethods)[number];

export type HttpMethodDefinition = {
  value: HttpMethod;
  title: string;
  description: string;
  group: "standard" | "diagnostic";
};

export const httpMethodDefinitions: HttpMethodDefinition[] = [
  { value: "GET", title: "Retrieve resource", description: "Safe · Idempotent", group: "standard" },
  { value: "POST", title: "Create or execute action", description: "Non-idempotent · Body required", group: "standard" },
  { value: "PUT", title: "Replace entire entity", description: "Idempotent replacement", group: "standard" },
  { value: "PATCH", title: "Partial entity modification", description: "Delta payload apply", group: "standard" },
  { value: "DELETE", title: "Remove specified resource", description: "Idempotent removal", group: "standard" },
  { value: "HEAD", title: "Headers only (no response body)", description: "Cache check · Content length", group: "diagnostic" },
  { value: "OPTIONS", title: "Query communication options", description: "CORS preflight discovery", group: "diagnostic" },
  { value: "QUERY", title: "Query a resource", description: "Safe query with a request body", group: "diagnostic" },
];

export function getHttpMethodShortcut(method: HttpMethod) {
  return keyboardShortcuts[httpMethodShortcutIds[method]];
}

export const httpMethodShortcutKeys = httpMethods.map((method) => getHttpMethodShortcut(method).hotkey).join(",");

const methodStyles: Record<HttpMethod, { text: string }> = {
  GET: {
    text: "text-method-get",
  },
  POST: {
    text: "text-method-post",
  },
  PUT: { text: "text-method-put" },
  PATCH: { text: "text-method-patch" },
  DELETE: { text: "text-method-delete" },
  HEAD: { text: "text-method-head" },
  OPTIONS: { text: "text-method-options" },
  QUERY: {
    text: "text-action-brand",
  },
};

export function getHttpMethodStyle(method: HttpMethod) {
  return methodStyles[method];
}
