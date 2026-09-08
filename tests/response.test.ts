import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatHexResponse,
  formatResponseBody,
  getResponseCookies,
  getResponseQuerySuggestions,
  inspectResponseBody,
  queryResponseJson,
} from "../src/features/request-workbench/model/response";

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
  assert.equal(inspectResponseBody([], "plain text").kind, "text");
  assert.equal(inspectResponseBody([], "\u0000\ufffd").kind, "binary");
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
    formatResponseBody({ text, bodyBase64 }, info, "base64"),
    bodyBase64,
  );
  assert.match(formatHexResponse(bodyBase64), /^00000000  7b 22 6f 6b/);
});

test("jq and JSONPath selectors extract nested response values", () => {
  const body = {
    users: [
      { name: "Alex", roles: ["admin", "editor"] },
      { name: "Rivera", roles: ["viewer"] },
    ],
    meta: { name: "page" },
  };
  assert.equal(queryResponseJson(body, ".users[0].name", "jq"), "Alex");
  assert.deepEqual(queryResponseJson(body, ".users[].name", "jq"), [
    "Alex",
    "Rivera",
  ]);
  assert.equal(queryResponseJson(body, ".users | length", "jq"), 2);
  assert.equal(queryResponseJson(body, "$.users[1].name", "jsonpath"), "Rivera");
  assert.deepEqual(queryResponseJson(body, "$..name", "jsonpath"), [
    "Alex",
    "Rivera",
    "page",
  ]);
  assert.throws(
    () => queryResponseJson(body, "$.missing", "jsonpath"),
    /did not match/,
  );
  assert.ok(
    getResponseQuerySuggestions(body, "jq").includes(".users[].name"),
  );
  assert.ok(
    getResponseQuerySuggestions(body, "jsonpath").includes(
      "$.users[*].name",
    ),
  );
  assert.equal(
    getResponseQuerySuggestions(body, "jsonpath").some((path) =>
      path.includes("| length"),
    ),
    false,
  );
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
