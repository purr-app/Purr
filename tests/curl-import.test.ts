import assert from "node:assert/strict";
import test from "node:test";

import { importCurl, importCurlRequest, isCurlCommand } from "../src/features/request-workbench/model/curl-import";
import { initialRequestDraft } from "../src/features/request-workbench/model/request";

test("cURL import preserves method, URL, headers and structured body", () => {
  const request = importCurlRequest(`curl 'https://api.example.com/users?active=true' -X PATCH -H 'Content-Type: application/json' -H 'X-Trace: one' --data-raw '{"name":"Ada"}'`, initialRequestDraft);
  assert.equal(request.method, "PATCH");
  assert.equal(request.url, "https://api.example.com/users?active=true");
  assert.deepEqual(request.headers.map(({ name, value }) => [name, value]), [["Content-Type", "application/json"], ["X-Trace", "one"]]);
  assert.equal(request.body.type, "json");
  assert.equal(request.body.json, '{"name":"Ada"}');
  assert.deepEqual(request.params.filter((param) => param.enabled).map(({ key, value }) => [key, value]), [["active", "true"]]);
});

test("cURL data defaults to POST form data and -G moves it into the query", () => {
  const post = importCurlRequest("curl https://example.com -d 'first=one' -d 'second=two'", initialRequestDraft);
  assert.equal(post.method, "POST");
  assert.equal(post.body.type, "url-encoded");
  assert.deepEqual(post.body.urlEncoded.filter((field) => field.enabled).map(({ key, value }) => [key, value]), [["first", "one"], ["second", "two"]]);
  const get = importCurlRequest("curl -G https://example.com/search -d 'q=purr'", initialRequestDraft);
  assert.equal(get.method, "GET");
  assert.equal(get.url, "https://example.com/search?q=purr");
  assert.equal(get.body.type, "none");
});

test("cURL import recognizes auth flags and moves credentials out of manual headers", () => {
  const basic = importCurlRequest("curl https://example.com -u 'ada:correct-horse'", initialRequestDraft);
  assert.equal(basic.auth.type, "basic");
  assert.deepEqual(basic.auth.basic, { username: "ada", password: "correct-horse" });

  const imported = importCurl("curl https://example.com -H 'Authorization: Bearer top-secret' -H 'X-Client-Secret: do-not-store-me'", initialRequestDraft);
  assert.equal(imported.request.auth.type, "bearer");
  assert.equal(imported.request.auth.bearer.token, "top-secret");
  assert.deepEqual(imported.request.headers.map(({ name, value }) => [name, value]), [["X-Client-Secret", "do-not-store-me"]]);
  assert.deepEqual(imported.secrets, [{ headerId: "header-2", headerName: "X-Client-Secret", value: "do-not-store-me" }]);
});

test("cURL import keeps API keys in protected auth fields instead of the URL or headers", () => {
  const fromHeader = importCurlRequest("curl https://example.com -H 'X-API-Key: secret-key'", initialRequestDraft);
  assert.equal(fromHeader.auth.type, "api-key");
  assert.deepEqual(fromHeader.auth.apiKey, { name: "X-API-Key", value: "secret-key", placement: "header" });
  assert.deepEqual(fromHeader.headers, []);

  const fromQuery = importCurlRequest("curl 'https://example.com/search?q=purr&api_key=secret-key'", initialRequestDraft);
  assert.equal(fromQuery.url, "https://example.com/search?q=purr");
  assert.equal(fromQuery.auth.type, "api-key");
  assert.deepEqual(fromQuery.auth.apiKey, { name: "api_key", value: "secret-key", placement: "query" });
  assert.deepEqual(fromQuery.params.filter((param) => param.enabled).map(({ key, value }) => [key, value]), [["q", "purr"]]);
});

test("cURL detection accepts shell prompts and curl.exe without intercepting ordinary URLs", () => {
  assert.equal(isCurlCommand("  $ curl https://example.com"), true);
  assert.equal(isCurlCommand("curl.exe https://example.com"), true);
  assert.equal(isCurlCommand("https://example.com/curl"), false);
});
