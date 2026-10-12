import assert from "node:assert/strict";
import { test } from "node:test";
import type { SecureStore } from "../src/application/ports/credentials";
import { prepareWireRequest } from "../src/features/request-workbench/services/execute-request";
import { comparableDefinitionState, createHttpDocument, isDocumentDirty } from "../src/features/workspaces/model/workspace";

function savedDocument() {
  const document = createHttpDocument();
  document.saved = true;
  document.request.url = "https://example.test";
  document.request.auth.type = "basic";
  document.request.auth.basic.username = "alice";
  document.request.auth.credentialStates = { password: { ref: "password", status: "unresolved", edit: { kind: "keep" } } };
  document.request.headers = [{ id: "header", name: "X-Custom", value: "", enabled: true, secret: true, secretState: { ref: "header", status: "unresolved", edit: { kind: "keep" } } }];
  document.savedRequest = structuredClone(document.request);
  return document;
}

test("hydrating authentication and headers asynchronously does not dirty the saved definition", async () => {
  const document = savedDocument();
  const secureStore = { resolve: async (ref: string) => ({ status: "available", value: `${ref}-A`, revision: 1 }) } as SecureStore;
  document.request = (await prepareWireRequest(document.request, { secretStore: secureStore })).editorSnapshot;
  assert.equal(document.request.auth.basic.password, "password-A");
  assert.equal(document.request.headers[0].value, "header-A");
  assert.equal(isDocumentDirty(document), false);
  document.request.auth.credentialStates!.password = { ref: "password", status: "locked", code: "synthetic", edit: { kind: "keep" } };
  document.request.auth.secretRefs = { password: "incidental-cache-reference" };
  document.request.auth.credentialStorage = { bearer: "plain" };
  assert.equal(isDocumentDirty(document), false);
});

test("explicit set, including empty, and delete differ from keeping a source reference", () => {
  for (const edit of [{ kind: "set", value: "password-B" }, { kind: "set", value: "" }, { kind: "delete" }] as const) {
    const document = savedDocument();
    document.request.auth.credentialStates!.password = { ref: "password", status: "available", edit };
    assert.equal(isDocumentDirty(document), true, JSON.stringify(edit));
  }
  const document = savedDocument();
  document.request.headers[0].secretState = { ref: "header", status: "available", edit: { kind: "set", value: "new header" } };
  assert.equal(isDocumentDirty(document), true);
});

test("different keep references and classification changes remain meaningful definition edits", () => {
  const document = savedDocument();
  document.request.auth.credentialStates!.password.ref = "replacement-reference";
  assert.equal(isDocumentDirty(document), true);
  document.request = structuredClone(document.savedRequest!);
  document.request.headers[0].secret = false;
  assert.equal(isDocumentDirty(document), true);
});

test("ordinary buffers still compare by value and reusable comparison ignores resolution metadata", () => {
  const document = savedDocument();
  document.request.auth.basic.username = "changed";
  assert.equal(isDocumentDirty(document), true);
  assert.deepEqual(comparableDefinitionState({ value: "", secretRef: "ref", loaded: false, secretState: { ref: "ref", status: "unresolved" } }),
    comparableDefinitionState({ value: "loaded secret", secretRef: "ref", loaded: true, secretState: { ref: "ref", status: "available", edit: { kind: "keep" } } }));
  assert.notDeepEqual(comparableDefinitionState({ value: "first" }), comparableDefinitionState({ value: "second" }));
});

test("OAuth access and refresh hydration preserve clean state while token replacement is dirty", () => {
  const document = savedDocument();
  document.request.auth.type = "oauth2";
  document.request.auth.oauth2.token = { accessToken: "", refreshToken: "", tokenType: "Bearer", obtainedAt: 1 };
  document.request.auth.credentialStates = { "oauth-access-token": { ref: "access", status: "unresolved" }, "oauth-refresh-token": { ref: "refresh", status: "unresolved" } };
  document.savedRequest = structuredClone(document.request);
  document.request.auth.oauth2.token.accessToken = "loaded access";
  document.request.auth.oauth2.token.refreshToken = "loaded refresh";
  document.request.auth.credentialStates["oauth-access-token"].status = "available";
  document.request.auth.credentialStates["oauth-refresh-token"].status = "available";
  assert.equal(isDocumentDirty(document), false);
  document.request.auth.credentialStates["oauth-access-token"].edit = { kind: "set", value: "rotated access" };
  assert.equal(isDocumentDirty(document), true);
});
