import { test } from "node:test";
import assert from "node:assert/strict";

import { base64Bytes } from "../src/features/request-workbench/model/request-auth";
import { formatCurlRequest, formatHttpRequest, formatWgetRequest } from "../src/features/request-workbench/model/request-code";

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
