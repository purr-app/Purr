import { test } from "node:test";
import assert from "node:assert/strict";
import { historyNeedsReplacement, historyWorkingCopy, openHistoricalTab, returnFromHistory } from "../src/features/history/model/history-working-copy";
import { cloneRequestDraft, closeDocument, createHttpDocument, createWorkspace, isDocumentDirty, openDocument, selectSidebarActivity, toggleWorkspaceSidebar, validateWorkspace, type RequestDocument } from "../src/features/workspaces/model/workspace";
import { projectWorkspace } from "../src/application/project-projection";
import { MemorySecureStore } from "../src/storage/secrets";

function fixture(saved = true) {
  const source = createHttpDocument(); source.request.url = "https://example.com/current";
  source.request.auth.type = "bearer"; source.request.auth.bearer.token = "current-token";
  source.saved = saved; source.savedRequest = saved ? cloneRequestDraft(source.request) : null;
  const historical: RequestDocument = { ...createHttpDocument(), name: "Historical", saved: true,
    request: cloneRequestDraft(source.request), savedRequest: cloneRequestDraft(source.request),
    historical: { entryId: "execution", documentId: source.id, startedAt: Date.now(), error: "" } };
  historical.request.url = "https://example.com/past"; historical.request.auth.bearer.token = "old-token";
  historical.savedRequest = cloneRequestDraft(historical.request);
  const workspace = createWorkspace();
  workspace.documents = [source, historical]; workspace.ui.openDocumentIds = [source.id];
  return { source, historical, workspace: openDocument(workspace, historical.id) };
}

test("historical Send replaces its tab with a saved clean document without changing saved definition or immutable execution", () => {
  const { workspace, source, historical } = fixture();
  assert.equal(historyNeedsReplacement(workspace, historical), false);
  const promoted = historyWorkingCopy(workspace, historical, (request) => ({ ...request, method: "POST" }));
  const working = promoted.workspace.documents.find((document) => document.id === source.id) as RequestDocument;
  assert.equal(promoted.documentId, source.id);
  assert.equal(working.request.url, historical.request.url);
  assert.equal(working.request.method, "POST");
  assert.equal(working.request.auth.bearer.token, "current-token");
  assert.equal(working.savedRequest?.url, "https://example.com/current");
  assert.equal(isDocumentDirty(working), true);
  assert.equal(historical.request.method, "GET");
  assert.equal(promoted.workspace.documents.find((document) => document.id === historical.id), undefined);
  assert.equal(promoted.workspace.ui.activeDocumentId, source.id);
  assert.deepEqual(promoted.workspace.ui.openDocumentIds, [source.id]);
});

test("dirty current document requires a choice; create draft preserves its changes", () => {
  const { workspace, source, historical } = fixture();
  source.request.url = "https://example.com/unsaved";
  assert.equal(historyNeedsReplacement(workspace, historical), true);
  const promoted = historyWorkingCopy(workspace, historical, undefined, "draft");
  assert.notEqual(promoted.documentId, source.id);
  assert.equal(promoted.workspace.documents.find((document) => document.id === source.id), source);
  const created = promoted.workspace.documents.find((document) => document.id === promoted.documentId) as RequestDocument;
  assert.equal(created.saved, false); assert.equal(created.historical, undefined);
  const replaced = historyWorkingCopy(workspace, historical);
  assert.equal((replaced.workspace.documents.find((document) => document.id === source.id) as RequestDocument).savedRequest?.url, "https://example.com/current");
});

