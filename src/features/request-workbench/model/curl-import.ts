import type { HttpMethod } from "../../../shared/model/http-method";
import { createEmptyRequestBodyField, createRequestBody } from "./request-body";
import { getRequestQueryParamsFromUrl, type RequestDraft, type RequestHeader } from "./request";

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

const ignoredValueOptions = new Set(["-A", "--user-agent", "-b", "--cookie", "-e", "--referer", "-m", "--max-time", "-u", "--user", "--connect-timeout", "--proxy"]);

export function importCurlRequest(command: string, base: RequestDraft): RequestDraft {
  const tokens = tokenizeShell(command);
  if (tokens[0] === "$") tokens.shift();
  if (tokens.shift()?.toLowerCase() !== "curl") throw new Error("Clipboard content is not a cURL command.");
  let method: HttpMethod | undefined;
  let url = "";
  let useGet = false;
  const headers: RequestHeader[] = [];
  const data: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const request = optionValue(tokens, index, "-X", "--request");
    const header = optionValue(tokens, index, "-H", "--header");
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
      headers.push({ id: `header-${headers.length + 1}`, name: header.value.slice(0, separator).trim(), value: header.value.slice(separator + 1).trim(), enabled: true });
      index += header.consumed;
    } else if (body) {
      data.push(body.value);
      index += body.consumed;
    } else if (explicitUrl) {
      url = explicitUrl.value;
      index += explicitUrl.consumed;
    } else if (token === "-G" || token === "--get") {
      useGet = true;
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
  return {
    ...base,
    method: method ?? (content && !useGet ? "POST" : "GET"),
    url,
    params: getRequestQueryParamsFromUrl(url, base.params),
    headers,
    body: requestBody,
  };
}

