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
  assert.deepEqual(imported.secrets, []);
  assert.equal(imported.request.headers[0].secret, undefined);
});

test("cURL import leaves ordinary header and query names unchanged without inferring credentials", () => {
  const fromHeader = importCurlRequest("curl https://example.com -H 'X-API-Key: public-key'", initialRequestDraft);
  assert.equal(fromHeader.auth.type, "none");
  assert.deepEqual(fromHeader.headers.map(({ name, value, secret }) => ({ name, value, secret })), [{ name: "X-API-Key", value: "public-key", secret: undefined }]);
  const fromQuery = importCurlRequest("curl 'https://example.com/search?q=purr&api_key=public-key'", initialRequestDraft);
  assert.equal(fromQuery.url, "https://example.com/search?q=purr&api_key=public-key");
  assert.equal(fromQuery.auth.type, "none");
  assert.deepEqual(fromQuery.params.filter((param) => param.enabled).map(({ key, value }) => [key, value]), [["q", "purr"], ["api_key", "public-key"]]);
});

test("cURL protocol credentials remain classified while custom token and password names do not", () => {
  const imported = importCurl("curl https://example.com --oauth2-bearer explicit-token -H 'Cookie: sid=one' -H 'Proxy-Authorization: Basic dXNlcjpwYXNz' -H 'X-Token: ordinary' -H 'X-Password: ordinary'", initialRequestDraft);
  assert.equal(imported.request.auth.type, "bearer");
  assert.equal(imported.request.auth.bearer.token, "explicit-token");
  assert.deepEqual(imported.secrets.map((entry) => entry.headerName), ["Cookie", "Proxy-Authorization"]);
  assert.equal(imported.request.headers.find((header) => header.name === "X-Token")?.secret, undefined);
  assert.equal(imported.request.headers.find((header) => header.name === "X-Password")?.secret, undefined);
});

test("cURL detection accepts shell prompts and curl.exe without intercepting ordinary URLs", () => {
  assert.equal(isCurlCommand("  $ curl https://example.com"), true);
  assert.equal(isCurlCommand("curl.exe https://example.com"), true);
  assert.equal(isCurlCommand("https://example.com/curl"), false);
});
