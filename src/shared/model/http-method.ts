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

const methodStyles: Record<HttpMethod, { badge: string; text: string }> = {
  GET: {
    badge: "border border-action-emerald-border bg-action-emerald-surface text-method-get",
    text: "text-method-get",
  },
  POST: {
    badge: "border border-action-brand-border bg-action-brand-surface text-method-post",
    text: "text-method-post",
  },
  PUT: { badge: "bg-purr-highlight text-method-put", text: "text-method-put" },
  PATCH: { badge: "bg-purr-highlight text-method-patch", text: "text-method-patch" },
  DELETE: { badge: "bg-purr-highlight text-method-delete", text: "text-method-delete" },
  HEAD: { badge: "bg-purr-highlight text-method-head", text: "text-method-head" },
  OPTIONS: { badge: "bg-purr-highlight text-method-options", text: "text-method-options" },
  QUERY: {
    badge: "border border-action-brand-border bg-action-brand-surface text-action-brand",
    text: "text-action-brand",
  },
};

export function getHttpMethodStyle(method: HttpMethod) {
  return methodStyles[method];
}
