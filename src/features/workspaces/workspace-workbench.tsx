import { useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { Columns2, Cookie as CookieIcon, Copy, FilePlus2, Globe2, Network, PanelLeft, RotateCcw, Rows2, Save, SendHorizontal, Settings2, Square, TextCursorInput, Trash2, Waypoints } from "lucide-react";
import { SchemaExplorer } from "../graphql/components/schema-explorer";
import { parseGraphqlSchema } from "../graphql/model/graphql";
import { Button } from "../../shared/components/ui/button";
import { keyboardShortcuts } from "../../shared/config/keyboard-shortcuts";
import { RequestWorkbench, emptyRequestSession, type RequestActions, type RequestSession } from "../request-workbench/request-workbench";
import { SessionCookieJar } from "../request-workbench/model/cookie-jar";
import type { AuthRuntime } from "../request-workbench/hooks/use-auth-runtime";
import type { RequestDraft } from "../request-workbench/model/request";
import { applyWorkspaceRequestConfig, getWorkspaceAuth, withWorkspaceAuthDefault } from "../request-workbench/model/request-workspace-config";
import { executeRequest } from "../request-workbench/services/execute-request";
import { CookieJarEditor } from "../request-workbench/components/cookie-jar-editor";
import { importCurlRequest } from "../request-workbench/model/curl-import";
import { CommandPalette, type PaletteAction } from "./components/command-palette";
import { DocumentTabs } from "./components/document-tabs";
import { createDynamicVariable, VariablesExplorer, type VariableScope } from "./components/variables-explorer";
import { DynamicVariableResolutionError, resolveDynamicVariables } from "./services/dynamic-variable-resolver";
import { NameDialog } from "./components/name-dialog";
import { WorkspaceHeader } from "./components/workspace-header";
import { WorkspaceSidebar } from "./components/workspace-sidebar";
import { WorkspaceSettings } from "./components/workspace-request-settings";
import { EmptyWorkspace } from "./components/empty-workspace";
import { Collapsible } from "../../shared/components/ui/collapsible";
import { useWorkspaces } from "./hooks/use-workspaces";
import { openWorkspaceFolder, workspacePersistence } from "./services/workspace-storage";
import { secretRef } from "../../storage/secrets";
import { resolveEnvironmentSecrets } from "../../application/environment-secrets";
import {
  cloneRequestDraft,
  closeDocument,
  discardAllDrafts,
  createHttpDocument,
  createGraphqlDocument,
  createSchemaDocument,
  createWorkspace,
  discardDocument,
  deleteDocument,
  duplicateDocument,
  getEffectiveVariables,
  getEffectiveVariableValues,
  getVariableNamespace,
  getDocumentDisplayName,
  isDocumentDirty,
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

type Dialog = "palette" | "new-workspace" | "save-document" | { renameDocument: string } | null;
const actionErrorTimeoutMs = 15_000;

function pruneVariableCache(workspace: Workspace, globalVariables: readonly Variable[]) {
  const variables = new Map([...globalVariables, ...workspace.variables, ...workspace.environments.flatMap((environment) => environment.variables)]
    .map((variable) => [variable.id, variable]));
  return Object.fromEntries(Object.entries(workspace.dynamicVariableCache).filter(([key, entry]) => {
    const variable = variables.get(key.split(":", 1)[0]);
    return variable?.kind === "dynamic-request" && entry.fingerprint === JSON.stringify(variable);
  }));
}

export function WorkspaceWorkbench() {
  const { store, setStore, updateWorkspace, deleteWorkspace, loadError, saveError, saving, retry, flush } = useWorkspaces();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [sessions, setSessions] = useState<Record<string, RequestSession>>({});
  const [actionError, setActionError] = useState("");
  const [variableScope, setVariableScope] = useState<VariableScope>("effective");
  const [variableSelection, setVariableSelection] = useState<string | null>(null);
  const [variableDraft, setVariableDraft] = useState<Variable | null>(null);
  const jars = useRef(new Map<string, SessionCookieJar>());
  const dynamicSessionCaches = useRef(new Map<string, Map<string, Workspace["dynamicVariableCache"][string]>>());
  const requestActions = useRef<RequestActions>(null);
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
    if (removed.length) void Promise.all(removed.map((reference) => workspacePersistence().secure.delete(reference))).catch(() => setActionError("Could not remove an obsolete variable secret."));
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
  const addDocument = (kind: CreatableDocumentKind = workspace?.ui.lastRequestKind ?? "http") => {
    if (kind === "schema") {
      const document = createSchemaDocument();
      update((current) => openDocument({ ...current, documents: [...current.documents, document] }, document.id));
      return;
    }
    let document: RequestDocument = kind === "graphql" ? createGraphqlDocument() : createHttpDocument();
    if (workspace)
      document = { ...document, request: withWorkspaceAuthDefault(document.request, kind, workspace.requestConfig) };
    update((current) => openDocument({ ...current, documents: [...current.documents, document] }, document.id));
  };
  const pasteCurl = async () => {
    try {
      const command = await navigator.clipboard.readText();
      let document = createHttpDocument();
      const request = importCurlRequest(command, document.request);
      document = { ...document, request: workspace ? withWorkspaceAuthDefault(request, "http", workspace.requestConfig) : request };
      update((current) => openDocument({ ...current, documents: [...current.documents, document] }, document.id));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not read a cURL command from the clipboard.");
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
        const environment = await resolveEnvironmentSecrets(existing, workspacePersistence().secure);
        update((current) => ({ ...current, environments: current.environments.map((item) => item.id === environment.id ? environment : item) }));
        openVariables(`environment:${environment.id}`, null, null);
      } else openVariables("effective", null, null);
    }
    catch { setActionError("Could not unlock environment secrets."); }
  };
  const saveCurrentDocument = () => {
    if (!currentDocument) return;
    if (!currentDocument.saved) { setDialog("save-document"); return; }
    if (!isDocumentDirty(currentDocument)) return;
    updateDocument((document) => ({ ...document, savedRequest: cloneRequestDraft(document.request), updatedAt: new Date().toISOString() }));
  };
  const actions: PaletteAction[] = [
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
      const resolved = selected ? await resolveEnvironmentSecrets(selected, workspacePersistence().secure) : undefined;
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
    const resolved = environment ? await resolveEnvironmentSecrets(environment, workspacePersistence().secure) : undefined;
    const environments = resolved ? workspace.environments.map((item) => item.id === resolved.id ? resolved : item) : workspace.environments;
    if (resolved && resolved !== environment) update((current) => ({ ...current, environments: current.environments.map((item) => item.id === resolved.id ? resolved : item) }));
    return getVariableNamespace({ ...workspace, environments }, store.globalVariables, id);
  };
  return <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-purr-base font-ui text-content-primary">
    <WorkspaceHeader store={store} workspace={workspace} onWorkspace={(id) => setStore((current) => current ? { ...current, activeWorkspaceId: id } : current)}
      cookieJar={cookieJar!} cookiesActive={workspace.ui.cookiesTabActive} settingsActive={workspace.ui.settingsTabActive} variablesActive={workspace.ui.variablesTabActive} onCookies={openCookies} onVariables={() => openVariables("effective", null, null)}
      onNewWorkspace={() => setDialog("new-workspace")}
      onRequestSettings={openSettings}
      onEnvironment={changeEnvironment} onEditEnvironment={() => showEnvironment()} onNewEnvironment={() => showEnvironment(true)}
      onToggleSidebar={toggleSidebar} onPalette={() => setDialog("palette")} onView={selectView} />
    <div className="flex min-h-0 flex-1">
      <Collapsible open={workspace.ui.sidebarOpen} orientation="horizontal" className="h-full shrink-0"><WorkspaceSidebar key={workspace.id} workspace={workspace} onOpen={(id) => update((current) => previewDocument(current, id))} onPin={(id) => update((current) => pinDocument(current, id))} onNew={addDocument} onDuplicate={duplicateById} onDiscard={discardById} onDiscardAll={discardAll} onDelete={deleteById} onRename={(id) => setDialog({ renameDocument: id })} onOpenFolder={() => {
        setActionError("");
        void openWorkspaceFolder(workspace.id).catch((error) => setActionError(String(error)));
      }} /></Collapsible>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DocumentTabs workspace={workspace} cookieCount={cookieJar!.list().length} onOpen={(id) => update((current) => openDocument(current, id))} onClose={closeById}
          onPin={(id) => update((current) => pinDocument(current, id))} onDuplicate={duplicateById} onCloseOther={closeOtherTabs} onCloseAll={closeAllTabs} onReorder={(sourceId, targetId) => update((current) => reorderOpenDocuments(current, sourceId, targetId))}
          onOpenCookies={openCookies} onCloseCookies={closeCookies} onOpenSettings={openSettings} onCloseSettings={closeSettings} onOpenVariables={() => openVariables()} onCloseVariables={closeVariables} onNew={addDocument} onSave={saveCurrentDocument} />
        <div id="active-document-panel" role="tabpanel" aria-labelledby={workspace.ui.settingsTabActive ? "document-tab-workspace-settings-tab" : workspace.ui.variablesTabActive ? "document-tab-workspace-variables-tab" : workspace.ui.cookiesTabActive ? "document-tab-workspace-cookies-tab" : activeDocument ? `document-tab-${activeDocument.id}` : undefined} className="min-h-0 min-w-0 flex-1">
          {workspace.ui.settingsTabActive ? <WorkspaceSettings name={workspace.name} description={workspace.description} config={workspace.requestConfig}
            variables={variables}
            onNameChange={(name) => update((current) => ({ ...current, name }))}
            onDescriptionChange={(description) => update((current) => ({ ...current, description }))}
            onConfigChange={(requestConfig) => update((current) => ({ ...current, requestConfig,
              documents: current.documents.map((document) => !document.saved && isRequestDocument(document)
                ? { ...document, request: withWorkspaceAuthDefault(document.request, document.kind, requestConfig) }
                : document),
            }))} onDelete={async () => { try {
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
                  forceVariableIds: new Set([variable.id]),
                  execute: async (document, resolvedVariables, environmentId) => {
                    const scoped = await variablesForEnvironment(environmentId);
                    const auth = getWorkspaceAuth(workspace.requestConfig, document.kind);
                    return executeRequest(applyWorkspaceRequestConfig(document.request, document.kind, workspace.requestConfig), {
                      variables: resolvedVariables, sensitiveVariableNames: scoped.filter((item) => item.sensitive).map((item) => item.name),
                      requestDocumentId: document.id, workspace: document.request.workspace.authEnabled && auth
                        ? { id: `workspace-auth-${auth.id}`, name: auth.name || workspace.name, auth: auth.value } : undefined,
                    }, cookieJar!, runtime);
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
          </section> : activeDocument?.kind === "schema" ? <SchemaExplorer key={`${workspace.id}:${activeDocument.id}:${contextKey}`} document={activeDocument}
            source={schemaSource} variables={variables} workspaceConfig={workspace.requestConfig} cookieJar={cookieJar!} setSourceDraft={(change) => setRequestDraft(schemaSource?.id, change)}
            onChange={(patch) => update((current) => ({ ...current, documents: current.documents.map((item) => item.id === activeDocument.id && item.kind === "schema" ? { ...item, ...patch } : item) }))}
            onCreateRequest={createRequestFromSchema} />
          : currentDocument ? <RequestWorkbench key={`${workspace.id}:${currentDocument.id}:${contextKey}`} draft={currentDocument.request} setDraft={setDraft}
            requestKind={currentDocument.kind} workspaceConfig={workspace.requestConfig}
            workspaceName={workspace.name} documentId={currentDocument.id} documentName={getDocumentDisplayName(currentDocument)} sourceDocuments={sourceDocuments}
            onOpenVariable={(id) => {
              const scope: VariableScope = store.globalVariables.some((variable) => variable.id === id) ? "global"
                : workspace.variables.some((variable) => variable.id === id) ? "workspace"
                  : `environment:${workspace.environments.find((environment) => environment.variables.some((variable) => variable.id === id))?.id ?? workspace.activeEnvironmentId ?? ""}`;
              openVariables(scope, id, null);
            }}
            onCreateMissingVariable={(name, kind) => {
              const variable = kind === "dynamic-request" ? createDynamicVariable(name)
                : { id: crypto.randomUUID(), name, enabled: true, sensitive: false, kind: "static" as const, value: "" };
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
            }}
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
            : <EmptyWorkspace onNew={() => addDocument()} onPasteCurl={() => { void pasteCurl(); }} />}
        </div>
      </div>
    </div>
    <footer className="flex h-control-sm shrink-0 items-center justify-end gap-ui-3 border-t border-border-subtle bg-purr-base px-ui-3 text-ui-xs text-content-tertiary">
      {saveError || actionError ? <><span role="alert" className="min-w-0 truncate text-accent-red" title={saveError || actionError}>{saveError ? `Could not save workspace: ${saveError}` : actionError}</span>{saveError ? <Button variant="ghost" size="xs" onClick={() => { void flush().catch(() => {}); }}>Retry saving</Button> : null}</>
        : <span role="status">{saving ? "Saving…" : "Saved locally"}</span>}
    </footer>
    {dialog === "palette" && <CommandPalette workspace={workspace} actions={actions} onOpenDocument={(id) => update((current) => previewDocument(current, id))} onClose={() => setDialog(null)} />}
    {dialog === "new-workspace" && <NameDialog title="New workspace" label="Workspace name" initial="" onClose={() => setDialog(null)} onSave={(name) => {
      const created = createWorkspace(name);
      setStore((current) => current ? { ...current, activeWorkspaceId: created.id, workspaces: [...current.workspaces, created] } : current);
      setDialog(null);
    }} />}
    {dialog === "save-document" && currentDocument && <NameDialog title="Save document" label="Document name" initial={getDocumentDisplayName(currentDocument)} onClose={() => setDialog(null)} onSave={(name) => {
      updateDocument((document) => ({ ...document, name, saved: true, savedRequest: cloneRequestDraft(document.request), updatedAt: new Date().toISOString() })); setDialog(null);
    }} />}
    {dialog && typeof dialog === "object" && "renameDocument" in dialog && (() => {
      const document = workspace.documents.find((item) => item.id === dialog.renameDocument);
      return document ? <NameDialog title="Rename document" label="Document name" initial={getDocumentDisplayName(document)} onClose={() => setDialog(null)} onSave={(name) => {
        update((current) => ({ ...current, documents: current.documents.map((item) => item.id === document.id ? { ...item, name, updatedAt: new Date().toISOString() } : item) })); setDialog(null);
      }} /> : null;
    })()}
  </div>;
}
