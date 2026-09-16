import { useEffect, useMemo, useRef, useState, type CSSProperties, type SetStateAction } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { Columns2, Cookie as CookieIcon, Copy, FilePlus2, Globe2, Network, PanelLeft, RotateCcw, Rows2, Save, SendHorizontal, Settings2, Square, TextCursorInput, Trash2, Waypoints } from "lucide-react";
import { SchemaExplorer } from "../graphql/components/schema-explorer";
import { parseGraphqlSchema } from "../graphql/model/graphql";
import { Button } from "../../shared/components/ui/button";
import { keyboardShortcuts } from "../../shared/config/keyboard-shortcuts";
import { RequestWorkbench, emptyRequestSession, type RequestActions, type RequestSession } from "../request-workbench/request-workbench";
import { SessionCookieJar } from "../request-workbench/model/cookie-jar";
import type { AuthRuntime } from "../request-workbench/hooks/use-auth-runtime";
import type { RequestAuth } from "../request-workbench/model/request-auth";
import type { RequestDraft } from "../request-workbench/model/request";
import { applyWorkspaceRequestConfig, getWorkspaceAuth, getWorkspaceAuthProfiles, withWorkspaceAuthDefault } from "../request-workbench/model/request-workspace-config";
import { executeRequest } from "../request-workbench/services/execute-request";
import { CookieJarEditor } from "../request-workbench/components/cookie-jar-editor";
import { importCurl, isCurlCommand, type CurlImport } from "../request-workbench/model/curl-import";
import { CommandPalette, type PaletteAction } from "./components/command-palette";
import { DocumentTabs } from "./components/document-tabs";
import { createDynamicVariable, VariablesExplorer, type VariableScope } from "./components/variables-explorer";
import { DynamicVariableResolutionError, resolveDynamicVariables } from "./services/dynamic-variable-resolver";
import { NameDialog } from "./components/name-dialog";
import { ImportWorkspaceDialog } from "./components/import-workspace-dialog";
import { WorkspaceHeader } from "./components/workspace-header";
import { WorkspaceSidebar } from "./components/workspace-sidebar";
import { WorkspaceSettings } from "./components/workspace-request-settings";
import { EmptyWorkspace } from "./components/empty-workspace";
import { ExtensionDocumentHost } from "./components/extension-document-host";
import { Collapsible } from "../../shared/components/ui/collapsible";
import { cn } from "../../shared/lib/cn";
import { useWorkspaces } from "./hooks/use-workspaces";
import { secretRef } from "../../storage/secrets";
import { resolveEnvironmentSecrets } from "../../application/environment-secrets";
import { importWorkspace as importWorkspaceSource } from "../../application/import-workspace";
import type { ImportSource } from "../../importing/contracts";
import type { ProjectResource } from "../../domain/project";
import { useApplicationServices } from "../../app/application-services-context";
import { useExtensionRegistry } from "../../extension-api/extension-context";
import {
  cloneRequestDraft,
  closeDocument,
  discardAllDrafts,
  createHttpDocument,
  createGraphqlDocument,
  createSchemaDocument,
  createExtensionDocument,
  createWorkspace,
  discardDocument,
  deleteDocument,
  duplicateDocument,
  getEffectiveVariables,
  getEffectiveVariableValues,
  getVariableNamespace,
  getDocumentDisplayName,
  isDocumentDirty,
  isExtensionDocument,
  isMeaningfulDraft,
  isRequestDocument,
  openDocument,
  pinDocument,
  previewDocument,
  reorderOpenDocuments,
  type CreatableDocumentKind,
  type RequestDocument,
  type SchemaDocument,
  type Variable,
  type Workspace,
} from "./model/workspace";

type Dialog = "palette" | "new-workspace" | "import-workspace" | "save-document" | { renameDocument: string } | { newFolder: string | null } | { renameFolder: string } | null;
const actionErrorTimeoutMs = 15_000;

function curlSecretVariableName(headerName: string, used: Set<string>) {
  const stem = headerName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "secret";
  const base = `curl_${stem}`;
  let name = base;
  let suffix = 2;
  while (used.has(name)) name = `${base}_${suffix++}`;
  used.add(name);
  return name;
}

function protectImportedCurlSecrets(imported: CurlImport, workspace: Workspace, globalVariables: readonly Variable[]) {
  if (!imported.secrets.length) return { request: imported.request, variables: [] as Variable[] };
  const usedNames = new Set([
    ...globalVariables,
    ...workspace.variables,
    ...workspace.environments.flatMap((environment) => environment.variables),
  ].map((variable) => variable.name.trim()).filter(Boolean));
  const bindings = new Map<string, string>();
  const variables: Variable[] = imported.secrets.map((secret) => {
    const name = curlSecretVariableName(secret.headerName, usedNames);
    bindings.set(secret.headerId, name);
    return { id: crypto.randomUUID(), name, enabled: true, sensitive: true, kind: "static", value: secret.value };
  });
  return {
    request: {
      ...imported.request,
      headers: imported.request.headers.map((header) => {
        const variable = bindings.get(header.id);
        return variable ? { ...header, value: `{{${variable}}}`, secret: true } : header;
      }),
    },
    variables,
  };
}

function pruneVariableCache(workspace: Workspace, globalVariables: readonly Variable[]) {
  const variables = new Map([...globalVariables, ...workspace.variables, ...workspace.environments.flatMap((environment) => environment.variables)]
    .map((variable) => [variable.id, variable]));
  return Object.fromEntries(Object.entries(workspace.dynamicVariableCache).filter(([key, entry]) => {
    const variable = variables.get(key.split(":", 1)[0]);
    return variable?.kind === "dynamic-request" && entry.fingerprint === JSON.stringify(variable);
  }));
}

