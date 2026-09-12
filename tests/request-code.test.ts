import { test } from "node:test";
import assert from "node:assert/strict";

import { base64Bytes } from "../src/features/request-workbench/model/request-auth";
import { formatCurlRequest, formatHttpRequest, formatWgetRequest } from "../src/features/request-workbench/model/request-code";
import { initialRequestDraft } from "../src/features/request-workbench/model/request";
import { prepareWireRequest } from "../src/features/request-workbench/services/execute-request";

const request = {
  method: "POST",
  url: "https://api.example.com/users?active=true",
  headers: [["Content-Type", "application/json"], ["X-Name", "O'Reilly"]] as [string, string][],
  bodyBase64: base64Bytes(new TextEncoder().encode('{"name":"Alex"}')),
};

test("request code formats preserve URL, headers, method and body", () => {
  assert.equal(formatHttpRequest(request), [
    "POST /users?active=true HTTP/1.1",
    "Host: api.example.com",
    "Content-Type: application/json",
    "X-Name: O'Reilly",
    "",
    '{"name":"Alex"}',
  ].join("\n"));
  assert.match(formatCurlRequest(request), /^curl \\\n  --request POST/);
  assert.match(formatCurlRequest(request), /--data-binary '\{"name":"Alex"\}'/);
  assert.match(formatCurlRequest(request), /O'\\''Reilly/);
  assert.match(formatWgetRequest(request), /--method=POST/);
  assert.match(formatWgetRequest(request), /--output-document=-/);
});

test("request display representation masks sensitive variables and credentials", async () => {
  const draft = structuredClone(initialRequestDraft);
  draft.method = "POST";
  draft.url = "https://{{secret_host}}/users?public={{public_id}}";
  draft.body.type = "json";
  draft.body.json = '{"token":"{{secret_token}}","id":"{{public_id}}"}';
  draft.auth.type = "bearer";
  draft.auth.bearer.token = "credential-value";
  const prepared = await prepareWireRequest(draft, { variables: {
    secret_host: "private.example.test", secret_token: "private-token", public_id: "42",
  }, sensitiveVariableNames: ["secret_host", "secret_token"] });
  const actual = formatHttpRequest(prepared.request);
  const display = formatHttpRequest(prepared.displayRequest);
  assert.match(actual, /private\.example\.test/);
  assert.match(actual, /private-token/);
  assert.match(actual, /credential-value/);
  assert.doesNotMatch(display, /private\.example\.test|private-token|credential-value/);
  assert.match(display, /\*{8}/);
  assert.match(display, /"id":"42"/);
});
