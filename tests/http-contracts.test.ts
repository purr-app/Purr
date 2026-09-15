import assert from "node:assert/strict";
import { test } from "node:test";

import { projectWorkspace, restoreWorkspace } from "../src/application/project-projection";
import { isInlineHttpResponse, restoreStoredHttpResponse } from "../src/domain/http";
import { formatResponseBody, inspectResponseBody, queryResponseJson } from "../src/features/request-workbench/model/response";
import { cloneRequestDraft, createWorkspace, isRequestDocument } from "../src/features/workspaces/model/workspace";
import { MemorySecureStore } from "../src/storage/secrets";
import { inlineHttpResponseFixture, referencedHttpExchangeFixture } from "./helpers/http-exchange-fixtures";

test("stable HTTP contracts distinguish legacy inline bodies from opaque v2 content references", () => {
  const inline = inlineHttpResponseFixture();
  const referenced = referencedHttpExchangeFixture();

  assert.equal(isInlineHttpResponse(inline), true);
  assert.equal(inline.text, Buffer.from(inline.bodyBase64, "base64").toString("utf8"));
  assert.equal(referenced.protocolVersion, 2);
  assert.equal(referenced.response.byteLength, referenced.content.byteLength);
  assert.equal("text" in referenced, false);
  assert.equal("bodyBase64" in referenced, false);
  assert.equal(restoreStoredHttpResponse({ protocolVersion: 2, content: { id: "" } }), null);
});

test("the v1 fixture retains response formatting, query, and GraphQL envelope semantics", () => {
  const response = inlineHttpResponseFixture();
  const info = inspectResponseBody(response.headers, response.text);
  const parsed = JSON.parse(response.text) as { data: { fixture: string }; errors: unknown[]; extensions: { fixture: string } };

  assert.equal(info.kind, "json");
  assert.equal(formatResponseBody(response, info, "raw"), response.text);
  assert.deepEqual(JSON.parse(formatResponseBody(response, info, "pretty")), parsed);
  assert.equal(queryResponseJson(parsed, ".data.fixture", "jq"), "purr-v1");
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.extensions.fixture, "purr-extension");
});

test("workspace execution history restores and reprojects both v1 inline and v2 reference fixtures without data loss", async () => {
  const workspace = createWorkspace("HTTP compatibility", "http-compatibility");
  const document = workspace.documents[0];
  assert.ok(isRequestDocument(document));
  document.saved = true;
  document.request.url = "https://fixture.invalid/graphql";
  document.savedRequest = cloneRequestDraft(document.request);
  const secure = new MemorySecureStore();
  const projected = await projectWorkspace(workspace, secure);
  const fixtures = [inlineHttpResponseFixture(), referencedHttpExchangeFixture()];
  for (const [index, response] of fixtures.entries()) {
    const local = [
      ...projected.local,
      {
        table: "request_executions" as const,
        id: `${document.id}-fixture-${index}`,
        value: { documentId: document.id, response },
      },
    ];

    const restored = await restoreWorkspace(projected.project, local, secure, projected.assets);
    const restoredDocument = restored.documents[0];
    assert.ok(isRequestDocument(restoredDocument));
    assert.deepEqual(restoredDocument.lastResponse, response);

    const reprojected = await projectWorkspace(restored, secure);
    const savedExecution = reprojected.local.find((record) => record.table === "request_executions");
    assert.deepEqual((savedExecution?.value as { response?: unknown }).response, response);
  }
});
