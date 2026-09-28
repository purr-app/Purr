import type { RequestDraft } from "../../request-workbench/model/request";
import { cloneRequestDraft, createGraphqlDocument, createHttpDocument, isDocumentDirty, isRequestDocument, openDocument, type RequestDocument, type Workspace } from "../../workspaces/model/workspace";

export function historySource(workspace: Workspace, historical: RequestDocument) {
  return workspace.documents.find((document): document is RequestDocument =>
    isRequestDocument(document) && !document.historical && document.id === historical.historical?.documentId);
}
export function historyNeedsReplacement(workspace: Workspace, historical: RequestDocument) {
  const source = historySource(workspace, historical);
  return Boolean(source && isDocumentDirty(source));
}

/** Restore the editor, never the resolved URL/credentials from a wire snapshot. */
export function historyWorkingCopy(workspace: Workspace, historical: RequestDocument,
  change?: (request: RequestDraft) => RequestDraft, mode: "replace" | "draft" = "replace", replaceTab = true) {
  const source = historySource(workspace, historical);
  const reuse = mode === "replace" && source;
  const created = historical.kind === "graphql" ? createGraphqlDocument() : createHttpDocument();
  let request = cloneRequestDraft(historical.request);
  // Replay uses today's auth/environment binding. Inherited variables, cookies,
  // workspace defaults and dynamic sources are resolved by the normal executor.
  const authEdited = historical.savedRequest && JSON.stringify(request.auth) !== JSON.stringify(historical.savedRequest.auth);
  if (!authEdited) request.auth = source ? cloneRequestDraft(source.request).auth
    : { ...request.auth, oauth2: { ...request.auth.oauth2, token: null } };
  if (request.environmentId === historical.savedRequest?.environmentId) request.environmentId = source?.request.environmentId;
  if (!reuse || authEdited) request.auth = { ...request.auth, secretRefs: undefined };
  if (change) request = change(request);
  const document: RequestDocument = reuse ? { ...source, request, ui: historical.ui, updatedAt: new Date().toISOString() }
    : { ...created, name: historical.name, request, ui: historical.ui };
  const next = { ...workspace, documents: reuse
    ? workspace.documents.map((item) => item.id === document.id ? document : item)
    : [...workspace.documents, document] };
  if (!replaceTab) return { workspace: openDocument(next, document.id), documentId: document.id };
  // Replace the historical tab in place. A saved source may already be open;
  // remove that duplicate tab while preserving the position the user is editing.
  const openDocumentIds = next.ui.openDocumentIds.filter((id) => id !== document.id)
    .map((id) => id === historical.id ? document.id : id);
  return { workspace: openDocument({ ...next,
    documents: next.documents.filter((item) => item.id !== historical.id),
    ui: { ...next.ui, openDocumentIds, previewDocumentId: null },
  }, document.id), documentId: document.id };
}


/** A response history selection occupies the current tab without touching its working copy. */
export function openHistoricalTab(workspace: Workspace, historical: RequestDocument, replaceId?: string): Workspace {
  const previous = workspace.documents.find((document) => document.id === replaceId);
  const documents = workspace.documents.filter((document) => !(document.id === replaceId && isRequestDocument(document) && document.historical && document.id !== historical.id));
  const next = { ...workspace, documents: documents.some((document) => document.id === historical.id) ? documents : [...documents, historical] };
  if (!previous) return openDocument(next, historical.id);
  return openDocument({ ...next, ui: { ...next.ui,
    openDocumentIds: next.ui.openDocumentIds.filter((id) => id !== historical.id || id === replaceId).map((id) => id === replaceId ? historical.id : id),
    previewDocumentId: null,
  } }, historical.id);
}

export function returnFromHistory(workspace: Workspace, historical: RequestDocument): Workspace {
  const source = historySource(workspace, historical);
  if (!source) return workspace;
  if (!historical.historical?.inPlace) return openDocument(workspace, source.id);
  return openDocument({ ...workspace,
    documents: workspace.documents.filter((document) => document.id !== historical.id),
    ui: { ...workspace.ui,
      openDocumentIds: workspace.ui.openDocumentIds.filter((id) => id !== source.id).map((id) => id === historical.id ? source.id : id),
      previewDocumentId: null,
    },
  }, source.id);
}
