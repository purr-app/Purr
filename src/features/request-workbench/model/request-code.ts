import type { WireRequest } from "../services/http-client";

export type RequestCodeFormat = "curl" | "wget" | "http";

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function requestBody(request: WireRequest) {
  if (!request.bodyBase64) return "";
  const bytes = Uint8Array.from(atob(request.bodyBase64), (character) => character.charCodeAt(0));
  const text = new TextDecoder().decode(bytes);
  return text.includes("\uFFFD") ? `<binary body: ${bytes.length} bytes>` : text;
}

export function formatHttpRequest(request: WireRequest) {
  const url = new URL(request.url);
  const target = `${url.pathname || "/"}${url.search}`;
  const hasHost = request.headers.some(([name]) => name.toLowerCase() === "host");
  const headers = [
    ...(!hasHost ? [["Host", url.host] as [string, string]] : []),
    ...request.headers,
  ];
  const body = requestBody(request);
  return [
    `${request.method} ${target} HTTP/1.1`,
    ...headers.map(([name, value]) => `${name}: ${value}`),
    ...(body ? ["", body] : []),
  ].join("\n");
}

export function formatCurlRequest(request: WireRequest) {
  const body = requestBody(request);
  return [
    "curl",
    `  --request ${request.method}`,
    ...request.headers.map(([name, value]) => `  --header ${shellQuote(`${name}: ${value}`)}`),
    ...(body ? [`  --data-binary ${shellQuote(body)}`] : []),
    `  ${shellQuote(request.url)}`,
  ].join(" \\\n");
}

export function formatWgetRequest(request: WireRequest) {
  const body = requestBody(request);
  return [
    "wget",
    `  --method=${request.method}`,
    ...request.headers.map(([name, value]) => `  --header=${shellQuote(`${name}: ${value}`)}`),
    ...(body ? [`  --body-data=${shellQuote(body)}`] : []),
    "  --output-document=-",
    `  ${shellQuote(request.url)}`,
  ].join(" \\\n");
}

export function formatRequestCode(request: WireRequest, format: RequestCodeFormat) {
  if (format === "curl") return formatCurlRequest(request);
  if (format === "wget") return formatWgetRequest(request);
  return formatHttpRequest(request);
}
