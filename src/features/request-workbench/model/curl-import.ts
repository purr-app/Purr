import type { HttpMethod } from "../../../shared/model/http-method";
import { createEmptyRequestBodyField, createRequestBody } from "./request-body";
import { getRequestQueryParamsFromUrl, type RequestDraft, type RequestHeader } from "./request";
import { createRequestAuth, type RequestAuth } from "./request-auth";

export type CurlImportSecret = {
  headerId: string;
  headerName: string;
  value: string;
};

export type CurlImport = {
  request: RequestDraft;
  /**
   * Credentials that do not map to Purr's Auth model. The workspace layer
   * replaces them with sensitive variables before the imported request is
   * persisted, so the source cURL value never reaches project YAML.
   */
  secrets: CurlImportSecret[];
};

const curlCommand = /^\s*(?:\$\s*)?curl(?:\.exe)?(?:\s|$)/i;
const apiKeyName = /^(?:x[-_])?(?:api[-_]?key|api[-_]?token|access[-_]?token|auth[-_]?token|token)$/i;
const sensitiveHeaderName = /^(?:authorization|proxy-authorization|cookie|set-cookie|x[-_].*(?:api[-_]?key|token|secret|password)|.*(?:api[-_]?key|token|secret|password))$/i;

export function isCurlCommand(value: string) {
  return curlCommand.test(value);
}

function tokenizeShell(value: string) {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const push = () => {
    if (!token) return;
    tokens.push(token);
    token = "";
  };
  for (const character of value.trim()) {
    if (escaped) {
      if (character !== "\n") token += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      push();
    } else {
      token += character;
    }
  }
  if (quote) throw new Error("The cURL command contains an unterminated quote.");
  if (escaped) token += "\\";
  push();
  return tokens;
}

function optionValue(tokens: string[], index: number, short: string, long: string) {
  const token = tokens[index];
  if (token === short || token === long) return { value: tokens[index + 1] ?? "", consumed: 1 };
  if (token.startsWith(`${long}=`)) return { value: token.slice(long.length + 1), consumed: 0 };
  if (short.length === 2 && token.startsWith(short) && token.length > 2) return { value: token.slice(2), consumed: 0 };
  return null;
}

const ignoredValueOptions = new Set(["-m", "--max-time", "--connect-timeout", "--proxy"]);

