import assert from "node:assert/strict";
import test from "node:test";

import { importCurlRequest } from "../src/features/request-workbench/model/curl-import";
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

