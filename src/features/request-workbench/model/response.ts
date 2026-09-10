import { prettifyBodyCode } from "./request-body";
import type { HttpResult } from "../services/http-client";

export type ResponseBodyKind = "json" | "xml" | "html" | "text" | "binary";
export type ResponseViewMode = "pretty" | "prettify" | "raw" | "hex" | "base64";
export type ResponseQueryLanguage = "jq" | "jsonpath";

export type ResponseBodyInfo = {
  kind: ResponseBodyKind;
  mediaType: string;
  label: string;
  parsedJson?: unknown;
};

export type ResponseCookie = {
  name: string;
  value: string;
  attributes: string[];
};

type QuerySegment =
  | { type: "property"; key: string }
  | { type: "index"; index: number }
  | { type: "wildcard" }
  | { type: "recursive"; key: string };

const responseHeaderValues = (
  headers: [string, string][],
  name: string,
) =>
  headers
    .filter(([headerName]) => headerName.toLowerCase() === name.toLowerCase())
    .map(([, value]) => value);

export function getResponseContentType(headers: [string, string][]) {
  return (
    responseHeaderValues(headers, "content-type")[0]
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase() || ""
  );
}

export function inspectResponseBody(
  headers: [string, string][],
  text: string,
): ResponseBodyInfo {
  const mediaType = getResponseContentType(headers);
  const trimmed = text.trim();
  let parsedJson: unknown;
  let validJson = false;
  if (trimmed) {
    try {
      parsedJson = JSON.parse(trimmed);
      validJson = true;
    } catch {
      /* Content-type and markup detection continue below. */
    }
  }

  if (mediaType.includes("json") || mediaType.endsWith("+json") || validJson)
    return { kind: "json", mediaType: mediaType || "application/json", label: "JSON", parsedJson };
  if (mediaType === "text/html" || /^(?:<!doctype\s+html|<html\b)/i.test(trimmed))
    return { kind: "html", mediaType: mediaType || "text/html", label: "HTML" };
  if (
    mediaType.includes("xml") ||
    mediaType.endsWith("+xml") ||
    /^(?:<\?xml\b|<[A-Za-z_][\w.:-]*(?:\s|>|\/))/i.test(trimmed)
  )
    return { kind: "xml", mediaType: mediaType || "application/xml", label: "XML" };
  if (
    mediaType.startsWith("text/") ||
    mediaType.includes("javascript") ||
    mediaType.includes("graphql") ||
    (!text.includes("\u0000") && !text.includes("\ufffd"))
  )
    return { kind: "text", mediaType: mediaType || "text/plain", label: "Text" };
  return {
    kind: "binary",
    mediaType: mediaType || "application/octet-stream",
    label: "Binary",
  };
}

function decodeBase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export function formatHexResponse(bodyBase64: string) {
  const bytes = decodeBase64(bodyBase64);
  if (!bytes.length) return "";
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = bytes.slice(offset, offset + 16);
    const address = offset.toString(16).padStart(8, "0");
    const hex = Array.from(row, (byte) => byte.toString(16).padStart(2, "0"))
      .join(" ")
      .padEnd(47, " ");
    const ascii = Array.from(row, (byte) =>
      byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".",
    ).join("");
    lines.push(`${address}  ${hex}  |${ascii}|`);
  }
  return lines.join("\n");
}

export function formatResponseBody(
  response: Pick<HttpResult, "text" | "bodyBase64">,
  info: ResponseBodyInfo,
  mode: ResponseViewMode,
  queriedJson?: unknown,
) {
  if (mode === "base64") return response.bodyBase64;
  if (mode === "hex") return formatHexResponse(response.bodyBase64);
  if (queriedJson !== undefined)
    return mode === "pretty"
      ? JSON.stringify(queriedJson, null, 2)
      : JSON.stringify(queriedJson);
  if (mode === "raw") return response.text;
  if ((mode === "pretty" || mode === "prettify") && info.kind === "json" && info.parsedJson !== undefined)
    return JSON.stringify(info.parsedJson, null, 2);
  if ((mode === "pretty" || mode === "prettify") && info.kind === "xml") return prettifyBodyCode("xml", response.text);
  return response.text;
}

function readBracket(expression: string, start: number) {
  let index = start + 1;
  let quote = "";
  while (index < expression.length) {
    const character = expression[index];
    if (quote) {
      if (character === "\\") index++;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "]")
      return { content: expression.slice(start + 1, index).trim(), end: index + 1 };
    index++;
  }
  throw new Error("Close the bracket in the query.");
}

