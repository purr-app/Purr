import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  formatHexResponse,
  formatResponseBody,
  getResponseCookies,
  getResponseFileName,
  getResponseQuerySuggestions,
  inspectResponseBody,
  queryResponseJson,
} from "../src/features/request-workbench/model/response";

type QueryLanguage = "jq" | "jsonpath";
type QueryConformanceFixture = {
  version: number;
  document: unknown;
  queries: Array<{ id: string; language: QueryLanguage; expression: string; expected: unknown }>;
  errors: Array<{ id: string; language: QueryLanguage; expression: string; errorPattern: string }>;
  suggestions: Array<{ language: QueryLanguage; includes: string[]; excludesContaining?: string[] }>;
};
const queryConformance = JSON.parse(
  readFileSync(new URL("./fixtures/response-query-conformance.json", import.meta.url), "utf8"),
) as QueryConformanceFixture;

test("response body detection respects content types and safe content sniffing", () => {
  const json = inspectResponseBody(
    [["Content-Type", "application/problem+json; charset=utf-8"]],
    '{"error":true}',
  );
  assert.equal(json.kind, "json");
  assert.deepEqual(json.parsedJson, { error: true });
  assert.equal(
    inspectResponseBody([], "<root><value>1</value></root>").kind,
    "xml",
  );
  assert.equal(
    inspectResponseBody([["content-type", "text/html"]], "<!doctype html>").kind,
    "html",
  );
  assert.equal(inspectResponseBody([["content-type", "image/png"]], "binary").kind, "image");
  assert.equal(inspectResponseBody([["content-type", "audio/mpeg"]], "binary").kind, "audio");
  assert.equal(inspectResponseBody([["content-type", "video/mp4"]], "binary").kind, "video");
  assert.equal(inspectResponseBody([["content-type", "application/pdf"]], "%PDF-1.7").kind, "binary");
  assert.equal(inspectResponseBody([["content-type", "application/yaml"]], "name: Purr").kind, "yaml");
  assert.equal(inspectResponseBody([["content-type", "text/csv"]], "name,role\nAda,admin").kind, "csv");
  assert.equal(inspectResponseBody([["content-type", "application/x-ndjson"]], '{"name":"Ada"}\n{"name":"Lin"}').kind, "ndjson");
  assert.equal(inspectResponseBody([], "plain text").kind, "text");
  assert.equal(inspectResponseBody([], "\u0000\ufffd").kind, "binary");
});

test("response filenames prefer Content-Disposition and safely fall back to URL and media type", () => {
  assert.equal(getResponseFileName([["content-disposition", "attachment; filename*=UTF-8''quarterly%20report.pdf"]], "https://example.com/export", "application/pdf"), "quarterly report.pdf");
  assert.equal(getResponseFileName([], "https://example.com/assets/avatar", "image/png"), "avatar.png");
  assert.equal(getResponseFileName([["content-disposition", 'attachment; filename="../unsafe?.zip"']], "https://example.com", "application/zip"), "-unsafe-.zip");
});

test("pretty, raw, hex and base64 response representations preserve payload data", () => {
  const text = '{"ok":true}';
  const bodyBase64 = btoa(text);
  const info = inspectResponseBody([], text);
  assert.equal(
    formatResponseBody({ text, bodyBase64 }, info, "pretty"),
    '{\n  "ok": true\n}',
  );
  assert.equal(formatResponseBody({ text, bodyBase64 }, info, "raw"), text);
  assert.equal(
    formatResponseBody({ text, bodyBase64 }, info, "prettify"),
    JSON.stringify(JSON.parse(text), null, 2),
  );
  assert.equal(
    formatResponseBody({ text, bodyBase64 }, info, "base64"),
    bodyBase64,
  );
  assert.match(formatHexResponse(bodyBase64), /^00000000  7b 22 6f 6b/);
});

test("jq and JSONPath selectors extract nested response values", () => {
  assert.equal(queryConformance.version, 1);
  for (const query of queryConformance.queries) {
    assert.deepEqual(
      queryResponseJson(queryConformance.document, query.expression, query.language),
      query.expected,
      query.id,
    );
  }
  for (const query of queryConformance.errors) {
    assert.throws(
      () => queryResponseJson(queryConformance.document, query.expression, query.language),
      new RegExp(query.errorPattern),
      query.id,
    );
  }
  for (const expectation of queryConformance.suggestions) {
    const suggestions = getResponseQuerySuggestions(queryConformance.document, expectation.language);
    for (const value of expectation.includes) assert.ok(suggestions.includes(value), value);
    for (const value of expectation.excludesContaining ?? []) {
      assert.equal(suggestions.some((suggestion) => suggestion.includes(value)), false, value);
    }
  }
});

test("response cookies preserve values and attributes from duplicate Set-Cookie headers", () => {
  assert.deepEqual(
    getResponseCookies([
      ["Set-Cookie", "sid=secret; Path=/; HttpOnly"],
      ["set-cookie", "theme=dark; SameSite=Lax"],
    ]),
    [
      { name: "sid", value: "secret", attributes: ["Path=/", "HttpOnly"] },
      { name: "theme", value: "dark", attributes: ["SameSite=Lax"] },
    ],
  );
});
