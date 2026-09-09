import { createRequestAuth } from "../../request-workbench/model/request-auth";
import { authTypeOptions } from "../../request-workbench/model/request-auth";
import { createRequestBody } from "../../request-workbench/model/request-body";
import { bodyTypeOptions } from "../../request-workbench/model/request-body";
import type { RequestDraft } from "../../request-workbench/model/request";
import { requestEditorSections, type RequestEditorSection } from "../../request-workbench/model/request-editor-section";
import { httpMethods } from "../../../shared/model/http-method";
import type { WorkbenchView } from "../../request-workbench/components/request-tab-bar";
import type { HttpResult } from "../../request-workbench/services/http-client";
import type { SessionCookie } from "../../request-workbench/model/cookie-jar";

// Stable discriminants allow importers and future document editors to coexist.
export type DocumentKind = "http" | "graphql" | "schema" | "trace" | "benchmark" | "integration";
export type EnvironmentVariable = { id: string; name: string; value: string; enabled: boolean; secret: boolean };
export type Environment = { id: string; name: string; variables: EnvironmentVariable[] };
export type HttpDocument = {
  id: string;
  kind: "http";
  name: string;
  saved: boolean;
  createdAt: string;
  updatedAt: string;
  request: RequestDraft;
  savedRequest: RequestDraft | null;
  lastResponse: HttpResult | null;
  sentAt: string | null;
  ui: { requestSection: RequestEditorSection };
};
export type Workspace = {
  schemaVersion: 1;
  id: string;
  name: string;
  documents: HttpDocument[];
  environments: Environment[];
  cookies: SessionCookie[];
  activeEnvironmentId: string | null;
  ui: {
    openDocumentIds: string[];
    activeDocumentId: string | null;
    previewDocumentId: string | null;
    cookiesTabOpen: boolean;
    cookiesTabActive: boolean;
    sidebarOpen: boolean;
    view: WorkbenchView;
    splitRatios: { horizontal: number; vertical: number };
  };
};
export type WorkspaceStore = { activeWorkspaceId: string; workspaces: Workspace[] };

export function createHttpDocument(): HttpDocument {
  return {
    id: crypto.randomUUID(), kind: "http", name: "Untitled Request", saved: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    request: {
      method: "GET", url: "",
      params: [{ id: "param-1", key: "", value: "", enabled: false }],
      headers: [{ id: "header-1", name: "", value: "", enabled: false }],
      body: createRequestBody(), auth: createRequestAuth(), useCookieJar: true,
    },
    savedRequest: null,
    lastResponse: null,
    sentAt: null,
    ui: { requestSection: "query" },
  };
}

export function createWorkspace(name = "Personal", id: string = crypto.randomUUID()): Workspace {
  const document = createHttpDocument();
  return {
    schemaVersion: 1, id, name, documents: [document], environments: [], cookies: [], activeEnvironmentId: null,
    ui: {
      openDocumentIds: [document.id], activeDocumentId: document.id, previewDocumentId: null, cookiesTabOpen: false, cookiesTabActive: false, sidebarOpen: true,
      view: "canvas", splitRatios: { horizontal: 50, vertical: 50 },
    },
  };
}

export function openDocument(workspace: Workspace, id: string): Workspace {
  if (!workspace.documents.some((document) => document.id === id)) return workspace;
  return { ...workspace, ui: { ...workspace.ui,
    openDocumentIds: workspace.ui.openDocumentIds.includes(id) ? workspace.ui.openDocumentIds : [...workspace.ui.openDocumentIds, id],
    activeDocumentId: id, cookiesTabActive: false,
  } };
}

export function previewDocument(workspace: Workspace, id: string): Workspace {
  const document = workspace.documents.find((item) => item.id === id);
  if (!document) return workspace;
  if (workspace.ui.openDocumentIds.includes(id) || !document.saved || isDocumentDirty(document))
    return openDocument(workspace, id);
  const preview = workspace.documents.find((item) => item.id === workspace.ui.previewDocumentId);
  const canReplace = Boolean(preview && preview.saved && !isDocumentDirty(preview)
    && workspace.ui.openDocumentIds.includes(preview.id));
  const openDocumentIds = canReplace
    ? workspace.ui.openDocumentIds.map((value) => value === preview!.id ? id : value)
    : [...workspace.ui.openDocumentIds, id];
  return { ...workspace, ui: { ...workspace.ui, openDocumentIds, activeDocumentId: id, previewDocumentId: id, cookiesTabActive: false } };
}

