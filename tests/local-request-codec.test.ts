import { test } from "node:test";
import assert from "node:assert/strict";
import { compactLocalRequest, expandLocalRequest } from "../src/application/local-request-codec";
import { projectWorkspace, restoreWorkspace } from "../src/application/project-projection";
import { createHttpDocument, createGraphqlDocument, createWorkspace, cloneRequestDraft, isDocumentDirty, type RequestDocument } from "../src/features/workspaces/model/workspace";
import { MemorySecureStore, protectRuntime, resolveRuntime, SecretPreparationStore } from "../src/storage/secrets";
import { decodeFiles, encodeFiles, type FileAttachmentRecord, type NativeFileAttachmentRecord } from "../src/storage/file-codec";
import type { RequestDraft } from "../src/features/request-workbench/model/request";

test("empty editor uses a versioned compact DTO and fixed defaults restore its full shape", () => {
  const request = createHttpDocument().request;
  request.url = "http://127.0.0.1:18765/echo";
  const compact = compactLocalRequest(request);
  assert.deepEqual(compact, { __purrRequest: 1, method: "GET", url: request.url });
  assert.deepEqual(expandLocalRequest(compact, request.body.boundary), request);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(request).length / 10);
  assert.equal(expandLocalRequest(request), request, "legacy full editors remain readable");
  assert.throws(() => expandLocalRequest({ __purrRequest: 2 }), /Unsupported local request/);
  request.body.boundary = "custom-boundary";
  assert.deepEqual(expandLocalRequest(compactLocalRequest(request)), request);
});

test("inactive modes, false/empty overrides, duplicate and disabled rows remain lossless", () => {
  const request = createGraphqlDocument().request;
  request.body.json = '{"inactive": true}';
  request.body.autoConvert = true;
  request.auth.bearer.prefix = "";
  request.auth.basic.username = "inactive-user";
  request.auth.inherit = { source: "workspace", profileId: "profile" };
  request.auth.oauth2.autoRefresh = false;
  request.useCookieJar = false;
  request.workspace = { headersEnabled: false, authEnabled: false, headerOverrides: { excluded: false, included: true } };
  request.params = [{ id: "one", key: "same", value: "", enabled: false }, { id: "two", key: "same", value: "2", enabled: true }];
  request.headers = [];
  request.body.urlEncoded = [];
  request.settings = { followRedirects: false };
  request.tracePropagation = "off";
  const before = structuredClone(request);
  assert.deepEqual(expandLocalRequest(compactLocalRequest(request)), request);
  assert.deepEqual(request, before, "encoding must not mutate the editor");
});

test("compact secret envelopes resolve with typed missing state and files remain owned by attachments", async () => {
  const request = createHttpDocument().request;
  request.auth.type = "none";
  request.auth.basic.password = "INACTIVE_SECRET";
  request.headers = [{ id: "private", name: "X-Private", value: "HEADER_SECRET", enabled: false, secret: true }];
  const file = new File(["synthetic upload"], "upload.txt", { type: "text/plain" });
  request.body.binary = { file, name: file.name, size: file.size, mimeType: file.type };
  const store = new MemorySecureStore();
  const prepared = new SecretPreparationStore(store);
  const attachments = new Map<string, FileAttachmentRecord | NativeFileAttachmentRecord>();
  const encoded = await encodeFiles(compactLocalRequest(await protectRuntime(request, prepared, "compact", "editor")), attachments);
  assert.doesNotMatch(JSON.stringify(encoded), /INACTIVE_SECRET|HEADER_SECRET|synthetic upload/);
  await store.commit(await prepared.batch());
  const read = async (secure: MemorySecureStore) => await resolveRuntime(expandLocalRequest(decodeFiles(encoded, attachments)), secure) as RequestDraft;
  const restored = await read(store);
  assert.equal(restored.auth.basic.password, "INACTIVE_SECRET");
  assert.equal(restored.headers[0].value, "HEADER_SECRET");
  assert.equal(await restored.body.binary!.file.text(), "synthetic upload");
  const missing = await read(new MemorySecureStore());
  assert.equal(missing.auth.credentialStates?.password.status, "missing");
  assert.equal(missing.headers[0].secretState?.status, "missing");
});

test("draft/session projection removes duplicate dirty editor and YAML baseline while retaining discard and clean state", async () => {
  const workspace = createWorkspace("Compact", "compact-workspace");
  const document = createHttpDocument();
  document.saved = true;
  document.request.url = "https://example.test/saved";
  document.savedRequest = cloneRequestDraft(document.request);
  workspace.documents = [document];
  const store = new MemorySecureStore();
  const clean = await projectWorkspace(workspace, store);
  const cleanSession = clean.local.find((row) => row.table === "document_session_state")!.value as Record<string, unknown>;
  assert.equal(cleanSession.definition, undefined);
  assert.equal(typeof cleanSession.definitionHash, "string");
  assert.deepEqual(cleanSession.editor, { __purrRequest: 1, method: "GET", url: document.request.url });
  await store.commit(clean.secrets);
  const restoredClean = (await restoreWorkspace(clean.project, clean.local, store, {})).documents[0] as RequestDocument;
  assert.equal(isDocumentDirty(restoredClean), false);

  document.request.url = "https://example.test/working";
  const dirty = await projectWorkspace(workspace, store);
  const dirtySession = dirty.local.find((row) => row.table === "document_session_state")!.value as Record<string, unknown>;
  assert.equal(dirtySession.editor, undefined);
  assert.equal(dirtySession.definition, undefined);
  const draft = dirty.local.find((row) => row.table === "drafts")!.value as { request: Record<string, unknown> };
  assert.equal(draft.request.body, undefined);
  await store.commit(dirty.secrets);
  const restoredDirty = (await restoreWorkspace(dirty.project, dirty.local, store, {})).documents[0] as RequestDocument;
  assert.equal(restoredDirty.request.url, "https://example.test/working");
  assert.equal(restoredDirty.savedRequest!.url, "https://example.test/saved");
  assert.equal(isDocumentDirty(restoredDirty), true);
  restoredDirty.request = cloneRequestDraft(restoredDirty.savedRequest!);
  assert.equal(isDocumentDirty(restoredDirty), false);
});
