import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicExecutionMetadata } from "../src/application/ports/history";
import { DynamicExecutionBadge, dynamicExecutionLabel } from "../src/features/history/dynamic-execution-badge";

const metadata: DynamicExecutionMetadata = {
  groupId: "chain", variableId: "token", variableName: "access_token", environmentId: null,
  extraction: { language: "jsonpath", expression: "$.token", status: "success" },
};

test("dynamic history labels identify the variable and distinguish extraction failures", () => {
  assert.equal(dynamicExecutionLabel(metadata), "Dynamic vars execution · {{access_token}}");
  const failed = { ...metadata, extraction: { ...metadata.extraction!, status: "error" as const, error: "No matching value" } };
  assert.equal(dynamicExecutionLabel(failed), "Dynamic vars execution · {{access_token}} · Extraction failed: No matching value");
  assert.equal(dynamicExecutionLabel({ ...metadata, extraction: undefined }), "Dynamic vars execution · {{access_token}}");
});

test("dynamic execution details are closed by default without replacing the response", () => {
  const failed = { ...metadata, extraction: { ...metadata.extraction!, status: "error" as const, error: "No matching value" } };
  const html = renderToStaticMarkup(createElement(DynamicExecutionBadge, { dynamicExecution: failed }));
  assert.match(html, /Dynamic vars execution details/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-label="Extraction failed"/);
  assert.doesNotMatch(html, /JSONPath extraction/);
  assert.doesNotMatch(html, /The HTTP response is preserved below/);
});
