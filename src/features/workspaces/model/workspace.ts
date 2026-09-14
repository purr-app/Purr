import { createRequestAuth, normalizeRequestAuth } from "../../request-workbench/model/request-auth";
import { authTypeOptions } from "../../request-workbench/model/request-auth";
import { createRequestBody } from "../../request-workbench/model/request-body";
import { bodyTypeOptions } from "../../request-workbench/model/request-body";
import { createRequestWorkspaceOverrides, type RequestDraft } from "../../request-workbench/model/request";
import { createWorkspaceRequestConfig, type WorkspaceRequestConfig } from "../../request-workbench/model/request-workspace-config";
export { applyWorkspaceRequestConfig, createWorkspaceRequestConfig, requestScopeApplies, requestScopeOptions } from "../../request-workbench/model/request-workspace-config";
export type { RequestScope, WorkspaceRequestConfig, WorkspaceSharedAuth, WorkspaceSharedHeader } from "../../request-workbench/model/request-workspace-config";
import { graphqlEditorSections, requestEditorSections, type RequestEditorSection } from "../../request-workbench/model/request-editor-section";
import { getHttpMethodStyle } from "../../../shared/model/http-method";
import type { WorkbenchView } from "../../request-workbench/components/request-tab-bar";
import type { HttpResult } from "../../request-workbench/services/http-client";
import type { SessionCookie } from "../../request-workbench/model/cookie-jar";
import type { ProjectResource, RequestDefinition, SchemaDefinition, SecretRef } from "../../../domain/project";

// Stable discriminants allow importers and future document editors to coexist.
export type DocumentKind = "http" | "graphql" | "schema" | "trace" | "benchmark" | "integration";
export type DynamicVariableRefresh = "every-time" | "session" | "cache";
type VariableBase = { id: string; name: string; enabled: boolean; sensitive: boolean };
export type Variable = VariableBase & (
  | { kind: "static"; value: string; secretRef?: SecretRef; loaded?: boolean }
  | { kind: "dynamic-request"; documentId: string; expression: string; language: "jsonpath" | "jq"; refresh: DynamicVariableRefresh;
      cacheTtlSeconds?: number; environment: { type: "current" } | { type: "specific"; environmentId: string } }
  | { kind: "external-secret"; provider: string; key: string }
);
export type EnvironmentVariable = Variable;
export type Environment = { id: string; name: string; description?: string; folderId?: string; variables: Variable[] };
export type DynamicVariableCacheEntry = {
  status: "success" | "error";
  value?: string;
  error?: string;
  resolvedAt: string;
  durationMs: number;
  environmentId: string | null;
  fingerprint: string;
};
type DocumentBase = {
  id: string;
  name: string;
  saved: boolean;
  createdAt: string;
  updatedAt: string;
  description?: string;
  folderId?: string;
  origin?: RequestDefinition["origin"];
};
export type RequestDocumentKind = "http" | "graphql";
export type CreatableDocumentKind = RequestDocumentKind | "schema";
export type RequestDocument = DocumentBase & {
  kind: RequestDocumentKind;
  request: RequestDraft;
  savedRequest: RequestDraft | null;
  lastResponse: HttpResult | null;
  sentAt: string | null;
  ui: { requestSection: RequestEditorSection };
};
export type HttpDocument = RequestDocument & { kind: "http" };
export type GraphqlDocument = RequestDocument & { kind: "graphql"; request: RequestDraft & { graphql: NonNullable<RequestDraft["graphql"]> } };
export type SchemaDocument = DocumentBase & {
  kind: "schema";
  sourceRequestId: string;
  endpoint: string;
  sdl: string;
  source: "introspection" | "file" | null;
  sourceLabel: string;
  loadedAt: string | null;
  schemaSource?: SchemaDefinition["source"];
  pinned?: boolean;
  ui: { selectedType: string | null; selectedField: string | null; sourcePaneOpen: boolean };
};
export type WorkspaceDocument = RequestDocument | SchemaDocument;
export function isRequestDocument(document: WorkspaceDocument): document is RequestDocument { return document.kind !== "schema"; }
export function getDocumentBadge(document: WorkspaceDocument) {
  return document.kind === "schema" ? { label: "SDL", color: "text-action-graphql" }
    : document.kind === "graphql" ? { label: "GQL", color: "text-action-graphql" }
      : { label: document.request.method, color: getHttpMethodStyle(document.request.method).text };
}
export function getDocumentGroup(document: WorkspaceDocument) {
  return !document.saved ? "Drafts" : document.kind === "schema" ? "Schemas" : "Documents";
}
export type Workspace = {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  extraResources?: ProjectResource[];
  documents: WorkspaceDocument[];
  variables: Variable[];
  environments: Environment[];
  cookies: SessionCookie[];
  activeEnvironmentId: string | null;
  requestConfig: WorkspaceRequestConfig;
  dynamicVariableCache: Record<string, DynamicVariableCacheEntry>;
  ui: {
    openDocumentIds: string[];
    activeDocumentId: string | null;
    previewDocumentId: string | null;
    lastRequestKind: RequestDocumentKind;
    cookiesTabOpen: boolean;
    cookiesTabActive: boolean;
    settingsTabOpen: boolean;
    settingsTabActive: boolean;
    variablesTabOpen: boolean;
    variablesTabActive: boolean;
    sidebarOpen: boolean;
    sidebarWidth: number;
    /** Ordered tree items (documents and folders) for the sidebar only. */
    sidebarItemOrder: string[];
    /** @deprecated Kept while older local workspace state is migrated. */
    documentOrder: string[];
    view: WorkbenchView;
    splitRatios: { horizontal: number; vertical: number };
  };
};
export type WorkspaceStore = { activeWorkspaceId: string; workspaces: Workspace[]; globalVariables: Variable[] };