function decodeBasicCredentials(value: string) {
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function basicAuth(value: string): RequestAuth | null {
  const separator = value.indexOf(":");
  if (separator < 0) return null;
  const auth = createRequestAuth();
  auth.type = "basic";
  auth.basic = { username: value.slice(0, separator), password: value.slice(separator + 1) };
  return auth;
}

function authorizationAuth(value: string): RequestAuth | null {
  const basic = value.match(/^Basic\s+(.+)$/i);
  if (basic) return basicAuth(decodeBasicCredentials(basic[1].trim()) ?? "");
  const parts = value.match(/^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s+(\S+)$/);
  if (!parts) return null;
  const auth = createRequestAuth();
  auth.type = "bearer";
  auth.bearer = { prefix: parts[1], token: parts[2] };
  return auth;
}

function takeApiKeyFromUrl(url: string) {
  const hashIndex = url.indexOf("#");
  const urlWithoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const queryIndex = urlWithoutHash.indexOf("?");
  if (queryIndex < 0) return { url, apiKey: null as null | { name: string; value: string } };
  const base = urlWithoutHash.slice(0, queryIndex);
  const search = new URLSearchParams(urlWithoutHash.slice(queryIndex + 1));
  const candidate = Array.from(search.entries()).find(([name, value]) => apiKeyName.test(name) && Boolean(value));
  if (!candidate) return { url, apiKey: null as null | { name: string; value: string } };
  const [name, value] = candidate;
  search.delete(name);
  const remaining = search.toString();
  return { url: `${base}${remaining ? `?${remaining}` : ""}${hash}`, apiKey: { name, value } };
}

function apiKeyAuth(name: string, value: string, placement: "header" | "query"): RequestAuth {
  const auth = createRequestAuth();
  auth.type = "api-key";
  auth.apiKey = { name, value, placement };
  return auth;
}

function appendHeader(headers: RequestHeader[], name: string, value: string) {
  headers.push({ id: `header-${headers.length + 1}`, name, value, enabled: true });
}

export function importCurl(command: string, base: RequestDraft): CurlImport {
  const tokens = tokenizeShell(command);
  if (tokens[0] === "$") tokens.shift();
  const executable = tokens.shift()?.toLowerCase();
  if (executable !== "curl" && executable !== "curl.exe") throw new Error("Clipboard content is not a cURL command.");
  let method: HttpMethod | undefined;
  let url = "";
  let useGet = false;
  let useHead = false;
  let userCredentials = "";
  let oauthBearer = "";
  const headers: RequestHeader[] = [];
  const data: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const request = optionValue(tokens, index, "-X", "--request");
    const header = optionValue(tokens, index, "-H", "--header");
    const user = optionValue(tokens, index, "-u", "--user");
    const bearer = optionValue(tokens, index, "", "--oauth2-bearer");
    const userAgent = optionValue(tokens, index, "-A", "--user-agent");
    const referer = optionValue(tokens, index, "-e", "--referer");
    const cookie = optionValue(tokens, index, "-b", "--cookie");
    const body = optionValue(tokens, index, "-d", "--data")
      ?? optionValue(tokens, index, "", "--data-raw")
      ?? optionValue(tokens, index, "", "--data-binary")
      ?? optionValue(tokens, index, "", "--data-urlencode");
    const explicitUrl = optionValue(tokens, index, "", "--url");
    if (request) {
      if (!request.value) throw new Error("The cURL request method is missing.");
      method = request.value.toUpperCase();
      index += request.consumed;
    } else if (header) {
      const separator = header.value.indexOf(":");
      if (separator < 1) throw new Error(`Invalid cURL header: ${header.value || "empty header"}.`);
      appendHeader(headers, header.value.slice(0, separator).trim(), header.value.slice(separator + 1).trim());
      index += header.consumed;
    } else if (user) {
      userCredentials = user.value;
      index += user.consumed;
    } else if (bearer) {
      oauthBearer = bearer.value;
      index += bearer.consumed;
    } else if (userAgent) {
      appendHeader(headers, "User-Agent", userAgent.value);
      index += userAgent.consumed;
    } else if (referer) {
      appendHeader(headers, "Referer", referer.value);
      index += referer.consumed;
    } else if (cookie) {
      // A cookie jar file cannot be imported in the browser. Inline cookies are
      // still useful, and are later protected as a sensitive header variable.
      if (cookie.value.includes("=")) appendHeader(headers, "Cookie", cookie.value);
      index += cookie.consumed;
    } else if (body) {
      data.push(body.value);
      index += body.consumed;
    } else if (explicitUrl) {
      url = explicitUrl.value;
      index += explicitUrl.consumed;
    } else if (token === "-G" || token === "--get") {
      useGet = true;
    } else if (token === "-I" || token === "--head") {
      useHead = true;
    } else if (ignoredValueOptions.has(token)) {
      index += 1;
    } else if (!token.startsWith("-") && !url) {
      url = token;
    }
  }
  if (!url) throw new Error("The cURL command does not contain a URL.");
  const content = data.join("&");
  if (useGet && content) url += `${url.includes("?") ? "&" : "?"}${content}`;
  const contentType = headers.find((header) => header.name.toLowerCase() === "content-type")?.value.toLowerCase() ?? "";
  let requestBody = createRequestBody();
  if (content && !useGet) {
    if (contentType.includes("json")) requestBody = { ...requestBody, type: "json", json: content };
    else if (!contentType || contentType.includes("x-www-form-urlencoded")) {
      const fields = Array.from(new URLSearchParams(content).entries()).map(([key, value], index) => ({ id: `url-encoded-${index + 1}`, key, value, enabled: true }));
      requestBody = { ...requestBody, type: "url-encoded", urlEncoded: [...fields, createEmptyRequestBodyField("url-encoded", fields)] };
    } else requestBody = { ...requestBody, type: "text", text: content };
  }
  const authorizationIndex = headers.findIndex((header) => header.name.toLowerCase() === "authorization");
  const authorization = authorizationIndex >= 0 ? authorizationAuth(headers[authorizationIndex].value) : null;
  if (authorizationIndex >= 0 && authorization) headers.splice(authorizationIndex, 1);
  const apiHeaderIndex = authorization ? -1 : headers.findIndex((header) => apiKeyName.test(header.name) && Boolean(header.value));
  const apiHeader = apiHeaderIndex >= 0 ? headers[apiHeaderIndex] : undefined;
  if (apiHeader) headers.splice(apiHeaderIndex, 1);
  const urlApiKey = authorization || apiHeader ? { url, apiKey: null } : takeApiKeyFromUrl(url);
  url = urlApiKey.url;
  const auth = authorization
    ?? (oauthBearer ? (() => {
      const next = createRequestAuth();
      next.type = "bearer";
      next.bearer = { prefix: "Bearer", token: oauthBearer };
      return next;
    })() : null)
    ?? basicAuth(userCredentials)
    ?? (apiHeader ? apiKeyAuth(apiHeader.name, apiHeader.value, "header") : null)
    ?? (urlApiKey.apiKey ? apiKeyAuth(urlApiKey.apiKey.name, urlApiKey.apiKey.value, "query") : null)
    ?? createRequestAuth();
  const secrets = headers.filter((header) => header.enabled && header.value && sensitiveHeaderName.test(header.name))
    .map((header) => ({ headerId: header.id, headerName: header.name, value: header.value }));
  return { request: {
    ...base,
    method: method ?? (useHead ? "HEAD" : content && !useGet ? "POST" : "GET"),
    url,
    params: getRequestQueryParamsFromUrl(url, base.params),
    headers,
    body: requestBody,
    auth,
  }, secrets };
}

export function importCurlRequest(command: string, base: RequestDraft): RequestDraft {
  return importCurl(command, base).request;
}