function parseQueryPath(
  expression: string,
  language: ResponseQueryLanguage,
): QuerySegment[] {
  const source = expression.trim();
  if (!source) return [];
  let index = 0;
  if (language === "jsonpath") {
    if (source[index] !== "$") throw new Error("JSONPath must start with $.");
    index++;
  } else if (source[index] !== ".") {
    throw new Error("jq selectors must start with a dot.");
  }
  const segments: QuerySegment[] = [];
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    if (character === ".") {
      if (source[index + 1] === ".") {
        index += 2;
        const start = index;
        while (index < source.length && !/[.\[\]|\s]/.test(source[index])) index++;
        const key = source.slice(start, index);
        if (!key) throw new Error("Add a property after recursive descent.");
        segments.push({ type: "recursive", key });
        continue;
      }
      index++;
      const start = index;
      while (index < source.length && !/[.\[\]|\s]/.test(source[index])) index++;
      const key = source.slice(start, index);
      if (key) segments.push({ type: "property", key });
      continue;
    }
    if (character === "[") {
      const bracket = readBracket(source, index);
      index = bracket.end;
      if (!bracket.content || bracket.content === "*") {
        segments.push({ type: "wildcard" });
        continue;
      }
      if (/^\d+$/.test(bracket.content)) {
        segments.push({ type: "index", index: Number(bracket.content) });
        continue;
      }
      const quoted = bracket.content.match(/^(["'])(.*)\1$/s);
      if (quoted) {
        segments.push({ type: "property", key: quoted[2].replace(/\\([\\"'])/g, "$1") });
        continue;
      }
      throw new Error("Use an array index, wildcard, or quoted property in brackets.");
    }
    throw new Error(`Unexpected ${JSON.stringify(character)} in the query.`);
  }
  return segments;
}

function recursivelyRead(value: unknown, key: string, results: unknown[]) {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key))
    results.push((value as Record<string, unknown>)[key]);
  Object.values(value).forEach((child) => recursivelyRead(child, key, results));
}

function applySegments(root: unknown, segments: QuerySegment[]) {
  let values = [root];
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const value of values) {
      if (segment.type === "property") {
        if (
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.prototype.hasOwnProperty.call(value, segment.key)
        )
          next.push((value as Record<string, unknown>)[segment.key]);
      } else if (segment.type === "index") {
        if (Array.isArray(value) && segment.index < value.length)
          next.push(value[segment.index]);
      } else if (segment.type === "wildcard") {
        if (Array.isArray(value)) next.push(...value);
        else if (value && typeof value === "object") next.push(...Object.values(value));
      } else recursivelyRead(value, segment.key, next);
    }
    values = next;
  }
  if (!values.length) throw new Error("The query did not match any response value.");
  return values.length === 1 ? values[0] : values;
}

export function queryResponseJson(
  root: unknown,
  expression: string,
  language: ResponseQueryLanguage,
) {
  const source = expression.trim();
  if (!source || source === "." || source === "$") return root;
  if (language === "jq") {
    const parts = source.split("|").map((part) => part.trim()).filter(Boolean);
    let value = applySegments(root, parseQueryPath(parts.shift() || ".", language));
    for (const operation of parts) {
      if (operation === "length") {
        if (typeof value === "string" || Array.isArray(value)) value = value.length;
        else if (value && typeof value === "object") value = Object.keys(value).length;
        else throw new Error("length requires a string, array, or object.");
      } else if (operation === "keys") {
        if (Array.isArray(value)) value = value.map((_, index) => index);
        else if (value && typeof value === "object") value = Object.keys(value).sort();
        else throw new Error("keys requires an array or object.");
      } else {
        value = applySegments(value, parseQueryPath(operation, language));
      }
    }
    return value;
  }
  return applySegments(root, parseQueryPath(source, language));
}

export function getResponseQuerySuggestions(
  root: unknown,
  language: ResponseQueryLanguage,
) {
  const suggestions: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    if (suggestions.length >= 200 || seen.has(value)) return;
    seen.add(value);
    suggestions.push(value);
  };
  const propertyPath = (base: string, key: string) => {
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
    if (identifier) return `${base === "." ? "" : base}.${key}` || `.${key}`;
    return `${base}[${JSON.stringify(key)}]`;
  };
  const walk = (value: unknown, path: string, depth: number) => {
    add(path);
    if (depth >= 6 || suggestions.length >= 200 || !value || typeof value !== "object")
      return;
    if (Array.isArray(value)) {
      if (language === "jq") add(`${path} | length`);
      if (!value.length) return;
      const exact = `${path}[0]`;
      const wildcard = `${path}${language === "jq" ? "[]" : "[*]"}`;
      walk(value[0], exact, depth + 1);
      walk(value[0], wildcard, depth + 1);
      return;
    }
    if (language === "jq") {
      add(`${path} | keys`);
      add(`${path} | length`);
    }
    for (const [key, child] of Object.entries(value))
      walk(child, propertyPath(path, key), depth + 1);
  };
  walk(root, language === "jq" ? "." : "$", 0);
  return suggestions;
}

export function getResponseCookies(headers: [string, string][]): ResponseCookie[] {
  return responseHeaderValues(headers, "set-cookie").map((header) => {
    const [pair = "", ...attributes] = header.split(";").map((part) => part.trim());
    const separator = pair.indexOf("=");
    return {
      name: separator < 0 ? pair : pair.slice(0, separator),
      value: separator < 0 ? "" : pair.slice(separator + 1),
      attributes,
    };
  });
}
