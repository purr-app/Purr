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
  GET: { badge: "bg-[#1f4c3d] text-[#78e0b4]", text: "text-[#78e0b4]" },
  POST: { badge: "bg-[#354977] text-[#b8cbff]", text: "text-[#b8cbff]" },
  PUT: { badge: "bg-[#614928] text-[#ffc36d]", text: "text-[#ffc36d]" },
  PATCH: { badge: "bg-[#3d3930] text-[#f7c56e]", text: "text-[#f7c56e]" },
  DELETE: { badge: "bg-[#592d32] text-[#ffb4ab]", text: "text-[#ffb4ab]" },
  HEAD: { badge: "bg-[#343641] text-[#cbd1df]", text: "text-[#cbd1df]" },
  OPTIONS: { badge: "bg-[#343641] text-[#cbd1df]", text: "text-[#cbd1df]" },
  QUERY: { badge: "bg-[#234957] text-[#86d7f5]", text: "text-[#86d7f5]" },
};

export function getHttpMethodStyle(method: HttpMethod) {
  return methodStyles[method];
}