export function createHttpDocument(): HttpDocument {
  return {
    id: crypto.randomUUID(), kind: "http", name: "Untitled Request", saved: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    request: {
      documentation: "",
      method: "GET", url: "",
      params: [{ id: "param-1", key: "", value: "", enabled: false }],
      pathParams: [],
      headers: [{ id: "header-1", name: "", value: "", enabled: false }],
      body: createRequestBody(), auth: createRequestAuth(), useCookieJar: true,
      workspace: createRequestWorkspaceOverrides(),
    },
    savedRequest: null,
    lastResponse: null,
    sentAt: null,
    ui: { requestSection: "query" },
  };
}

export function createGraphqlDocument(): GraphqlDocument {
  const document = createHttpDocument();
  return { ...document, kind: "graphql", name: "Untitled GraphQL", request: { ...document.request, method: "POST", graphql: { query: "", variables: "", operationName: "", schemaId: undefined } }, ui: { requestSection: "gql-query" } };
}

export function createSchemaDocument(request?: RequestDocument): SchemaDocument {
  return { id: crypto.randomUUID(), kind: "schema", name: request ? `${getDocumentDisplayName(request)} schema` : "Untitled GraphQL schema", saved: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sourceRequestId: request?.id ?? "", endpoint: request?.request.url ?? "",
    sdl: "", source: null, sourceLabel: "", loadedAt: null, pinned: true, ui: { selectedType: null, selectedField: null, sourcePaneOpen: true } };
}

export function createWorkspace(name = "Personal", id: string = crypto.randomUUID()): Workspace {
  const document = createHttpDocument();
  return {
    schemaVersion: 1, id, name, description: "", documents: [document], variables: [], environments: [], cookies: [], activeEnvironmentId: null,
    requestConfig: createWorkspaceRequestConfig(), dynamicVariableCache: {},
    ui: {
      openDocumentIds: [document.id], activeDocumentId: document.id, previewDocumentId: null, cookiesTabOpen: false, cookiesTabActive: false,
      settingsTabOpen: false, settingsTabActive: false, sidebarOpen: true,
      sidebarWidth: 15,
      sidebarItemOrder: [],
      documentOrder: [],
      variablesTabOpen: false, variablesTabActive: false,
      view: "canvas", lastRequestKind: "http", splitRatios: { horizontal: 50, vertical: 50 },
    },
  };
}