export function WorkspaceWorkbench() {
  const services = useApplicationServices();
  const extensions = useExtensionRegistry();
  const { persistence } = services;
  const { store, setStore, updateWorkspace, deleteWorkspace, loadError, saveError, saving, retry, retrySave } = useWorkspaces();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [sessions, setSessions] = useState<Record<string, RequestSession>>({});
  const [actionError, setActionError] = useState("");
  const [variableScope, setVariableScope] = useState<VariableScope>("effective");
  const [variableSelection, setVariableSelection] = useState<string | null>(null);
  const [variableDraft, setVariableDraft] = useState<Variable | null>(null);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const jars = useRef(new Map<string, SessionCookieJar>());
  const dynamicSessionCaches = useRef(new Map<string, Map<string, Workspace["dynamicVariableCache"][string]>>());
  const requestActions = useRef<RequestActions>(null);
  const emptyPasteTarget = useRef<HTMLTextAreaElement>(null);
  const sidebarResize = useRef<{ startX: number; width: number } | null>(null);
  useEffect(() => {
    if (!actionError) return;
    const timeout = window.setTimeout(() => setActionError(""), actionErrorTimeoutMs);
    return () => window.clearTimeout(timeout);
  }, [actionError]);
  const workspace = store?.workspaces.find((item) => item.id === store.activeWorkspaceId);
  const activeDocument = workspace?.documents.find((item) => item.id === workspace.ui.activeDocumentId);
  const currentDocument = activeDocument && isRequestDocument(activeDocument) ? activeDocument : undefined;
  const sourceDocuments = useMemo(() => workspace?.documents
    .filter((document): document is RequestDocument => isRequestDocument(document) && document.saved)
    .map((document) => ({ id: document.id, name: getDocumentDisplayName(document), kind: document.kind, request: document.savedRequest ?? document.request })) ?? [], [workspace?.documents]);
  const schemaSource = activeDocument?.kind === "schema" ? workspace?.documents.find((item): item is RequestDocument => isRequestDocument(item) && item.id === activeDocument.sourceRequestId) : undefined;
  const linkedSchema = workspace?.documents.find((item): item is SchemaDocument => item.kind === "schema" && (item.id === currentDocument?.request.graphql?.schemaId || item.sourceRequestId === currentDocument?.id));
  const schemaSdl = linkedSchema?.sdl;
  const schema = useMemo(() => { try { return schemaSdl ? parseGraphqlSchema(schemaSdl) : undefined; } catch { return undefined; } }, [schemaSdl]);
  const variables = useMemo(() => workspace ? getEffectiveVariableValues(workspace, store?.globalVariables ?? []) : {}, [store?.globalVariables, workspace?.activeEnvironmentId, workspace?.environments, workspace?.variables]);
  const contextKey = useMemo(() => crypto.randomUUID(), [workspace?.id, workspace?.activeEnvironmentId, workspace?.environments]);
  const sessionKey = `${workspace?.id}:${currentDocument?.id}`;
  const restoredSession: RequestSession = currentDocument?.lastResponse
    ? { ...emptyRequestSession, response: currentDocument.lastResponse, canvasFocus: "response" }
    : emptyRequestSession;
  const session = sessions[sessionKey] ?? restoredSession;
  const cookieJar = useMemo(() => {
    if (!workspace) return null;
    const existing = jars.current.get(workspace.id);
    if (existing) return existing;
    const created = new SessionCookieJar(workspace.cookies);
    jars.current.set(workspace.id, created);
    return created;
  }, [workspace?.id]);
  const dynamicVariableSessionCache = useMemo(() => {
    const workspaceId = workspace?.id ?? "";
    const existing = dynamicSessionCaches.current.get(workspaceId);
    if (existing) return existing;
    const created = new Map<string, Workspace["dynamicVariableCache"][string]>();
    dynamicSessionCaches.current.set(workspaceId, created); return created;
  }, [workspace?.id]);
  useEffect(() => {
    if (!workspace || !cookieJar) return;
    const workspaceId = workspace.id;
    return cookieJar.subscribe(() => {
      updateWorkspace(workspaceId, (current) => ({ ...current, cookies: cookieJar.list() }));
    });
  }, [cookieJar, updateWorkspace, workspace?.id]);
  const changeSession = (patch: Partial<RequestSession>) => {
    setSessions((current) => ({ ...current, [sessionKey]: { ...(current[sessionKey] ?? restoredSession), ...patch } }));
    if (!workspace || !currentDocument || (!("response" in patch) && patch.sending !== true)) return;
    const workspaceId = workspace.id;
    const documentId = currentDocument.id;
    updateWorkspace(workspaceId, (current) => ({ ...current, documents: current.documents.map((document) => document.id === documentId && isRequestDocument(document)
      ? {
          ...document,
          lastResponse: "response" in patch ? patch.response ?? null : document.lastResponse,
          sentAt: patch.sending === true ? new Date().toISOString() : document.sentAt,
        }
      : document) }));
  };
  const update = (change: (workspace: Workspace) => Workspace) => { if (workspace) updateWorkspace(workspace.id, change); };
  const updateWorkspaceAuth = (profileId: string, auth: RequestAuth) => update((current) => ({
    ...current,
    requestConfig: { ...current.requestConfig, auth: current.requestConfig.auth.map((profile) =>
      profile.id === profileId ? { ...profile, value: auth } : profile) },
  }));
  const removeUnusedVariableSecrets = (before: readonly Variable[], after: readonly Variable[]) => {
    const retained = new Set(after.flatMap((variable) => variable.kind === "static" && variable.sensitive && variable.secretRef ? [variable.secretRef] : []));
    const removed = before.flatMap((variable) => {
      if (variable.kind === "static" && variable.sensitive && variable.secretRef && !retained.has(variable.secretRef)) return [variable.secretRef];
      if (variable.kind === "dynamic-request" && variable.sensitive && !after.some((candidate) => candidate.id === variable.id
        && candidate.kind === "dynamic-request" && candidate.sensitive && JSON.stringify(candidate) === JSON.stringify(variable)))
        return Object.entries(workspace?.dynamicVariableCache ?? {}).filter(([key]) => key.startsWith(`${variable.id}:`))
          .map(([, entry]) => secretRef(workspace?.id ?? "global", `dynamic-variables/${variable.id}`, `cache/${entry.environmentId ?? "none"}`));
      return [];
    });
    if (removed.length) void Promise.all(removed.map((reference) => persistence.secure.delete(reference))).catch(() => setActionError("Could not remove an obsolete variable secret."));
  };
  const updateDocument = (change: (document: RequestDocument) => RequestDocument) => {
    if (!currentDocument) return;
    update((current) => ({ ...current, documents: current.documents.map((document) => document.id === currentDocument.id && isRequestDocument(document) ? change(document) : document) }));
  };
  const setRequestDraft = (id: string | undefined, change: SetStateAction<RequestDraft>) => update((current) => {
    // An old in-flight request may finish after switching environments. Its
    // response remains attached to its document, but cannot change new credentials.
    if (current.activeEnvironmentId !== workspace?.activeEnvironmentId || current.environments !== workspace?.environments) return current;
    if (!id || (!current.ui.openDocumentIds.includes(id) && id !== schemaSource?.id)) return current;
    let pinPreview = false;
    const documents = current.documents.map((document) => {
      if (document.id !== id || !isRequestDocument(document)) return document;
      const request = typeof change === "function" ? change(document.request) : change;
      if (current.ui.previewDocumentId === document.id && isDocumentDirty({ ...document, request })) pinPreview = true;
      return { ...document, updatedAt: new Date().toISOString(), request };
    });
    return { ...current, documents, ui: pinPreview ? { ...current.ui, previewDocumentId: null } : current.ui };
  });
  const setDraft = (change: SetStateAction<RequestDraft>) => setRequestDraft(currentDocument?.id, change);
  const addDocument = (kind: CreatableDocumentKind = workspace?.ui.lastRequestKind ?? "http", folderId?: string) => {
    if (kind === "schema") {
      const document = createSchemaDocument();
      update((current) => openDocument({ ...current, documents: [...current.documents, document] }, document.id));
      return;
    }
    let document: RequestDocument = { ...(kind === "graphql" ? createGraphqlDocument() : createHttpDocument()), ...(folderId ? { folderId } : {}) };
    if (workspace)
      document = { ...document, request: withWorkspaceAuthDefault(document.request, kind, workspace.requestConfig) };
    update((current) => openDocument({ ...current, documents: [...current.documents, document] }, document.id));
  };
  const addExtensionDocument = (extensionType: string, folderId?: string) => {
    const registration = extensions.documentType(extensionType);
    if (!registration) { setActionError(`Extension document type is unavailable: ${extensionType}`); return; }
    try {
      const initial = registration.controller.createNew();
      const validated = registration.validateAndMigrate(initial.configVersion, initial.config);
      const document = createExtensionDocument(extensionType, initial.name, validated.configVersion, validated.config, folderId);
      update((current) => openDocument({ ...current, documents: [...current.documents, document] }, document.id));
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const createFolder = (parentId?: string) => setDialog({ newFolder: parentId ?? null });
  const moveDocument = (id: string, folderId: string | null) => update((current) => ({ ...current, documents: current.documents.map((document) => document.id === id
    ? { ...document, ...(folderId ? { folderId } : { folderId: undefined }) }
    : document) }));
  const moveDocuments = (ids: string[], folderId: string | null) => {
    const moving = new Set(ids);
    update((current) => ({ ...current, documents: current.documents.map((document) => moving.has(document.id)
      ? { ...document, ...(folderId ? { folderId } : { folderId: undefined }) }
      : document) }));
  };
  const reorderSidebarItem = (sourceId: string, targetId: string, position: "before" | "after") => update((current) => {
    const folders = (current.extraResources ?? []).filter((resource): resource is Extract<ProjectResource, { kind: "folder" }> => resource.kind === "folder");
    const sourceDocument = current.documents.find((document) => document.id === sourceId && document.kind !== "schema");
    const sourceFolder = folders.find((folder) => folder.id === sourceId);
    const target = current.documents.find((document) => document.id === targetId && document.kind !== "schema");
    if ((!sourceDocument && !sourceFolder) || !target || sourceId === targetId) return current;
    const targetFolderId = target.folderId ?? null;
    if (sourceFolder) {
      let parentId = targetFolderId;
      while (parentId) {
        if (parentId === sourceFolder.id) return current;
        parentId = folders.find((folder) => folder.id === parentId)?.folderId ?? null;
      }
    }
    const documents = current.documents.map((document) => document.id === sourceId
      ? { ...document, ...(targetFolderId ? { folderId: targetFolderId } : { folderId: undefined }) }
      : document);
    const extraResources = (current.extraResources ?? []).map((resource) => resource.id === sourceId && resource.kind === "folder"
      ? { ...resource, ...(targetFolderId ? { folderId: targetFolderId } : { folderId: undefined }) }
      : resource);
    const validIds = [...documents.filter((document) => document.kind !== "schema").map((document) => document.id), ...extraResources.filter((resource) => resource.kind === "folder").map((resource) => resource.id)];
    const order = [...new Set([...(current.ui.sidebarItemOrder ?? current.ui.documentOrder ?? []), ...validIds])].filter((id) => id !== sourceId && validIds.includes(id));
    const targetIndex = order.indexOf(targetId);
    order.splice(targetIndex + (position === "after" ? 1 : 0), 0, sourceId);
    return { ...current, documents, extraResources, ui: { ...current.ui,
      sidebarItemOrder: order,
      documentOrder: order.filter((id) => documents.some((document) => document.id === id)),
    } };
  });
  const moveFolder = (id: string, folderId: string | null) => update((current) => {
    const folders = (current.extraResources ?? []).filter((resource): resource is Extract<ProjectResource, { kind: "folder" }> => resource.kind === "folder");
    let parentId = folderId;
    while (parentId) { if (parentId === id) return current; parentId = folders.find((folder) => folder.id === parentId)?.folderId ?? null; }
    return { ...current, extraResources: (current.extraResources ?? []).map((resource) => resource.id === id && resource.kind === "folder"
      ? { ...resource, ...(folderId ? { folderId } : { folderId: undefined }) }
      : resource) };
  });
  const deleteFolder = (id: string) => update((current) => {
    const folder = (current.extraResources ?? []).find((resource): resource is Extract<ProjectResource, { kind: "folder" }> => resource.id === id && resource.kind === "folder");
    if (!folder) return current;
    const parentId = folder.folderId;
    const reparent = <T extends { folderId?: string }>(item: T): T => item.folderId === id ? { ...item, ...(parentId ? { folderId: parentId } : { folderId: undefined }) } : item;
    return {
      ...current,
      documents: current.documents.map(reparent),
      environments: current.environments.map(reparent),
      extraResources: (current.extraResources ?? []).filter((resource) => resource.id !== id).map(reparent),
    };
  });
  const importCurlAsDocument = (command: string) => {
    try {
      const document = createHttpDocument();
      const imported = importCurl(command, document.request);
      update((current) => {
        const secured = protectImportedCurlSecrets(imported, current, store?.globalVariables ?? []);
        const request = withWorkspaceAuthDefault(secured.request, "http", current.requestConfig);
        return openDocument({ ...current, variables: [...current.variables, ...secured.variables], documents: [...current.documents, { ...document, request }] }, document.id);
      });
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not import the cURL command.");
    }
  };
  const importCurlIntoActiveDocument = (command: string) => {
    if (!currentDocument || currentDocument.kind !== "http") {
      importCurlAsDocument(command);
      return;
    }
    try {
      const imported = importCurl(command, currentDocument.request);
      const documentId = currentDocument.id;
      update((current) => {
        const secured = protectImportedCurlSecrets(imported, current, store?.globalVariables ?? []);
        let previewChanged = false;
        const documents = current.documents.map((document) => {
          if (document.id !== documentId || !isRequestDocument(document)) return document;
          const request = withWorkspaceAuthDefault(secured.request, "http", current.requestConfig);
          const next = { ...document, request, updatedAt: new Date().toISOString() };
          if (current.ui.previewDocumentId === document.id && isDocumentDirty(next)) previewChanged = true;
          return next;
        });
        return {
          ...current,
          variables: [...current.variables, ...secured.variables],
          documents,
          ui: previewChanged ? { ...current.ui, previewDocumentId: null } : current.ui,
        };
      });
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not import the cURL command.");
    }
  };
  const pasteCurl = async () => {
    try {
      importCurlAsDocument(await navigator.clipboard.readText());
    } catch {
      // WebKit-based desktop WebViews may deny Clipboard.readText() outside an
      // editable element. Focus the capture target so the next native paste
      // event carries clipboardData instead of showing a system Paste prompt.
      emptyPasteTarget.current?.focus();
    }
  };
  const duplicateById = (id: string) => update((current) => duplicateDocument(current, id));
  const openSchema = (selectedType?: string) => {
    if (currentDocument?.kind !== "graphql") return;
    update((current) => {
      const existing = current.documents.find((item): item is SchemaDocument => item.kind === "schema" && (
        item.id === currentDocument.request.graphql?.schemaId || item.sourceRequestId === currentDocument.id ||
        Boolean(currentDocument.request.url && (current.documents.find((candidate): candidate is RequestDocument => isRequestDocument(candidate) && candidate.id === item.sourceRequestId)?.request.url === currentDocument.request.url
          || item.source === "introspection" && item.sourceLabel === currentDocument.request.url))
      ));
      const sourceStillExists = existing && current.documents.some((item) => isRequestDocument(item) && item.id === existing.sourceRequestId);
      const document = existing ? { ...existing, sourceRequestId: sourceStillExists ? existing.sourceRequestId : currentDocument.id } : createSchemaDocument(currentDocument);
      const selected = selectedType ? { ...document, ui: { ...document.ui, selectedType, selectedField: null } } : document;
      const documents = (existing ? current.documents.map((item) => item.id === selected.id ? selected : item) : [...current.documents, selected]).map((item) =>
        item.id === currentDocument.id && isRequestDocument(item) && item.request.graphql
          ? { ...item, request: { ...item.request, graphql: { ...item.request.graphql, schemaId: selected.id } } } : item);
      return openDocument({ ...current, documents }, selected.id);
    });
  };
  const closeById = (id: string) => update((current) => closeDocument(current, id));
  const closeOtherTabs = (id: string) => update((current) => {
    const closed = current.ui.openDocumentIds.filter((openId) => openId !== id).reduce((next, openId) => closeDocument(next, openId), current);
    const opened = openDocument(closed, id);
    return { ...opened, ui: { ...opened.ui, cookiesTabOpen: false, cookiesTabActive: false, settingsTabOpen: false, settingsTabActive: false,
      variablesTabOpen: false, variablesTabActive: false } };
  });
  const closeAllTabs = () => update((current) => {
    const closed = current.ui.openDocumentIds.reduce((next, id) => closeDocument(next, id), current);
    return { ...closed, ui: { ...closed.ui, cookiesTabOpen: false, cookiesTabActive: false, settingsTabOpen: false, settingsTabActive: false,
      variablesTabOpen: false, variablesTabActive: false } };
  });
  const discardById = (id: string) => {
    update((current) => discardDocument(current, id));
    if (workspace) setSessions((current) => {
      const next = { ...current };
      delete next[`${workspace.id}:${id}`];
      return next;
    });
  };
  const discardAll = () => {
    if (!workspace) return;
    const ids = new Set(workspace.documents.filter((document) => !document.saved && isMeaningfulDraft(document)).map((document) => document.id));
    update(discardAllDrafts);
    const prefix = `${workspace.id}:`;
    setSessions((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(prefix) || !ids.has(key.slice(prefix.length)))));
  };
  const deleteById = (id: string) => {
    const release = (variable: Variable): Variable => variable.kind === "dynamic-request" && variable.documentId === id
      ? { ...variable, documentId: "" } : variable;
    setStore((current) => current ? { ...current,
      globalVariables: current.globalVariables.map(release),
      workspaces: current.workspaces.map((candidate) => {
        if (candidate.id !== workspace?.id) return candidate;
        const deleted = deleteDocument(candidate, id);
        const next = { ...deleted, variables: deleted.variables.map(release), environments: deleted.environments.map((environment) => ({ ...environment, variables: environment.variables.map(release) })) };
        return { ...next, dynamicVariableCache: pruneVariableCache(next, current.globalVariables) };
      }),
    } : current);
    if (workspace) setSessions((current) => { const next = { ...current }; delete next[`${workspace.id}:${id}`]; return next; });
  };
  const createRequestFromSchema = (operation: { name: string; query: string; variables: string }) => {
    if (!workspace || activeDocument?.kind !== "schema") return;
    const created = createGraphqlDocument();
    const base = schemaSource?.request ?? { ...created.request, url: activeDocument.endpoint || (activeDocument.source === "introspection" ? activeDocument.sourceLabel : "") };
    const request = withWorkspaceAuthDefault({ ...cloneRequestDraft(base), method: "POST", graphql: {
      query: operation.query, variables: operation.variables, operationName: operation.name, schemaId: activeDocument.id,
    } }, "graphql", workspace.requestConfig);
    const document: RequestDocument = { ...created, name: operation.name, request, ui: { requestSection: "gql-query" } };
    update((current) => openDocument({ ...current, documents: [...current.documents, document] }, document.id));
  };
  const selectView = (view: Workspace["ui"]["view"]) => {
    update((current) => ({ ...current, ui: { ...current.ui, view } }));
    if (view === "canvas") changeSession({ canvasFocus: session.response || session.error || session.sending ? "response" : "request" });
  };
  const toggleSidebar = () => update((current) => ({ ...current, ui: { ...current.ui, sidebarOpen: !current.ui.sidebarOpen } }));
  const openCookies = () => update((current) => ({ ...current, ui: { ...current.ui, cookiesTabOpen: true, cookiesTabActive: true, settingsTabActive: false, variablesTabActive: false } }));
  const closeCookies = () => update((current) => ({ ...current, ui: { ...current.ui, cookiesTabOpen: false, cookiesTabActive: false } }));
  const openSettings = () => update((current) => ({ ...current, ui: { ...current.ui, settingsTabOpen: true, settingsTabActive: true, cookiesTabActive: false, variablesTabActive: false } }));
  const closeSettings = () => update((current) => ({ ...current, ui: { ...current.ui, settingsTabOpen: false, settingsTabActive: false } }));
  const openVariables = (scope: VariableScope = variableScope, selectedId?: string | null, draft?: Variable | null) => {
    setVariableScope(scope);
    if (selectedId !== undefined) setVariableSelection(selectedId);
    if (draft !== undefined) setVariableDraft(draft);
    update((current) => ({ ...current, ui: { ...current.ui, variablesTabOpen: true, variablesTabActive: true, cookiesTabActive: false, settingsTabActive: false } }));
  };
  const closeVariables = () => { setVariableSelection(null); setVariableDraft(null); update((current) => ({ ...current, ui: { ...current.ui, variablesTabOpen: false, variablesTabActive: false } })); };
  const showEnvironment = async (create = false) => {
    const existing = workspace?.environments.find((item) => item.id === workspace.activeEnvironmentId);
    try {
      if (create) {
        let name = "New environment"; let suffix = 2;
        while (workspace?.environments.some((environment) => environment.name === name)) name = `New environment ${suffix++}`;
        const environment = { id: crypto.randomUUID(), name, variables: [] };
        update((current) => ({ ...current, activeEnvironmentId: environment.id, environments: [...current.environments, environment] }));
        openVariables(`environment:${environment.id}`, null, null);
      } else if (existing) {
        const environment = await resolveEnvironmentSecrets(existing, persistence.secure);
        update((current) => ({ ...current, environments: current.environments.map((item) => item.id === environment.id ? environment : item) }));
        openVariables(`environment:${environment.id}`, null, null);
      } else openVariables("effective", null, null);
    }
    catch { setActionError("Could not unlock environment secrets."); }
  };
  const saveCurrentDocument = () => {
    if (activeDocument && isExtensionDocument(activeDocument)) {
      update((current) => ({ ...current, documents: current.documents.map((document) => document.id === activeDocument.id && isExtensionDocument(document)
        ? { ...document, saved: true, savedConfigVersion: document.configVersion, savedConfig: structuredClone(document.config), updatedAt: new Date().toISOString() }
        : document) }));
      return;
    }
    if (!currentDocument) return;
    if (!currentDocument.saved) { setDialog("save-document"); return; }
    if (!isDocumentDirty(currentDocument)) return;
    updateDocument((document) => ({ ...document, savedRequest: cloneRequestDraft(document.request), updatedAt: new Date().toISOString() }));
  };
  const actions: PaletteAction[] = [
    ...(activeDocument && isExtensionDocument(activeDocument) && (!activeDocument.saved || isDocumentDirty(activeDocument)) ? [
      { id: "save-extension", title: "Save extension document", icon: <Save className="size-ui-4" />, shortcut: keyboardShortcuts.saveDocument, run: saveCurrentDocument },
    ] : []),
    ...(currentDocument && !workspace?.ui.cookiesTabActive && !workspace?.ui.settingsTabActive && !workspace?.ui.variablesTabActive ? [
      { id: "send", title: "Run request", icon: <SendHorizontal className="size-ui-4" />, shortcut: keyboardShortcuts.sendRequest, run: () => requestActions.current?.send() },
      ...(!currentDocument.saved || isDocumentDirty(currentDocument) ? [{ id: "save", title: currentDocument.saved ? "Save document changes" : "Save document", icon: <Save className="size-ui-4" />, shortcut: keyboardShortcuts.saveDocument, run: saveCurrentDocument }] : []),
      ...(isDocumentDirty(currentDocument) ? [{
        id: "discard",
        title: currentDocument.saved ? "Revert unsaved changes" : "Discard draft",
        icon: currentDocument.saved ? <RotateCcw className="size-ui-4" /> : <Trash2 className="size-ui-4" />,
        run: () => discardById(currentDocument.id),
      }] : []),
      { id: "duplicate", title: `Duplicate ${currentDocument.kind === "graphql" ? "GraphQL" : "HTTP"} request`, icon: <Copy className="size-ui-4" />, shortcut: keyboardShortcuts.duplicateDocument, run: () => duplicateById(currentDocument.id) },
      ...(currentDocument.kind === "graphql" ? [{ id: "schema", title: "Open GraphQL schema", icon: <Network className="size-ui-4 text-action-graphql" />, run: openSchema }] : []),
      { id: "focus-url", title: "Focus request URL", icon: <TextCursorInput className="size-ui-4" />, shortcut: keyboardShortcuts.focusUrl, run: () => requestActions.current?.focusUrl() },
    ] : []),
    { id: "new", title: `New ${workspace?.ui.lastRequestKind === "graphql" ? "GraphQL" : "HTTP"} request`, icon: <FilePlus2 className="size-ui-4" />, shortcut: keyboardShortcuts.newDocument, run: () => addDocument() },
    { id: "new-other", title: `New ${workspace?.ui.lastRequestKind === "graphql" ? "HTTP" : "GraphQL"} request`, icon: <FilePlus2 className="size-ui-4" />, run: () => addDocument(workspace?.ui.lastRequestKind === "graphql" ? "http" : "graphql") },
    { id: "new-schema", title: "New GraphQL schema", icon: <Waypoints className="size-ui-4 text-action-graphql" />, run: () => addDocument("schema") },
    { id: "cookies", title: "Open workspace cookies", icon: <CookieIcon className="size-ui-4" />, run: openCookies },
    { id: "workspace-settings", title: "Open workspace settings", icon: <Settings2 className="size-ui-4" />, run: openSettings },
    { id: "variables", title: "Open variables", icon: <Globe2 className="size-ui-4" />, shortcut: keyboardShortcuts.editEnvironment, run: () => openVariables("effective", null, null) },
    { id: "sidebar", title: "Toggle sidebar", icon: <PanelLeft className="size-ui-4" />, shortcut: keyboardShortcuts.toggleSidebar, run: toggleSidebar },
    { id: "canvas", title: "Canvas view", icon: <Square className="size-ui-4" />, shortcut: keyboardShortcuts.canvasView, run: () => selectView("canvas") },
    { id: "horizontal", title: "Horizontal split view", icon: <Rows2 className="size-ui-4" />, shortcut: keyboardShortcuts.horizontalSplitView, run: () => selectView("horizontal") },
    { id: "vertical", title: "Vertical split view", icon: <Columns2 className="size-ui-4" />, shortcut: keyboardShortcuts.verticalSplitView, run: () => selectView("vertical") },
  ];
  const shortcutOptions = { enableOnFormTags: true, enableOnContentEditable: true, preventDefault: true, enabled: Boolean(workspace) && !dialog };
  useHotkeys(actions.map((action) => action.shortcut?.hotkey).filter(Boolean).join(","), (_, handler) => {
    actions.find((action) => action.shortcut?.hotkey === handler.hotkey)?.run();
  }, shortcutOptions, [actions]);
  useHotkeys(keyboardShortcuts.pasteCurl.hotkey, () => emptyPasteTarget.current?.focus(), {
    preventDefault: false,
    enableOnFormTags: false,
    enableOnContentEditable: false,
    enabled: workspace?.ui.openDocumentIds.length === 0 && !dialog,
  }, [dialog, workspace]);
  useHotkeys(`${keyboardShortcuts.commandPalette.hotkey},${keyboardShortcuts.openRecentRequest.hotkey}`, () => setDialog((current) => current === "palette" ? null : "palette"), { ...shortcutOptions, enabled: Boolean(workspace) && (!dialog || dialog === "palette") });
  useHotkeys(keyboardShortcuts.closeDocument.hotkey, () => {
    if (workspace?.ui.settingsTabActive) closeSettings();
    else if (workspace?.ui.variablesTabActive) closeVariables();
    else if (workspace?.ui.cookiesTabActive) closeCookies();
    else if (activeDocument) closeById(activeDocument.id);
  }, shortcutOptions, [activeDocument, workspace]);
  useHotkeys(keyboardShortcuts.closeOtherDocuments.hotkey, () => {
    if (activeDocument && !workspace?.ui.cookiesTabActive && !workspace?.ui.settingsTabActive && !workspace?.ui.variablesTabActive) closeOtherTabs(activeDocument.id);
  }, shortcutOptions, [activeDocument, workspace]);
  useHotkeys(keyboardShortcuts.closeAllDocuments.hotkey, closeAllTabs, shortcutOptions, [workspace]);
  if (!store || !workspace) return <div className="flex h-screen items-center justify-center bg-purr-base p-ui-6 font-ui text-ui-md text-content-secondary">
    {loadError ? <div className="max-w-ui-dialog space-y-ui-4"><p role="alert">{loadError}</p><Button onClick={retry}>Retry loading workspaces</Button></div> : <p>Opening workspace…</p>}
  </div>;
  const changeEnvironment = async (id: string | null, environments = workspace.environments) => {
    try {
      const selected = environments.find((item) => item.id === id);
      const resolved = selected ? await resolveEnvironmentSecrets(selected, persistence.secure) : undefined;
      update((current) => ({ ...current,
    activeEnvironmentId: id, environments: environments.map((item) => item.id === resolved?.id ? resolved : item),
    documents: current.documents.map((document) => isRequestDocument(document) ? ({ ...document, request: { ...document.request, auth: {
      ...document.request.auth, oauth2: { ...document.request.auth.oauth2, token: null },
    } } }) : document),
  }));
    } catch { setActionError("Could not unlock environment secrets."); }
  };
  const variablesForEnvironment = async (id: string | null) => {
    const environment = workspace.environments.find((item) => item.id === id);
    const resolved = environment ? await resolveEnvironmentSecrets(environment, persistence.secure) : undefined;
    const environments = resolved ? workspace.environments.map((item) => item.id === resolved.id ? resolved : item) : workspace.environments;
    if (resolved && resolved !== environment) update((current) => ({ ...current, environments: current.environments.map((item) => item.id === resolved.id ? resolved : item) }));
    return getVariableNamespace({ ...workspace, environments }, store.globalVariables, id);
  };
  const openVariableDefinition = (id: string) => {
    const scope: VariableScope = store.globalVariables.some((variable) => variable.id === id) ? "global"
      : workspace.variables.some((variable) => variable.id === id) ? "workspace"
        : `environment:${workspace.environments.find((environment) => environment.variables.some((variable) => variable.id === id))?.id ?? workspace.activeEnvironmentId ?? ""}`;
    openVariables(scope, id, null);
  };
  const createMissingVariableDefinition = (name: string, kind: "static" | "dynamic-request", sensitive = false) => {
    const variable = kind === "dynamic-request" ? { ...createDynamicVariable(name), sensitive }
      : { id: crypto.randomUUID(), name, enabled: true, sensitive, kind: "static" as const, value: "", ...(sensitive ? { loaded: true } : {}) };
    if (kind === "dynamic-request") {
      openVariables("workspace", null, variable); return;
    }
    const environment = workspace.environments.find((item) => item.id === workspace.activeEnvironmentId);
    if (environment) {
      openVariables(`environment:${environment.id}`, null, variable);
    } else {
      let environmentName = "New environment"; let suffix = 2;
      while (workspace.environments.some((item) => item.name === environmentName)) environmentName = `New environment ${suffix++}`;
      const created = { id: crypto.randomUUID(), name: environmentName, variables: [] };
      update((current) => ({ ...current, activeEnvironmentId: created.id, environments: [...current.environments, created] }));
      openVariables(`environment:${created.id}`, null, variable);
    }
  };
  const importWorkspace = async (source: ImportSource) => {
    const imported = await importWorkspaceSource(source, persistence, services.imports);
    setStore((current) => current ? { ...current, activeWorkspaceId: imported.id,
      workspaces: [...current.workspaces.filter((candidate) => candidate.id !== imported.id), imported] } : current);
    setDialog(null);
  };
  return <div className="flex h-full min-h-0 flex-col overflow-hidden bg-purr-base font-ui text-content-primary">
    <WorkspaceHeader store={store} workspace={workspace} onWorkspace={(id) => setStore((current) => current ? { ...current, activeWorkspaceId: id } : current)}
      cookieJar={cookieJar!} cookiesActive={workspace.ui.cookiesTabActive} settingsActive={workspace.ui.settingsTabActive} variablesActive={workspace.ui.variablesTabActive} onCookies={openCookies} onVariables={() => openVariables("effective", null, null)}
      onNewWorkspace={() => setDialog("new-workspace")}
      onImportWorkspace={() => setDialog("import-workspace")}
      onRequestSettings={openSettings}
      onEnvironment={changeEnvironment} onEditEnvironment={() => showEnvironment()} onNewEnvironment={() => showEnvironment(true)}
      onToggleSidebar={toggleSidebar} onPalette={() => setDialog("palette")} onView={selectView} />
    <div className="flex min-h-0 flex-1">
      <Collapsible open={workspace.ui.sidebarOpen} orientation="horizontal" className={cn("h-full shrink-0", resizingSidebar && "!transition-none")} style={{ "--sidebar-width": `${workspace.ui.sidebarWidth}rem` } as CSSProperties}><WorkspaceSidebar key={workspace.id} workspace={workspace} extensionTypes={extensions.documentTypes} onOpen={(id) => update((current) => previewDocument(current, id))} onPin={(id) => update((current) => pinDocument(current, id))} onNew={addDocument} onNewExtension={addExtensionDocument} onNewFolder={createFolder} onDuplicate={duplicateById} onDiscard={discardById} onDiscardAll={discardAll} onDelete={deleteById} onRename={(id) => setDialog({ renameDocument: id })} onMoveDocument={moveDocument} onMoveDocuments={moveDocuments} onReorderDocument={reorderSidebarItem} onMoveFolder={moveFolder} onRenameFolder={(id) => setDialog({ renameFolder: id })} onDeleteFolder={deleteFolder} onOpenFolder={() => {
        setActionError("");
        void services.workspaceShell.openWorkspaceFolder(workspace.id).catch((error) => setActionError(String(error)));
      }} /></Collapsible>
      {workspace.ui.sidebarOpen && <div role="separator" tabIndex={0} aria-label="Resize sidebar" aria-orientation="vertical" aria-valuemin={12} aria-valuemax={28} aria-valuenow={Math.round(workspace.ui.sidebarWidth)} className="ui-focus-ring flex w-ui-1 shrink-0 touch-none cursor-col-resize" onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        sidebarResize.current = { startX: event.clientX, width: workspace.ui.sidebarWidth };
        setResizingSidebar(true);
      }} onPointerMove={(event) => {
        if (!sidebarResize.current) return;
        const rootFontSize = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
        const width = Math.max(12, Math.min(28, sidebarResize.current.width + (event.clientX - sidebarResize.current.startX) / rootFontSize));
        update((current) => current.ui.sidebarWidth === width ? current : { ...current, ui: { ...current.ui, sidebarWidth: width } });
      }} onPointerUp={(event) => {
        sidebarResize.current = null;
        setResizingSidebar(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }} onPointerCancel={() => { sidebarResize.current = null; setResizingSidebar(false); }} onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        update((current) => ({ ...current, ui: { ...current.ui, sidebarWidth: Math.max(12, Math.min(28, current.ui.sidebarWidth + (event.key === "ArrowRight" ? 1 : -1))) } }));
      }} />}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DocumentTabs workspace={workspace} cookieCount={cookieJar!.list().length} extensionTypes={extensions.documentTypes} onOpen={(id) => update((current) => openDocument(current, id))} onClose={closeById}
          onPin={(id) => update((current) => pinDocument(current, id))} onDuplicate={duplicateById} onCloseOther={closeOtherTabs} onCloseAll={closeAllTabs} onReorder={(sourceId, targetId) => update((current) => reorderOpenDocuments(current, sourceId, targetId))}
          onOpenCookies={openCookies} onCloseCookies={closeCookies} onOpenSettings={openSettings} onCloseSettings={closeSettings} onOpenVariables={() => openVariables()} onCloseVariables={closeVariables} onNew={addDocument} onNewExtension={addExtensionDocument} onSave={saveCurrentDocument} />
        <div id="active-document-panel" role="tabpanel" aria-labelledby={workspace.ui.settingsTabActive ? "document-tab-workspace-settings-tab" : workspace.ui.variablesTabActive ? "document-tab-workspace-variables-tab" : workspace.ui.cookiesTabActive ? "document-tab-workspace-cookies-tab" : activeDocument ? `document-tab-${activeDocument.id}` : undefined} className="min-h-0 min-w-0 flex-1">
          {workspace.ui.settingsTabActive ? <WorkspaceSettings name={workspace.name} description={workspace.description} config={workspace.requestConfig}
            integrations={(workspace.extraResources ?? []).filter((resource) => resource.kind === "integration")}
            variables={variables}
            variableActions={{ definitions: getEffectiveVariables(workspace, store.globalVariables), onOpenVariable: openVariableDefinition, onCreateMissingVariable: createMissingVariableDefinition }}
            onNameChange={(name) => update((current) => ({ ...current, name }))}
            onDescriptionChange={(description) => update((current) => ({ ...current, description }))}
            onIntegrationChange={(id, change) => update((current) => ({ ...current, extraResources: (current.extraResources ?? []).map((resource) => resource.kind === "integration" && resource.id === id ? { ...resource, ...change } : resource) }))}
            onIntegrationDelete={(id) => update((current) => ({ ...current, extraResources: (current.extraResources ?? []).filter((resource) => resource.kind !== "integration" || resource.id !== id) }))}
            onConfigChange={(requestConfig) => update((current) => {
              const reconcile = (request: RequestDraft, kind: "http" | "graphql") => {
                const selected = request.auth.type === "inherit" ? request.auth.inherit.profileId : undefined;
                if (!selected || requestConfig.auth.some((profile) => profile.id === selected && (profile.scope === "all" || profile.scope === kind)))
                  return request;
                const fallback = getWorkspaceAuth(requestConfig, kind);
                return { ...request, auth: fallback
                  ? { ...request.auth, type: "inherit" as const, inherit: { source: "workspace" as const, profileId: fallback.id } }
                  : { ...request.auth, type: "none" as const } };
              };
              return { ...current, requestConfig,
                documents: current.documents.map((document) => {
                  if (!isRequestDocument(document)) return document;
                  const request = reconcile(!document.saved ? withWorkspaceAuthDefault(document.request, document.kind, requestConfig) : document.request, document.kind);
                  const savedRequest = document.savedRequest ? reconcile(document.savedRequest, document.kind) : document.savedRequest;
                  return { ...document, request, savedRequest };
                }),
              };
            })} onDelete={async () => { try {
              await deleteWorkspace(workspace.id); jars.current.delete(workspace.id); dynamicSessionCaches.current.delete(workspace.id);
              setSessions((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${workspace.id}:`))));
            } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); } }} />
          : workspace.ui.variablesTabActive ? <VariablesExplorer key={workspace.id} workspace={workspace} globalVariables={store.globalVariables} scope={variableScope} selectedId={variableSelection} draft={variableDraft} documents={sourceDocuments}
            onWorkspaceVariablesChange={(variables) => { removeUnusedVariableSecrets(workspace.variables, variables); update((current) => {
              const next = { ...current, variables }; return { ...next, dynamicVariableCache: pruneVariableCache(next, store.globalVariables) };
            }); }}
            onGlobalVariablesChange={(globalVariables) => { removeUnusedVariableSecrets(store.globalVariables, globalVariables); setStore((current) => current ? { ...current, globalVariables,
              workspaces: current.workspaces.map((candidate) => ({ ...candidate, dynamicVariableCache: pruneVariableCache(candidate, globalVariables) })),
            } : current); }}
            onEnvironmentChange={(environment) => {
              const previous = workspace.environments.find((item) => item.id === environment.id);
              if (previous) removeUnusedVariableSecrets(previous.variables, environment.variables);
              update((current) => { const next = { ...current, environments: current.environments.map((item) => item.id === environment.id ? environment : item) };
                return { ...next, dynamicVariableCache: pruneVariableCache(next, store.globalVariables) }; });
            }}
            onDeleteEnvironment={(id) => {
              const removed = workspace.environments.find((environment) => environment.id === id);
              if (removed) removeUnusedVariableSecrets(removed.variables, []);
              const releaseEnvironment = (variable: Variable): Variable => variable.kind === "dynamic-request" && variable.environment.type === "specific" && variable.environment.environmentId === id
                ? { ...variable, environment: { type: "current" } } : variable;
              setStore((current) => current ? { ...current,
                globalVariables: current.globalVariables.map(releaseEnvironment),
                workspaces: current.workspaces.map((candidate) => candidate.id !== workspace.id ? candidate : { ...candidate,
                  activeEnvironmentId: candidate.activeEnvironmentId === id ? null : candidate.activeEnvironmentId,
                  environments: candidate.environments.filter((environment) => environment.id !== id).map((environment) => ({ ...environment, variables: environment.variables.map(releaseEnvironment) })),
                  dynamicVariableCache: {}, variables: candidate.variables.map(releaseEnvironment),
                  documents: candidate.documents.map((document) => isRequestDocument(document) && document.request.environmentId === id ? { ...document, request: { ...document.request, environmentId: undefined } } : document),
                }),
              } : current);
              setVariableScope("effective"); setVariableSelection(null);
            }}
            onOpenRequest={(id) => update((current) => openDocument(current, id))}
            onScopeChange={setVariableScope}
            onSelectionChange={setVariableSelection}
            onDraftChange={setVariableDraft}
            onResolveVariable={async (variable) => {
              if (variable.kind !== "dynamic-request") return;
              const runtime: AuthRuntime = { busy: false, authorizing: false, error: "", now: Date.now(),
                run: async () => { throw new Error("Authorize the source request before resolving this variable."); }, cancel: () => {}, clearError: () => {} };
              const root = { id: `variable-${variable.id}`, name: variable.name, kind: "http" as const,
                request: { ...createHttpDocument().request, url: `http://purr.local/{{${variable.name}}}` } };
              try {
                const resolution = await resolveDynamicVariables({ root, environmentId: workspace.activeEnvironmentId, documents: sourceDocuments,
                  variablesForEnvironment, persistentCache: workspace.dynamicVariableCache, sessionCache: dynamicVariableSessionCache,
                  responseContent: services.responseContent,
                  forceVariableIds: new Set([variable.id]),
                  execute: async (document, resolvedVariables, environmentId) => {
                    const scoped = await variablesForEnvironment(environmentId);
                    const auth = getWorkspaceAuth(workspace.requestConfig, document.kind,
                      document.request.auth.type === "inherit" ? document.request.auth.inherit.profileId : undefined);
                    return executeRequest(applyWorkspaceRequestConfig(document.request, document.kind, workspace.requestConfig), {
                      variables: resolvedVariables, sensitiveVariableNames: scoped.filter((item) => item.sensitive).map((item) => item.name),
                      requestDocumentId: document.id,
                      workspaceProfiles: getWorkspaceAuthProfiles(workspace.requestConfig, document.kind).map((profile) => ({ id: profile.id, name: profile.name || workspace.name, auth: profile.value })),
                      workspace: document.request.workspace.authEnabled && auth
                        ? { id: auth.id, name: auth.name || workspace.name, auth: auth.value } : undefined,
                    }, cookieJar!, runtime, services.httpTransport, services.responseContent, undefined, services.requestBodies);
                  } });
                update((current) => ({ ...current, dynamicVariableCache: resolution.cache }));
              } catch (cause) {
                if (cause instanceof DynamicVariableResolutionError) update((current) => ({ ...current, dynamicVariableCache: cause.cache }));
                throw cause;
              }
            }} />
          : workspace.ui.cookiesTabActive ? <section aria-label="Workspace cookies" className="h-full min-h-0 overflow-auto bg-purr-base p-ui-2">
            <div className="min-h-full rounded-ui-xl border border-border-subtle bg-purr-surface">
              <CookieJarEditor jar={cookieJar!} url={currentDocument?.request.url ?? ""} enabled={currentDocument?.request.useCookieJar ?? true}
                onEnabledChange={(useCookieJar) => setDraft((request) => ({ ...request, useCookieJar }))} />
            </div>
          </section> : activeDocument?.kind === "extension" ? <ExtensionDocumentHost key={`${workspace.id}:${activeDocument.id}`} document={activeDocument} registration={extensions.documentType(activeDocument.extensionType)}
            onChange={(change) => update((current) => ({ ...current, documents: current.documents.map((item) => item.id === activeDocument.id && isExtensionDocument(item)
              ? { ...item, ...change, updatedAt: new Date().toISOString() } : item) }))} />
          : activeDocument?.kind === "schema" ? <SchemaExplorer key={`${workspace.id}:${activeDocument.id}:${contextKey}`} document={activeDocument}
            source={schemaSource} variables={variables} workspaceConfig={workspace.requestConfig} cookieJar={cookieJar!} setSourceDraft={(change) => setRequestDraft(schemaSource?.id, change)}
            onChange={(patch) => update((current) => ({ ...current, documents: current.documents.map((item) => item.id === activeDocument.id && item.kind === "schema" ? { ...item, ...patch } : item) }))}
            onWorkspaceAuthChange={updateWorkspaceAuth}
            onCreateRequest={createRequestFromSchema} />
          : currentDocument ? <RequestWorkbench key={`${workspace.id}:${currentDocument.id}:${contextKey}`} draft={currentDocument.request} setDraft={setDraft}
            requestKind={currentDocument.kind} workspaceConfig={workspace.requestConfig}
            workspaceName={workspace.name} documentId={currentDocument.id} documentName={getDocumentDisplayName(currentDocument)} sourceDocuments={sourceDocuments}
            onOpenVariable={openVariableDefinition}
            onCreateMissingVariable={createMissingVariableDefinition}
            onWorkspaceAuthChange={updateWorkspaceAuth}
            onImportCurl={importCurlIntoActiveDocument}
            onCreateVariable={(candidate) => {
              const baseName = candidate.name.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^\d/, "_$&") || "response_value";
              let name = `${baseName}_var`; let suffix = 2;
              while (workspace.variables.some((variable) => variable.name === name)) name = `${baseName}_var_${suffix++}`;
              if (candidate.dynamic && !currentDocument.saved) { setActionError("Save this request before using it as a dynamic variable source."); return; }
              const variable = candidate.dynamic ? createDynamicVariable(name, currentDocument.id, candidate.jsonPath)
                : { id: crypto.randomUUID(), name, enabled: true, sensitive: false, kind: "static" as const, value: candidate.value };
              openVariables("workspace", null, variable);
            }}
            schema={schema} onOpenSchema={() => openSchema()} onOpenGraphqlType={(name) => openSchema(name)}
            view={workspace.ui.view} splitRatios={workspace.ui.splitRatios} onSplitRatioChange={(orientation, ratio) => update((current) => ({ ...current, ui: { ...current.ui, splitRatios: { ...current.ui.splitRatios, [orientation]: ratio } } }))}
            requestSection={currentDocument.ui.requestSection} onRequestSectionChange={(requestSection) => updateDocument((document) => ({ ...document, ui: { ...document.ui, requestSection } }))}
            variables={variables} runtimeVariables={getEffectiveVariables(workspace, store.globalVariables)} environmentId={workspace.activeEnvironmentId} variablesForEnvironment={variablesForEnvironment}
            dynamicVariableCache={workspace.dynamicVariableCache} dynamicVariableSessionCache={dynamicVariableSessionCache} onDynamicVariableCacheChange={(dynamicVariableCache) => update((current) => JSON.stringify(current.dynamicVariableCache) === JSON.stringify(dynamicVariableCache) ? current : ({ ...current, dynamicVariableCache }))}
            cookieJar={cookieJar!} session={session} onSessionChange={changeSession} actionsRef={requestActions} />
            : <EmptyWorkspace
              onNew={() => addDocument()}
              onPasteCurl={() => { void pasteCurl(); }}
              onPasteCommand={(command) => { if (isCurlCommand(command)) importCurlAsDocument(command); }}
              pasteTargetRef={emptyPasteTarget}
            />}
        </div>
      </div>
    </div>
    <footer className="flex h-control-sm shrink-0 items-center justify-end gap-ui-3 border-t border-border-subtle bg-purr-base px-ui-3 text-ui-xs text-content-tertiary">
      {saveError || actionError ? <><span role="alert" className="min-w-0 truncate text-accent-red" title={saveError || actionError}>{saveError ? `Could not save workspace: ${saveError}` : actionError}</span>{saveError ? <Button variant="ghost" size="xs" onClick={() => { void retrySave().catch(() => {}); }}>Reload and retry</Button> : null}</>
        : <span role="status">{saving ? "Saving…" : "Saved locally"}</span>}
    </footer>
    {dialog === "palette" && <CommandPalette workspace={workspace} actions={actions} onOpenDocument={(id) => update((current) => previewDocument(current, id))} onClose={() => setDialog(null)} />}
    {dialog === "new-workspace" && <NameDialog title="New workspace" label="Workspace name" initial="" onClose={() => setDialog(null)} onSave={(name) => {
      const created = createWorkspace(name);
      setStore((current) => current ? { ...current, activeWorkspaceId: created.id, workspaces: [...current.workspaces, created] } : current);
      setDialog(null);
    }} />}
    {dialog === "import-workspace" && <ImportWorkspaceDialog onClose={() => setDialog(null)} onImport={importWorkspace} />}
    {dialog === "save-document" && currentDocument && <NameDialog title="Save document" label="Document name" initial={getDocumentDisplayName(currentDocument)} onClose={() => setDialog(null)} onSave={(name) => {
      updateDocument((document) => ({ ...document, name, saved: true, savedRequest: cloneRequestDraft(document.request), updatedAt: new Date().toISOString() })); setDialog(null);
    }} />}
    {dialog && typeof dialog === "object" && "renameDocument" in dialog && (() => {
      const document = workspace.documents.find((item) => item.id === dialog.renameDocument);
      return document ? <NameDialog title="Rename document" label="Document name" initial={getDocumentDisplayName(document)} onClose={() => setDialog(null)} onSave={(name) => {
        update((current) => ({ ...current, documents: current.documents.map((item) => item.id === document.id ? { ...item, name, updatedAt: new Date().toISOString() } : item) })); setDialog(null);
      }} /> : null;
    })()}
    {dialog && typeof dialog === "object" && "newFolder" in dialog && <NameDialog title="New folder" label="Folder name" initial="" onClose={() => setDialog(null)} onSave={(name) => {
      const folder: Extract<ProjectResource, { kind: "folder" }> = { id: crypto.randomUUID(), name, kind: "folder", ...(dialog.newFolder ? { folderId: dialog.newFolder } : {}) };
      update((current) => ({ ...current, extraResources: [...(current.extraResources ?? []), folder] })); setDialog(null);
    }} />}
    {dialog && typeof dialog === "object" && "renameFolder" in dialog && (() => {
      const folder = (workspace.extraResources ?? []).find((resource): resource is Extract<ProjectResource, { kind: "folder" }> => resource.id === dialog.renameFolder && resource.kind === "folder");
      return folder ? <NameDialog title="Rename folder" label="Folder name" initial={folder.name} onClose={() => setDialog(null)} onSave={(name) => {
        update((current) => ({ ...current, extraResources: (current.extraResources ?? []).map((resource) => resource.id === folder.id && resource.kind === "folder" ? { ...resource, name } : resource) })); setDialog(null);
      }} /> : null;
    })()}
  </div>;
}