test("existing drafts can be replaced; deleted sources become new drafts without history credential aliases", () => {
  for (const deleted of [false, true]) {
    const { workspace, source, historical } = fixture(false);
    historical.request.auth.secretRefs = { "bearer.token": "purr/ws/history/execution/editor/token" };
    if (deleted) workspace.documents = workspace.documents.filter((document) => document.id !== source.id);
    const promoted = historyWorkingCopy(workspace, historical);
    assert.equal(historyNeedsReplacement(workspace, historical), !deleted);
    if (deleted) assert.notEqual(promoted.documentId, source.id);
    else assert.equal(promoted.documentId, source.id);
    const created = promoted.workspace.documents.find((document) => document.id === promoted.documentId) as RequestDocument;
    assert.equal(created.saved, false); assert.equal(created.request.auth.secretRefs, undefined);
  }
});

test("historical tabs never enter canonical/local projection; closing removes ephemeral document", async () => {
  const { workspace, historical } = fixture();
  const projected = await projectWorkspace(workspace, new MemorySecureStore());
  assert.ok(!projected.project.resources.some((resource) => resource.id === historical.id));
  assert.ok(!projected.local.some((record) => record.id === historical.id));
  const ui = (projected.local.find((record) => record.id === "state")!.value as {ui:{openDocumentIds:string[];activeDocumentId:string|null}}).ui;
  assert.ok(!ui.openDocumentIds.includes(historical.id)); assert.equal(ui.activeDocumentId, null);
  const closed = closeDocument(workspace, historical.id);
  assert.ok(!closed.documents.some((document) => document.id === historical.id));
});

test("history selection and keyboard toggle preserve activity and sidebar width", () => {
  const workspace = createWorkspace();
  const selected = selectSidebarActivity(workspace, "history");
  assert.equal(selected.ui.sidebarOpen, true);
  const collapsed = selectSidebarActivity(selected, "history");
  assert.equal(collapsed.ui.sidebarOpen, false);
  assert.equal(collapsed.ui.sidebarActivity, "history");
  const restored = validateWorkspace(toggleWorkspaceSidebar(collapsed));
  assert.equal(restored.ui.sidebarActivity, "history"); assert.equal(restored.ui.sidebarOpen, true);
  assert.equal(restored.ui.sidebarWidth, workspace.ui.sidebarWidth);
});


test("Send preserves deliberate editor auth changes and historical tab position", () => {
  const { workspace, source, historical } = fixture();
  const other = createHttpDocument();
  workspace.documents.push(other);
  workspace.ui.openDocumentIds = [source.id, other.id, historical.id];
  historical.request.auth.bearer.token = "edited-token";
  const promoted = historyWorkingCopy(workspace, historical);
  const working = promoted.workspace.documents.find((document) => document.id === source.id) as RequestDocument;
  assert.equal(working.request.auth.bearer.token, "edited-token");
  assert.deepEqual(promoted.workspace.ui.openDocumentIds, [other.id, source.id]);
  assert.equal(historical.savedRequest?.auth.bearer.token, "old-token");
});


test("document history replaces the tab, preserves the current buffer, and restores it without adding tabs", async () => {
  const { workspace, source, historical } = fixture();
  source.request.url = "https://example.com/unsaved";
  workspace.documents = [source]; workspace.ui.openDocumentIds = [source.id]; workspace.ui.activeDocumentId = source.id;
  historical.historical!.inPlace = true;
  const viewed = openHistoricalTab(workspace, historical, source.id);
  assert.deepEqual(viewed.ui.openDocumentIds, [historical.id]);
  assert.equal(viewed.documents.find((document) => document.id === source.id), source);
  assert.equal(historyNeedsReplacement(viewed, historical), true);
  const projection = await projectWorkspace(viewed, new MemorySecureStore());
  const ui = (projection.local.find((record) => record.id === "state")!.value as {ui:{openDocumentIds:string[];activeDocumentId:string|null}}).ui;
  assert.deepEqual(ui.openDocumentIds, [source.id]); assert.equal(ui.activeDocumentId, source.id);
  const restored = returnFromHistory(viewed, historical);
  assert.deepEqual(restored.ui.openDocumentIds, [source.id]);
  assert.equal(restored.documents.find((document) => document.id === source.id), source);
  assert.equal(restored.documents.length, 1);
});