export function openDocument(workspace: Workspace, id: string): Workspace {
  const document = workspace.documents.find((document) => document.id === id);
  if (!document) return workspace;
  return { ...workspace, ui: { ...workspace.ui,
    openDocumentIds: workspace.ui.openDocumentIds.includes(id) ? workspace.ui.openDocumentIds : [...workspace.ui.openDocumentIds, id],
    activeDocumentId: id, cookiesTabActive: false, settingsTabActive: false, variablesTabActive: false, lastRequestKind: isRequestDocument(document) ? document.kind : workspace.ui.lastRequestKind,
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
  return { ...workspace, ui: { ...workspace.ui, openDocumentIds, activeDocumentId: id, previewDocumentId: id, cookiesTabActive: false, settingsTabActive: false, variablesTabActive: false,
    lastRequestKind: isRequestDocument(document) ? document.kind : workspace.ui.lastRequestKind } };
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

export function getDocumentDisplayName(document: WorkspaceDocument): string {
  if (!isRequestDocument(document)) return document.name;
  const url = document.request.url.trim();
  const defaultName = document.kind === "graphql" ? "Untitled GraphQL" : "Untitled Request";
  if (document.saved || !url || document.name !== defaultName) return document.name;
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

export function duplicateDocument(workspace: Workspace, id: string): Workspace {
  const source = workspace.documents.find((document) => document.id === id);
  if (!source) return workspace;
  if (!isRequestDocument(source)) {
    const created = createSchemaDocument();
    const duplicate: SchemaDocument = { ...created, name: `${getDocumentDisplayName(source)} copy`, description: source.description,
      folderId: source.folderId, sourceRequestId: source.sourceRequestId, endpoint: source.endpoint, sdl: source.sdl, source: source.source,
      sourceLabel: source.sourceLabel, loadedAt: source.loadedAt, schemaSource: source.schemaSource, pinned: source.pinned, ui: { ...source.ui } };
    return openDocument({ ...workspace, documents: [...workspace.documents, duplicate] }, duplicate.id);
  }
  const created: RequestDocument = source.kind === "graphql" ? createGraphqlDocument() : createHttpDocument();
  const request = cloneRequestDraft(source.request);
  request.auth = { ...request.auth, secretRefs: undefined, oauth2: { ...request.auth.oauth2, token: null } };
  const duplicate: RequestDocument = { ...created, kind: source.kind, name: `${getDocumentDisplayName(source)} copy`, description: source.description,
    folderId: source.folderId, request, ui: { ...source.ui } };
  return openDocument({ ...workspace, documents: [...workspace.documents, duplicate] }, duplicate.id);
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

export function isDocumentDirty(document: WorkspaceDocument): boolean {
  if (!isRequestDocument(document)) return false;
  if (!document.saved) return isMeaningfulDraft(document);
  return JSON.stringify(comparableRequest(document.request)) !==
    JSON.stringify(comparableRequest(document.savedRequest ?? document.request));
}

export function isMeaningfulDraft(document: WorkspaceDocument): boolean {
  if (!isRequestDocument(document)) return Boolean(document.sdl || (!document.sourceRequestId && document.endpoint.trim()));
  const { request } = document;
  return Boolean(
    request.graphql?.query.trim() || request.graphql?.variables.trim() || request.graphql?.operationName.trim() || request.url.trim() ||
    request.params.some((param) => param.key || param.value) ||
    request.headers.some((header) => header.name || header.value) ||
    request.body.type !== "none" ||
    (request.auth.type !== "none" && request.auth.type !== "inherit") ||
    request.documentation.trim() ||
    document.sentAt,
  );
}

export function discardDocument(workspace: Workspace, id: string): Workspace {
  const document = workspace.documents.find((item) => item.id === id);
  if (!document) return workspace;
  if (isRequestDocument(document) && document.saved && document.savedRequest) {
    return {
      ...workspace,
      documents: workspace.documents.map((item) => item.id === id && isRequestDocument(item)
        ? { ...item, request: cloneRequestDraft(item.savedRequest!) }
        : item),
    };
  }
  return deleteDocument(workspace, id);
}

export function discardAllDrafts(workspace: Workspace): Workspace {
  return workspace.documents
    .filter((document) => !document.saved && isMeaningfulDraft(document))
    .reduce((current, document) => discardDocument(current, document.id), workspace);
}

export function deleteDocument(workspace: Workspace, id: string): Workspace {
  const document = workspace.documents.find((item) => item.id === id);
  if (!document) return workspace;
  const withoutDocument = closeDocument(workspace, id, true);
  const documents = withoutDocument.documents.filter((item) => item.id !== id).map((item) => {
    if (document.kind === "schema" && isRequestDocument(item) && item.request.graphql?.schemaId === id)
      return { ...item, request: { ...item.request, graphql: { ...item.request.graphql, schemaId: undefined } } };
    if (document.kind !== "schema" && item.kind === "schema" && item.sourceRequestId === id) {
      const replacement = withoutDocument.documents.find((candidate): candidate is GraphqlDocument => candidate.id !== id && candidate.kind === "graphql" && candidate.request.graphql?.schemaId === item.id);
      return { ...item, sourceRequestId: replacement?.id ?? "", endpoint: replacement?.request.url || (isRequestDocument(document) ? document.request.url : item.endpoint) || item.endpoint };
    }
    return item;
  });
  return { ...withoutDocument, documents };
}

// Saved documents reopen from their explicit snapshot. A blank, never-sent tab
// is ephemeral and disappears instead of becoming a Drafts entry.
export function closeDocument(workspace: Workspace, id: string, keepDocument = false): Workspace {
  const document = workspace.documents.find((item) => item.id === id);
  const index = workspace.ui.openDocumentIds.indexOf(id);
  const openDocumentIds = workspace.ui.openDocumentIds.filter((value) => value !== id);
  const remove = !keepDocument && document && !document.saved && !isMeaningfulDraft(document);
  let documents = remove
    ? workspace.documents.filter((item) => item.id !== id)
    : workspace.documents.map((item) => item.id === id && isRequestDocument(item) && item.saved && item.savedRequest
      ? { ...item, request: cloneRequestDraft(item.savedRequest) }
      : item);
  if (remove) documents = documents.map((item) => {
    if (item.kind !== "schema" || item.sourceRequestId !== id) return item;
    const replacement = documents.find((candidate): candidate is GraphqlDocument => candidate.kind === "graphql" && candidate.request.graphql?.schemaId === item.id);
    return { ...item, sourceRequestId: replacement?.id ?? "", endpoint: replacement?.request.url || (isRequestDocument(document) ? document.request.url : item.endpoint) || item.endpoint };
  });
  return { ...workspace, documents, ui: { ...workspace.ui, openDocumentIds,
    previewDocumentId: workspace.ui.previewDocumentId === id ? null : workspace.ui.previewDocumentId,
    activeDocumentId: workspace.ui.activeDocumentId === id
      ? openDocumentIds[Math.min(index, openDocumentIds.length - 1)] ?? null
      : workspace.ui.activeDocumentId,
  } };
}

export function getEnvironmentVariables(workspace: Workspace): Record<string, string> {
  return getEffectiveVariableValues(workspace, [], workspace.activeEnvironmentId);
}

export function getVariableNamespace(workspace: Workspace, globalVariables: readonly Variable[], environmentId = workspace.activeEnvironmentId): Variable[] {
  return [...globalVariables, ...workspace.variables, ...(workspace.environments.find((environment) => environment.id === environmentId)?.variables ?? [])]
    .filter((variable) => variable.name.trim());
}

export function getEffectiveVariables(workspace: Workspace, globalVariables: readonly Variable[], environmentId = workspace.activeEnvironmentId): Variable[] {
  const effective = new Map<string, Variable>();
  for (const variable of getVariableNamespace(workspace, globalVariables, environmentId))
    if (variable.enabled) effective.set(variable.name.trim(), variable);
  return [...effective.values()];
}

export function getEffectiveVariableValues(workspace: Workspace, globalVariables: readonly Variable[], environmentId = workspace.activeEnvironmentId): Record<string, string> {
  return Object.fromEntries(getEffectiveVariables(workspace, globalVariables, environmentId).flatMap((variable) => {
    if (variable.kind === "static") return [[variable.name.trim(), variable.value]];
    return [];
  }));
}

export function validateEnvironment(environment: Environment): string | null {
  if (!environment.name.trim()) return "Enter an environment name.";
  const seen = new Set<string>();
  for (const variable of environment.variables) {
    if (variable.kind !== "static") return "Environment variables must be static.";
    const name = variable.name.trim();
    const hasValue = Boolean(variable.value);
    if (!name && !hasValue) continue;
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
  if (workspace.documents.some((document) => !document || !["http", "graphql", "schema"].includes(document.kind) || !document.ui))
    throw new Error("This workspace contains an unsupported document. Open it with a compatible version of Purr.");
  const requestShape = createHttpDocument().request;
  const normalizeRequest = (request: RequestDraft): RequestDraft => ({
    ...request,
    documentation: typeof request.documentation === "string" ? request.documentation : "",
    pathParams: Array.isArray(request.pathParams)
      ? request.pathParams.filter((param): param is NonNullable<RequestDraft["pathParams"]>[number] => Boolean(param)
        && typeof param.id === "string" && typeof param.key === "string" && typeof param.value === "string" && typeof param.enabled === "boolean")
      : [],
    auth: normalizeRequestAuth(request.auth),
    workspace: request?.workspace && typeof request.workspace === "object"
      ? {
          headersEnabled: request.workspace.headersEnabled !== false,
          authEnabled: request.workspace.authEnabled !== false,
          headerOverrides: request.workspace.headerOverrides && typeof request.workspace.headerOverrides === "object"
            ? Object.fromEntries(Object.entries(request.workspace.headerOverrides).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")) : {},
        }
      : createRequestWorkspaceOverrides(),
  });
  const validRequest = (source: RequestDraft, kind: RequestDocumentKind) => {
    const request = normalizeRequest(source);
    return matchesShape(request, requestShape)
    && /^[A-Z][A-Z0-9_-]*$/.test(request.method) && bodyTypeOptions.some((option) => option.value === request.body.type)
    && authTypeOptions.some((option) => option.value === request.auth.type)
    && (kind === "graphql" ? matchesShape(request.graphql, { query: "", variables: "", operationName: "" }) : request.graphql === undefined);
  };
  const rawConfig = workspace.requestConfig;
  const legacyAuth = rawConfig && !Array.isArray(rawConfig.auth)
    ? rawConfig.auth as unknown as { enabled?: boolean; scope?: string; value?: ReturnType<typeof createRequestAuth> }
    : undefined;
  const requestConfig = rawConfig === undefined
    ? createWorkspaceRequestConfig()
    : {
        ...rawConfig,
        auth: Array.isArray(rawConfig.auth)
          ? rawConfig.auth.map((auth) => ({ ...auth, value: normalizeRequestAuth(auth.value) }))
          : legacyAuth?.value && legacyAuth.value.type !== "none"
            ? [{
                id: "legacy-shared-auth",
                name: "Shared auth",
                enabled: legacyAuth.enabled !== false,
                scope: ["all", "http", "graphql"].includes(legacyAuth.scope ?? "") ? legacyAuth.scope as "all" | "http" | "graphql" : "all",
                value: normalizeRequestAuth(legacyAuth.value),
              }]
            : [],
      };
  const scopes = ["all", "http", "graphql"];
  if (!requestConfig || !Array.isArray(requestConfig.headers) || !Array.isArray(requestConfig.auth)
    || requestConfig.auth.some((auth) => !auth || typeof auth.id !== "string" || typeof auth.name !== "string"
      || typeof auth.enabled !== "boolean" || !scopes.includes(auth.scope)
      || !matchesShape(auth.value, createRequestAuth())
      || !authTypeOptions.some((option) => option.value === auth.value.type) || auth.value.type === "inherit")
    || new Set(requestConfig.auth.map((auth) => auth.id)).size !== requestConfig.auth.length
    || requestConfig.headers.some((header) => !header || typeof header.id !== "string" || typeof header.name !== "string"
      || typeof header.value !== "string" || typeof header.enabled !== "boolean" || !scopes.includes(header.scope))
    || new Set(requestConfig.headers.map((header) => header.id)).size !== requestConfig.headers.length)
    throw new Error("Invalid workspace request configuration. The original file has not been changed.");
  if (workspace.documents.some((document) => typeof document.id !== "string" || typeof document.name !== "string" || (isRequestDocument(document)
    ? !validRequest(document.request, document.kind)
    : typeof document.sdl !== "string" || typeof document.sourceRequestId !== "string" || typeof document.sourceLabel !== "string"
      || ![null, "file", "introspection"].includes(document.source)))
    || !Array.isArray(workspace.variables)
    || workspace.environments.some((environment) => !environment || typeof environment.id !== "string" || typeof environment.name !== "string" || !Array.isArray(environment.variables)
      || environment.variables.some((variable) => !isVariable(variable)))
    || workspace.variables.some((variable) => !isVariable(variable)))
    throw new Error("Invalid document or environment data. The original file has not been changed.");
  const hasInvalidInheritedProfile = (request: RequestDraft, kind: RequestDocumentKind) => request.auth.type === "inherit"
    && request.auth.inherit.profileId
    && !requestConfig.auth.some((profile) => profile.id === request.auth.inherit.profileId
      && (profile.scope === "all" || profile.scope === kind));
  if (workspace.documents.some((document) => isRequestDocument(document)
    && (hasInvalidInheritedProfile(document.request, document.kind)
      || Boolean(document.savedRequest && hasInvalidInheritedProfile(document.savedRequest, document.kind)))))
    throw new Error("A request inherits from a missing or incompatible shared authentication profile.");
  const ids = new Set(workspace.documents.map((document) => document.id));
  if (ids.size !== workspace.documents.length || new Set(workspace.environments.map((environment) => environment.id)).size !== workspace.environments.length)
    throw new Error("Duplicate document or environment identifiers. The original file has not been changed.");
  const environmentNames = workspace.environments.map((environment) => environment.name.trim()).filter(Boolean);
  if (new Set(environmentNames).size !== environmentNames.length)
    throw new Error("Environment names must be unique inside a workspace.");
  const hasDuplicateVariableNames = (variables: readonly Variable[]) => {
    const names = variables.map((variable) => variable.name.trim()).filter(Boolean);
    return new Set(names).size !== names.length;
  };
  if (hasDuplicateVariableNames(workspace.variables) || workspace.environments.some((environment) => hasDuplicateVariableNames(environment.variables)))
    throw new Error("Variable names must be unique inside their scope.");
  if (workspace.environments.some((environment) => environment.variables.some((variable) => variable.kind !== "static")))
    throw new Error("Environment variables must be static.");
  const workspaceNames = new Set(workspace.variables.map((variable) => variable.name.trim()).filter(Boolean));
  if (workspace.environments.some((environment) => environment.variables.some((variable) => workspaceNames.has(variable.name.trim()))))
    throw new Error("Workspace and environment variable names must not overlap.");
  const variableIds = [...workspace.variables, ...workspace.environments.flatMap((environment) => environment.variables)].map((variable) => variable.id);
  if (new Set(variableIds).size !== variableIds.length) throw new Error("Variable identifiers must be unique inside a workspace.");
  const openDocumentIds = [...new Set(workspace.ui.openDocumentIds)].filter((id) => ids.has(id));
  const previewDocumentId = openDocumentIds.includes(workspace.ui.previewDocumentId ?? "")
    && workspace.documents.some((document) => document.id === workspace.ui.previewDocumentId && document.saved && !isDocumentDirty(document))
    ? workspace.ui.previewDocumentId
    : null;
  return { ...workspace,
    description: typeof workspace.description === "string" ? workspace.description : "",
    variables: workspace.variables,
    cookies: Array.isArray(workspace.cookies) ? workspace.cookies : [],
    dynamicVariableCache: workspace.dynamicVariableCache && typeof workspace.dynamicVariableCache === "object" ? workspace.dynamicVariableCache : {},
    requestConfig,
    documents: workspace.documents.map((document) => isRequestDocument(document) ? ({
      ...document,
      request: normalizeRequest(document.request),
      savedRequest: document.saved
        ? cloneRequestDraft(normalizeRequest(document.savedRequest && validRequest(document.savedRequest, document.kind) ? document.savedRequest : document.request))
        : null,
      lastResponse: document.lastResponse ?? null,
      sentAt: typeof document.sentAt === "string" ? document.sentAt : null,
      ui: { ...document.ui,
      requestSection: (document.kind === "graphql" ? graphqlEditorSections : requestEditorSections).some((section) => section.id === document.ui.requestSection)
        ? document.ui.requestSection : document.kind === "graphql" ? "gql-query" : "query",
    } }) : { ...document,
      endpoint: typeof document.endpoint === "string" ? document.endpoint : document.source === "introspection" ? document.sourceLabel : "",
      saved: document.saved || Boolean(document.sdl), ui: {
      selectedType: typeof document.ui.selectedType === "string" ? document.ui.selectedType : null,
      selectedField: typeof document.ui.selectedField === "string" ? document.ui.selectedField : null,
      sourcePaneOpen: document.ui.sourcePaneOpen !== false,
    } }),
    activeEnvironmentId: workspace.environments.some((environment) => environment.id === workspace.activeEnvironmentId) ? workspace.activeEnvironmentId : null,
    ui: { ...workspace.ui, openDocumentIds, previewDocumentId,
      lastRequestKind: workspace.ui.lastRequestKind === "graphql" ? "graphql" : "http",
      activeDocumentId: openDocumentIds.includes(workspace.ui.activeDocumentId ?? "") ? workspace.ui.activeDocumentId : openDocumentIds[0] ?? null,
      cookiesTabOpen: workspace.ui.cookiesTabOpen === true,
      cookiesTabActive: workspace.ui.cookiesTabOpen === true && workspace.ui.cookiesTabActive === true && workspace.ui.settingsTabActive !== true,
      settingsTabOpen: workspace.ui.settingsTabOpen === true,
      settingsTabActive: workspace.ui.settingsTabOpen === true && workspace.ui.settingsTabActive === true,
      variablesTabOpen: workspace.ui.variablesTabOpen === true,
      variablesTabActive: workspace.ui.variablesTabOpen === true && workspace.ui.variablesTabActive === true
        && workspace.ui.cookiesTabActive !== true && workspace.ui.settingsTabActive !== true,
      view: ["canvas", "horizontal", "vertical"].includes(workspace.ui.view) ? workspace.ui.view : "canvas",
      sidebarOpen: workspace.ui.sidebarOpen !== false,
      sidebarWidth: Math.max(12, Math.min(28, typeof workspace.ui.sidebarWidth === "number" ? workspace.ui.sidebarWidth : 15)),
      sidebarItemOrder: Array.isArray(workspace.ui.sidebarItemOrder)
        ? [...new Set(workspace.ui.sidebarItemOrder)].filter((id) => ids.has(id) || (workspace.extraResources ?? []).some((resource) => resource.kind === "folder" && resource.id === id))
        : Array.isArray(workspace.ui.documentOrder) ? [...new Set(workspace.ui.documentOrder)].filter((id) => ids.has(id)) : [],
      documentOrder: Array.isArray(workspace.ui.documentOrder) ? [...new Set(workspace.ui.documentOrder)].filter((id) => ids.has(id)) : [],
      splitRatios: {
        horizontal: Math.max(24, Math.min(76, workspace.ui.splitRatios?.horizontal || 50)),
        vertical: Math.max(24, Math.min(76, workspace.ui.splitRatios?.vertical || 50)),
      },
    },
  };
}

function isVariable(value: unknown): value is Variable {
  if (!value || typeof value !== "object") return false;
  const variable = value as Variable;
  if (typeof variable.id !== "string" || typeof variable.name !== "string" || typeof variable.enabled !== "boolean" || typeof variable.sensitive !== "boolean") return false;
  if (variable.kind === "static") return typeof variable.value === "string";
  if (variable.kind === "external-secret") return variable.sensitive && typeof variable.provider === "string" && typeof variable.key === "string";
  return variable.kind === "dynamic-request" && typeof variable.documentId === "string" && typeof variable.expression === "string"
    && ["jsonpath", "jq"].includes(variable.language) && ["every-time", "session", "cache"].includes(variable.refresh)
    && (variable.cacheTtlSeconds === undefined || typeof variable.cacheTtlSeconds === "number" && variable.cacheTtlSeconds > 0)
    && Boolean(variable.environment)
    && (variable.environment.type === "current" || variable.environment.type === "specific" && typeof variable.environment.environmentId === "string");
}

function matchesShape(value: unknown, shape: unknown): boolean {
  if (shape === null) return value === null || (typeof value === "object" && value !== null);
  if (Array.isArray(shape)) return Array.isArray(value) && (!shape.length || value.every((item) => matchesShape(item, shape[0])));
  if (typeof shape === "object") return value !== null && typeof value === "object" && Object.entries(shape as object)
    .every(([key, child]) => matchesShape((value as Record<string, unknown>)[key], child));
  return typeof value === typeof shape;
}