export function pinDocument(workspace: Workspace, id: string): Workspace {
  if (workspace.ui.previewDocumentId !== id) return workspace;
  return { ...workspace, ui: { ...workspace.ui, previewDocumentId: null } };
}

export function reorderOpenDocuments(workspace: Workspace, sourceId: string, targetId: string): Workspace {
  const source = workspace.ui.openDocumentIds.indexOf(sourceId);
  const target = workspace.ui.openDocumentIds.indexOf(targetId);
  if (source < 0 || target < 0 || source === target) return workspace;
  const openDocumentIds = [...workspace.ui.openDocumentIds];
  openDocumentIds.splice(source, 1);
  openDocumentIds.splice(target, 0, sourceId);
  return { ...workspace, ui: { ...workspace.ui, openDocumentIds,
    previewDocumentId: workspace.ui.previewDocumentId === sourceId ? null : workspace.ui.previewDocumentId,
  } };
}

export function getDocumentDisplayName(document: HttpDocument): string {
  const url = document.request.url.trim();
  if (document.saved || !url) return document.name;
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`.replace(/\/$/, "") || parsed.host;
  } catch {
    return url.replace(/^https?:\/\//i, "").replace(/\/$/, "") || document.name;
  }
}

export function cloneRequestDraft(request: RequestDraft): RequestDraft {
  return structuredClone(request);
}

function comparableRequest(value: unknown): unknown {
  if (typeof File !== "undefined" && value instanceof File)
    return { name: value.name, size: value.size, type: value.type, lastModified: value.lastModified };
  if (Array.isArray(value)) return value.map(comparableRequest);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, comparableRequest(child)]),
  );
  return value;
}

export function isDocumentDirty(document: HttpDocument): boolean {
  if (!document.saved) return isMeaningfulDraft(document);
  return JSON.stringify(comparableRequest(document.request)) !==
    JSON.stringify(comparableRequest(document.savedRequest ?? document.request));
}

export function isMeaningfulDraft(document: HttpDocument): boolean {
  const { request } = document;
  return Boolean(
    request.url.trim() ||
    request.params.some((param) => param.key || param.value) ||
    request.headers.some((header) => header.name || header.value) ||
    request.body.type !== "none" ||
    request.auth.type !== "none" ||
    document.sentAt,
  );
}

export function discardDocument(workspace: Workspace, id: string): Workspace {
  const document = workspace.documents.find((item) => item.id === id);
  if (!document) return workspace;
  if (document.saved && document.savedRequest) {
    return {
      ...workspace,
      documents: workspace.documents.map((item) => item.id === id
        ? { ...item, request: cloneRequestDraft(item.savedRequest!) }
        : item),
    };
  }
  const closed = closeDocument(workspace, id, true);
  return { ...closed, documents: closed.documents.filter((item) => item.id !== id) };
}

// Saved documents reopen from their explicit snapshot. A blank, never-sent tab
// is ephemeral and disappears instead of becoming a Drafts entry.
export function closeDocument(workspace: Workspace, id: string, keepDocument = false): Workspace {
  const document = workspace.documents.find((item) => item.id === id);
  const index = workspace.ui.openDocumentIds.indexOf(id);
  const openDocumentIds = workspace.ui.openDocumentIds.filter((value) => value !== id);
  const remove = !keepDocument && document && !document.saved && !isMeaningfulDraft(document);
  const documents = remove
    ? workspace.documents.filter((item) => item.id !== id)
    : workspace.documents.map((item) => item.id === id && item.saved && item.savedRequest
      ? { ...item, request: cloneRequestDraft(item.savedRequest) }
      : item);
  return { ...workspace, documents, ui: { ...workspace.ui, openDocumentIds,
    previewDocumentId: workspace.ui.previewDocumentId === id ? null : workspace.ui.previewDocumentId,
    activeDocumentId: workspace.ui.activeDocumentId === id
      ? openDocumentIds[Math.min(index, openDocumentIds.length - 1)] ?? null
      : workspace.ui.activeDocumentId,
  } };
}

export function getEnvironmentVariables(workspace: Workspace): Record<string, string> {
  return Object.fromEntries((workspace.environments.find((environment) => environment.id === workspace.activeEnvironmentId)?.variables ?? [])
    .filter((variable) => variable.enabled && variable.name.trim())
    .map((variable) => [variable.name.trim(), variable.value]));
}

export function validateEnvironment(environment: Environment): string | null {
  if (!environment.name.trim()) return "Enter an environment name.";
  const seen = new Set<string>();
  for (const variable of environment.variables) {
    const name = variable.name.trim();
    if (!name && !variable.value) continue;
    if (!name || /[{}]/.test(name)) return "Variable names must not be empty or contain braces.";
    if (seen.has(name)) return `The variable “${name}” is defined more than once.`;
    seen.add(name);
  }
  return null;
}

export function validateWorkspace(value: unknown): Workspace {
  const workspace = value as Workspace;
  if (!workspace || workspace.schemaVersion !== 1 || typeof workspace.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(workspace.id)
    || typeof workspace.name !== "string" || !Array.isArray(workspace.documents)
    || !Array.isArray(workspace.environments) || !workspace.ui || !Array.isArray(workspace.ui.openDocumentIds))
    throw new Error("Unsupported or damaged workspace file. The original file has not been changed.");
  if (workspace.documents.some((document) => !document || document.kind !== "http" || !document.request?.body || !document.request?.auth || !document.ui))
    throw new Error("This workspace contains an unsupported document. Open it with a compatible version of Purr.");
  const requestShape = createHttpDocument().request;
  if (workspace.documents.some((document) => typeof document.id !== "string" || typeof document.name !== "string" || !matchesShape(document.request, requestShape)
    || !httpMethods.includes(document.request.method) || !bodyTypeOptions.some((option) => option.value === document.request.body.type)
    || !authTypeOptions.some((option) => option.value === document.request.auth.type))
    || workspace.environments.some((environment) => !environment || typeof environment.id !== "string" || typeof environment.name !== "string" || !Array.isArray(environment.variables)
      || environment.variables.some((variable) => !variable || typeof variable.id !== "string" || typeof variable.name !== "string" || typeof variable.value !== "string" || typeof variable.enabled !== "boolean" || typeof variable.secret !== "boolean")))
    throw new Error("Invalid document or environment data. The original file has not been changed.");
  const ids = new Set(workspace.documents.map((document) => document.id));
  if (ids.size !== workspace.documents.length || new Set(workspace.environments.map((environment) => environment.id)).size !== workspace.environments.length)
    throw new Error("Duplicate document or environment identifiers. The original file has not been changed.");
  const openDocumentIds = [...new Set(workspace.ui.openDocumentIds)].filter((id) => ids.has(id));
  const previewDocumentId = openDocumentIds.includes(workspace.ui.previewDocumentId ?? "")
    && workspace.documents.some((document) => document.id === workspace.ui.previewDocumentId && document.saved && !isDocumentDirty(document))
    ? workspace.ui.previewDocumentId
    : null;
  return { ...workspace,
    cookies: Array.isArray(workspace.cookies) ? workspace.cookies : [],
    documents: workspace.documents.map((document) => ({
      ...document,
      savedRequest: document.saved
        ? cloneRequestDraft(document.savedRequest && matchesShape(document.savedRequest, requestShape) ? document.savedRequest : document.request)
        : null,
      lastResponse: document.lastResponse ?? null,
      sentAt: typeof document.sentAt === "string" ? document.sentAt : null,
      ui: { ...document.ui,
      requestSection: requestEditorSections.some((section) => section.id === document.ui.requestSection) ? document.ui.requestSection : "query",
    } })),
    activeEnvironmentId: workspace.environments.some((environment) => environment.id === workspace.activeEnvironmentId) ? workspace.activeEnvironmentId : null,
    ui: { ...workspace.ui, openDocumentIds, previewDocumentId,
      activeDocumentId: openDocumentIds.includes(workspace.ui.activeDocumentId ?? "") ? workspace.ui.activeDocumentId : openDocumentIds[0] ?? null,
      cookiesTabOpen: workspace.ui.cookiesTabOpen === true,
      cookiesTabActive: workspace.ui.cookiesTabOpen === true && workspace.ui.cookiesTabActive === true,
      view: ["canvas", "horizontal", "vertical"].includes(workspace.ui.view) ? workspace.ui.view : "canvas",
      sidebarOpen: workspace.ui.sidebarOpen !== false,
      splitRatios: {
        horizontal: Math.max(24, Math.min(76, workspace.ui.splitRatios?.horizontal || 50)),
        vertical: Math.max(24, Math.min(76, workspace.ui.splitRatios?.vertical || 50)),
      },
    },
  };
}

function matchesShape(value: unknown, shape: unknown): boolean {
  if (shape === null) return value === null || (typeof value === "object" && value !== null);
  if (Array.isArray(shape)) return Array.isArray(value) && value.every((item) => matchesShape(item, shape[0]));
  if (typeof shape === "object") return value !== null && typeof value === "object" && Object.entries(shape as object)
    .every(([key, child]) => matchesShape((value as Record<string, unknown>)[key], child));
  return typeof value === typeof shape;
}
