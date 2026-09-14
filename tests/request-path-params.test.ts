import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyRequestPathParamsToUrl,
  getRequestPathParamsFromUrl,
  normalizeRequestUrlProtocol,
} from "../src/features/request-workbench/model/request";

test("path parameters are discovered from URL path segments and applied for transport", () => {
  const params = getRequestPathParamsFromUrl("api.example.com/users/:userId/posts/:post_id?view=full");
  assert.deepEqual(params.map((param) => param.key), ["userId", "post_id"]);
  const populated = params.map((param) => ({
    ...param,
    value: param.key === "userId" ? "Ada Lovelace" : "42",
  }));
  assert.equal(
    applyRequestPathParamsToUrl("https://api.example.com/users/:userId/posts/:post_id?view=full", populated),
    "https://api.example.com/users/Ada%20Lovelace/posts/42?view=full",
  );
});

test("request URLs default to HTTPS except for local development hosts", () => {
  assert.equal(normalizeRequestUrlProtocol("api.example.com/users"), "https://api.example.com/users");
  assert.equal(normalizeRequestUrlProtocol("localhost:3000/health"), "http://localhost:3000/health");
  assert.equal(normalizeRequestUrlProtocol("127.0.0.1:8787/health"), "http://127.0.0.1:8787/health");
  assert.equal(normalizeRequestUrlProtocol("{{base_url}}/users"), "{{base_url}}/users");
});
