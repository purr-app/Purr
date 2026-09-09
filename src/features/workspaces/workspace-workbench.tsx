import { useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { Columns2, Cookie as CookieIcon, Copy, FilePlus2, Globe2, PanelLeft, RotateCcw, Rows2, Save, SendHorizontal, Square, TextCursorInput, Trash2 } from "lucide-react";
import { Button } from "../../shared/components/ui/button";
import { keyboardShortcuts } from "../../shared/config/keyboard-shortcuts";
import { RequestWorkbench, emptyRequestSession, type RequestActions, type RequestSession } from "../request-workbench/request-workbench";
import { SessionCookieJar } from "../request-workbench/model/cookie-jar";
import type { RequestDraft } from "../request-workbench/model/request";
import { CookieJarEditor } from "../request-workbench/components/cookie-jar-editor";
import { CommandPalette, type PaletteAction } from "./components/command-palette";
import { DocumentTabs } from "./components/document-tabs";
import { EnvironmentEditor } from "./components/environment-editor";
import { NameDialog } from "./components/name-dialog";
import { WorkspaceHeader } from "./components/workspace-header";
import { WorkspaceSidebar } from "./components/workspace-sidebar";
import { useWorkspaces } from "./hooks/use-workspaces";
import { openWorkspaceFolder } from "./services/workspace-storage";
import {
  cloneRequestDraft,
  closeDocument,
  createHttpDocument,
  createWorkspace,
  discardDocument,
  getEnvironmentVariables,
  getDocumentDisplayName,
  isDocumentDirty,
  openDocument,
  pinDocument,
  previewDocument,
  reorderOpenDocuments,
  type Environment,
  type HttpDocument,
  type Workspace,
} from "./model/workspace";

type Dialog = "palette" | "new-workspace" | "rename-workspace" | "save-document" | { environment: Environment } | null;

export function WorkspaceWorkbench() {
  const { store, setStore, updateWorkspace, loadError, saveError, saving, retry, flush } = useWorkspaces();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [sessions, setSessions] = useState<Record<string, RequestSession>>({});
  const [actionError, setActionError] = useState("");
  const jars = useRef(new Map<string, SessionCookieJar>());
  const requestActions = useRef<RequestActions>(null);
  const workspace = store?.workspaces.find((item) => item.id === store.activeWorkspaceId);
  const currentDocument = workspace?.documents.find((item) => item.id === workspace.ui.activeDocumentId);
  const variables = useMemo(() => workspace ? getEnvironmentVariables(workspace) : {}, [workspace?.activeEnvironmentId, workspace?.environments]);
  const contextKey = JSON.stringify([workspace?.activeEnvironmentId, variables]);
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
    updateWorkspace(workspaceId, (current) => ({ ...current, documents: current.documents.map((document) => document.id === documentId
      ? {
          ...document,
          lastResponse: "response" in patch ? patch.response ?? null : document.lastResponse,
          sentAt: patch.sending === true ? new Date().toISOString() : document.sentAt,
        }
      : document) }));
  };
  const update = (change: (workspace: Workspace) => Workspace) => { if (workspace) updateWorkspace(workspace.id, change); };
  const updateDocument = (change: (document: HttpDocument) => HttpDocument) => {
    if (!currentDocument) return;
    update((current) => ({ ...current, documents: current.documents.map((document) => document.id === currentDocument.id ? change(document) : document) }));
  };
  const setDraft = (change: SetStateAction<RequestDraft>) => update((current) => {
    // An old in-flight request may finish after switching environments. Its
    // response remains attached to its document, but cannot change new credentials.
    if (JSON.stringify([current.activeEnvironmentId, getEnvironmentVariables(current)]) !== contextKey) return current;
    if (!currentDocument || !current.ui.openDocumentIds.includes(currentDocument.id)) return current;
    let pinPreview = false;
    const documents = current.documents.map((document) => {
      if (document.id !== currentDocument.id) return document;
      const request = typeof change === "function" ? change(document.request) : change;
      if (current.ui.previewDocumentId === document.id && isDocumentDirty({ ...document, request })) pinPreview = true;
      return { ...document, updatedAt: new Date().toISOString(), request };
    });
    return { ...current, documents, ui: pinPreview ? { ...current.ui, previewDocumentId: null } : current.ui };
  });
  const addDocument = (duplicate = false) => {
    let document = createHttpDocument();
    if (duplicate && currentDocument) document = { ...document, name: `${getDocumentDisplayName(currentDocument)} copy`, request: cloneRequestDraft(currentDocument.request), ui: { ...currentDocument.ui } };
    update((current) => openDocument({ ...current, documents: [...current.documents, document] }, document.id));
  };
  const closeById = (id: string) => update((current) => closeDocument(current, id));
  const discardById = (id: string) => {
    update((current) => discardDocument(current, id));
    if (workspace) setSessions((current) => {
      const next = { ...current };
      delete next[`${workspace.id}:${id}`];
      return next;
    });
  };
  const selectView = (view: Workspace["ui"]["view"]) => {
    update((current) => ({ ...current, ui: { ...current.ui, view } }));
    if (view === "canvas") changeSession({ canvasFocus: session.response || session.error || session.sending ? "response" : "request" });
  };
  const toggleSidebar = () => update((current) => ({ ...current, ui: { ...current.ui, sidebarOpen: !current.ui.sidebarOpen } }));
  const openCookies = () => update((current) => ({ ...current, ui: { ...current.ui, cookiesTabOpen: true, cookiesTabActive: true } }));
  const closeCookies = () => update((current) => ({ ...current, ui: { ...current.ui, cookiesTabOpen: false, cookiesTabActive: false } }));
  const showEnvironment = (create = false) => {
    const existing = workspace?.environments.find((item) => item.id === workspace.activeEnvironmentId);
    setDialog({ environment: !create && existing ? existing : { id: crypto.randomUUID(), name: "", variables: [] } });
  };
  const saveCurrentDocument = () => {
    if (!currentDocument) return;
    if (!currentDocument.saved) { setDialog("save-document"); return; }
    if (!isDocumentDirty(currentDocument)) return;
    updateDocument((document) => ({ ...document, savedRequest: cloneRequestDraft(document.request), updatedAt: new Date().toISOString() }));
  };
  const actions: PaletteAction[] = [
    ...(currentDocument && !workspace?.ui.cookiesTabActive ? [
      { id: "send", title: "Run request", icon: <SendHorizontal className="size-ui-4" />, shortcut: keyboardShortcuts.sendRequest, run: () => requestActions.current?.send() },
      ...(!currentDocument.saved || isDocumentDirty(currentDocument) ? [{ id: "save", title: currentDocument.saved ? "Save document changes" : "Save document", icon: <Save className="size-ui-4" />, shortcut: keyboardShortcuts.saveDocument, run: saveCurrentDocument }] : []),
      ...(isDocumentDirty(currentDocument) ? [{
        id: "discard",
        title: currentDocument.saved ? "Revert unsaved changes" : "Discard draft",
        icon: currentDocument.saved ? <RotateCcw className="size-ui-4" /> : <Trash2 className="size-ui-4" />,
        run: () => discardById(currentDocument.id),
      }] : []),
      { id: "duplicate", title: "Duplicate HTTP request", icon: <Copy className="size-ui-4" />, shortcut: keyboardShortcuts.duplicateDocument, run: () => addDocument(true) },
      { id: "focus-url", title: "Focus request URL", icon: <TextCursorInput className="size-ui-4" />, shortcut: keyboardShortcuts.focusUrl, run: () => requestActions.current?.focusUrl() },
    ] : []),
    { id: "new", title: "New HTTP request", icon: <FilePlus2 className="size-ui-4" />, shortcut: keyboardShortcuts.newDocument, run: () => addDocument() },
    { id: "cookies", title: "Open workspace cookies", icon: <CookieIcon className="size-ui-4" />, run: openCookies },
    { id: "environment", title: "Edit environment variables", icon: <Globe2 className="size-ui-4" />, shortcut: keyboardShortcuts.editEnvironment, run: () => showEnvironment() },
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
    if (workspace?.ui.cookiesTabActive) closeCookies();
    else if (currentDocument) closeById(currentDocument.id);
  }, shortcutOptions, [currentDocument, workspace]);

  if (!store || !workspace) return <div className="flex h-screen items-center justify-center bg-purr-base p-ui-6 font-ui text-ui-md text-content-secondary">
    {loadError ? <div className="max-w-ui-dialog space-y-ui-4"><p role="alert">{loadError}</p><Button onClick={retry}>Retry loading workspaces</Button></div> : <p>Opening workspace…</p>}
  </div>;
  const changeEnvironment = (id: string | null, environments = workspace.environments) => update((current) => ({ ...current,
    activeEnvironmentId: id, environments,
    documents: current.documents.map((document) => ({ ...document, request: { ...document.request, auth: {
      ...document.request.auth, oauth2: { ...document.request.auth.oauth2, token: null },
      bearer: { ...document.request.auth.bearer, receivedToken: "", responseError: "" },
    } } })),
  }));
  return <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-purr-base font-ui text-content-primary">
    <WorkspaceHeader store={store} workspace={workspace} onWorkspace={(id) => setStore((current) => current ? { ...current, activeWorkspaceId: id } : current)}
      cookieJar={cookieJar!} cookiesActive={workspace.ui.cookiesTabActive} onCookies={openCookies}
      onNewWorkspace={() => setDialog("new-workspace")} onRenameWorkspace={() => setDialog("rename-workspace")}
      onEnvironment={changeEnvironment} onEditEnvironment={() => showEnvironment()} onNewEnvironment={() => showEnvironment(true)}
      onToggleSidebar={toggleSidebar} onPalette={() => setDialog("palette")} onView={selectView} />
    <div className="flex min-h-0 flex-1">
      {workspace.ui.sidebarOpen && <WorkspaceSidebar key={workspace.id} workspace={workspace} onOpen={(id) => update((current) => previewDocument(current, id))} onNew={() => addDocument()} onDiscard={discardById} onOpenFolder={() => {
        setActionError("");
        void openWorkspaceFolder(workspace.id).catch((error) => setActionError(String(error)));
      }} />}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DocumentTabs workspace={workspace} cookieCount={cookieJar!.list().length} onOpen={(id) => update((current) => openDocument(current, id))} onClose={closeById}
          onPin={(id) => update((current) => pinDocument(current, id))} onReorder={(sourceId, targetId) => update((current) => reorderOpenDocuments(current, sourceId, targetId))}
          onOpenCookies={openCookies} onCloseCookies={closeCookies} onNew={() => addDocument()} onSave={saveCurrentDocument} />
        <div id="active-document-panel" role="tabpanel" aria-labelledby={workspace.ui.cookiesTabActive ? "document-tab-workspace-cookies-tab" : currentDocument ? `document-tab-${currentDocument.id}` : undefined} className="min-h-0 min-w-0 flex-1">
          {workspace.ui.cookiesTabActive ? <section aria-label="Workspace cookies" className="h-full min-h-0 overflow-auto bg-purr-base p-ui-2">
            <div className="min-h-full rounded-ui-xl border border-border-subtle bg-purr-surface">
              <CookieJarEditor jar={cookieJar!} url={currentDocument?.request.url ?? ""} enabled={currentDocument?.request.useCookieJar ?? true}
                onEnabledChange={(useCookieJar) => setDraft((request) => ({ ...request, useCookieJar }))} />
            </div>
          </section> : currentDocument ? <RequestWorkbench key={`${workspace.id}:${currentDocument.id}:${contextKey}`} draft={currentDocument.request} setDraft={setDraft}
            view={workspace.ui.view} splitRatios={workspace.ui.splitRatios} onSplitRatioChange={(orientation, ratio) => update((current) => ({ ...current, ui: { ...current.ui, splitRatios: { ...current.ui.splitRatios, [orientation]: ratio } } }))}
            requestSection={currentDocument.ui.requestSection} onRequestSectionChange={(requestSection) => updateDocument((document) => ({ ...document, ui: { ...document.ui, requestSection } }))}
            variables={variables} cookieJar={cookieJar!} session={session} onSessionChange={changeSession} actionsRef={requestActions} />
            : <div className="flex h-full flex-col items-center justify-center gap-ui-3 text-content-tertiary"><FilePlus2 className="size-ui-8" /><p className="text-ui-md">Open a document or start a new request.</p><Button variant="secondary" onClick={() => addDocument()}>New HTTP request</Button></div>}
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
    {dialog === "rename-workspace" && <NameDialog title="Rename workspace" label="Workspace name" initial={workspace.name} onClose={() => setDialog(null)} onSave={(name) => { update((current) => ({ ...current, name })); setDialog(null); }} />}
    {dialog === "save-document" && currentDocument && <NameDialog title="Save document" label="Document name" initial={getDocumentDisplayName(currentDocument)} onClose={() => setDialog(null)} onSave={(name) => {
      updateDocument((document) => ({ ...document, name, saved: true, savedRequest: cloneRequestDraft(document.request), updatedAt: new Date().toISOString() })); setDialog(null);
    }} />}
    {dialog && typeof dialog === "object" && <EnvironmentEditor initial={dialog.environment} onClose={() => setDialog(null)} onSave={(environment) => {
      const environments = workspace.environments.some((item) => item.id === environment.id) ? workspace.environments.map((item) => item.id === environment.id ? environment : item) : [...workspace.environments, environment];
      changeEnvironment(environment.id, environments); setDialog(null);
    }} />}
  </div>;
}
