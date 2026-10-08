import type { DynamicRequestCodeContext } from "./model/dynamic-request-code";
import { createDependencyAuthRuntime } from "./services/dependency-auth-runtime";
import { DynamicExecutionBadge } from "../history/dynamic-execution-badge";
import type { DynamicExecutionMetadata } from "../../application/ports/history";
import { DynamicDependencyChain } from "../workspaces/components/dynamic-dependency-chain";
import { HistoryPopover } from "../history/history-panel";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Dispatch, type Ref, type SetStateAction } from "react";

import { SplitPane } from "../../shared/components/ui/split-pane";
import { EmptyResponse } from "./components/empty-response";
import { RequestComposer } from "./components/request-composer";
import { type WorkbenchView } from "./components/request-tab-bar";
import type { GraphQLSchema } from "graphql";
import { executeRequest } from "./services/execute-request";
import type { RequestEditorSection } from "./model/request-editor-section";
import { ResponseViewer } from "./components/response-viewer";
import type { ResponseVariableCandidate } from "./components/response-viewer";
import { ErrorResponse, PendingResponse } from "./components/response-state-view";
import { getRequestPathParamsFromUrl, getRequestQueryParamsFromUrl, normalizeRequestUrlProtocol, type RequestDraft } from "./model/request";
import {
  type AuthContext,
  type RequestAuth,
} from "./model/request-auth";
import { SessionCookieJar } from "./model/cookie-jar";
import { useAuthRuntime } from "./hooks/use-auth-runtime";
import type { StoredHttpResponse } from "../../domain/http";
import type { HttpTransportProgress } from "../../application/ports/http";
import { snapshotSchemaRequest, withSchemaAuthContext, applyWorkspaceRequestConfig, getWorkspaceAuth, getWorkspaceAuthProfiles, type RequestKind, type WorkspaceRequestConfig } from "./model/request-workspace-config";
import { RequestCodeDialog } from "./components/request-code-dialog";
import { DynamicVariableResolutionError, resolveDynamicVariables, type DynamicVariableRequest, type DynamicExecutionStep } from "../workspaces/services/dynamic-variable-resolver";
import { cloneRequestDraft, type DynamicVariableCacheEntry, type Variable } from "../workspaces/model/workspace";
import { useApplicationServices } from "../../app/application-services-context";

function ResponseArea({
  workspaceId,
  documentId,
  response,
  error,
  sending,
  elapsed,
  graphql,
  onCreateVariable,
  onCancel,
  progress,
  onOpenHistory,
  historyEntryId,
  historyStartedAt,
  onReturnCurrent, dependencySteps, dependencyFailure, resolvingDependencies, onOpenDependency, onOpenVariable, documentName, dynamicExecution,
}: {
  dependencyFailure?: boolean;
  resolvingDependencies?: boolean;
  dependencySteps?: DynamicExecutionStep[];
  onOpenDependency?: (id: string) => void;
  onOpenVariable?: (id: string) => void;
  documentName?: string;
  dynamicExecution?: DynamicExecutionMetadata;
  historyEntryId?: string;
  historyStartedAt?: number;
  onReturnCurrent?: () => void;
  onOpenHistory?: (id: string) => void;
  workspaceId: string;
  documentId: string;
  response: StoredHttpResponse | null;
  error: string;
  sending: boolean;
  elapsed: number;
  graphql: boolean;
  onCreateVariable?: (candidate: ResponseVariableCandidate) => void;
  onCancel: () => void;
  progress: HttpTransportProgress | null;
}) {
  useEffect(() => {
    if (!sending || !resolvingDependencies || !dependencySteps?.length) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onCancel(); } };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [sending, resolvingDependencies, dependencySteps?.length, onCancel]);
  if (dependencySteps?.length && (dependencyFailure || sending && resolvingDependencies)) return <section aria-label="Dynamic request execution" className="flex h-full min-h-0 flex-col overflow-auto rounded-ui-xl bg-purr-surface p-ui-3">
    <div className="mb-ui-2 flex items-center justify-between"><span className="text-ui-sm text-content-secondary">{sending ? "Resolving dynamic variables…" : "Could not resolve dynamic variables"}</span>{sending ? <button type="button" className="ui-focus-ring rounded-ui-md px-ui-2 text-ui-sm text-content-secondary" onClick={onCancel}>Cancel</button> : null}</div>
    <DynamicDependencyChain steps={dependencySteps} rootName={documentName} failed={Boolean(error)} onOpenHistory={onOpenDependency} onOpenVariable={onOpenVariable} />
  </section>;
  if (sending) return <PendingResponse graphql={graphql} onCancel={onCancel} progress={progress} elapsed={elapsed} />;
  if (error) return <ErrorResponse message={error} headerAction={<div className="flex items-center gap-ui-2">{dynamicExecution ? <DynamicExecutionBadge dynamicExecution={dynamicExecution} /> : null}{onOpenHistory ? <HistoryPopover workspaceId={workspaceId} documentId={documentId} selectedId={historyEntryId} historicalStartedAt={historyStartedAt} onReturnCurrent={onReturnCurrent} onOpen={onOpenHistory} /> : null}</div>} />;
  if (response) return <ResponseViewer dynamicExecution={dynamicExecution} response={response} graphql={graphql} onCreateVariable={onCreateVariable} workspaceId={workspaceId} documentId={documentId} onOpenHistory={onOpenHistory} historyEntryId={historyEntryId} historyStartedAt={historyStartedAt} onReturnCurrent={onReturnCurrent} />;
  return <div className="relative h-full min-h-0">
    {onOpenHistory ? <div className="absolute right-ui-2 top-ui-2 z-10"><HistoryPopover workspaceId={workspaceId} documentId={documentId} onOpen={onOpenHistory} /></div> : null}
    <EmptyResponse />
  </div>;
}

export type RequestSession = {
  /** Monotonic start shared by request/response UI; local to the current app session. */
  executionStartedAt?: number;
  cancelExecution?: () => void;
  dependencyFailure?: boolean;
  resolvingDependencies?: boolean;
  dependencySteps?: DynamicExecutionStep[];
  response: StoredHttpResponse | null;
  error: string;
  sending: boolean;
  canvasFocus: "request" | "response";
};
export const emptyRequestSession: RequestSession = { response: null, error: "", sending: false, canvasFocus: "request" };
export type RequestActions = { send: (operationName?: string) => void; focusUrl: () => void };
export type DynamicSourceRequestDocument = {
  id: string;
  name: string;
  kind: RequestKind;
  request: RequestDraft;
};

export function RequestWorkbench({ dynamicExecution, onOpenDependency, historyEntryId, historyStartedAt, onReturnCurrent, onReplay, onOpenHistory, onHistoryError, draft, setDraft, requestKind, workspaceConfig, workspaceName, workspaceId, documentId, documentName, sourceDocuments, onCreateVariable, onOpenVariable, onCreateMissingVariable, onWorkspaceAuthChange, onImportCurl, view, splitRatios, onSplitRatioChange, requestSection, onRequestSectionChange, variables, runtimeVariables, environmentId, variablesForEnvironment, dynamicVariableCache, dynamicVariableSessionCache, onDynamicVariableCacheChange, cookieJar, session, onSessionChange, actionsRef, schemaSelector, schema, onOpenSchema, onOpenGraphqlType }: {
  dynamicExecution?: DynamicExecutionMetadata;
  onOpenDependency?: (id: string) => void;
  onReplay?: (operationName?: string) => void;
  historyEntryId?: string;
  historyStartedAt?: number;
  onReturnCurrent?: () => void;
  onOpenHistory?: (id: string) => void;
  onHistoryError?: (message: string) => void;
  workspaceId: string;
  schemaSelector?: import("react").ReactNode;
  schema?: GraphQLSchema;
  onOpenSchema?: () => void;
  onOpenGraphqlType?: (name: string) => void;
  draft: RequestDraft;
  setDraft: Dispatch<SetStateAction<RequestDraft>>;
  requestKind: RequestKind;
  workspaceConfig: WorkspaceRequestConfig;
  workspaceName: string;
  documentId: string;
  documentName: string;
  sourceDocuments: readonly DynamicSourceRequestDocument[];
  onCreateVariable: (candidate: ResponseVariableCandidate) => void;
  onOpenVariable: (id: string) => void;
  onCreateMissingVariable: (name: string, kind: "static" | "dynamic-request", sensitive?: boolean) => void;
  onWorkspaceAuthChange: (profileId: string, auth: RequestAuth) => void;
  onImportCurl: (command: string) => void;
  view: WorkbenchView;
  splitRatios: { horizontal: number; vertical: number };
  onSplitRatioChange: (orientation: "horizontal" | "vertical", ratio: number) => void;
  requestSection: RequestEditorSection;
  onRequestSectionChange: (section: RequestEditorSection) => void;
  variables: Record<string, string>;
  runtimeVariables: readonly Variable[];
  environmentId: string | null;
  variablesForEnvironment: (environmentId: string | null) => Promise<readonly Variable[]>;
  dynamicVariableCache: Record<string, DynamicVariableCacheEntry>;
  dynamicVariableSessionCache: Map<string, DynamicVariableCacheEntry>;
  onDynamicVariableCacheChange: (cache: Record<string, DynamicVariableCacheEntry>) => void;
  cookieJar: SessionCookieJar;
  session: RequestSession;
  onSessionChange: (patch: Partial<RequestSession>) => void;
  actionsRef: Ref<RequestActions>;
}) {
  const { httpTransport, responseContent, requestBodies, persistence } = useApplicationServices();
  const workspaceAuthEntries = useMemo(() => getWorkspaceAuthProfiles(workspaceConfig, requestKind), [requestKind, workspaceConfig]);
  const workspaceProfiles = useMemo(() => workspaceAuthEntries.map((entry) => ({ id: entry.id, name: entry.name || workspaceName, auth: entry.value })), [workspaceAuthEntries, workspaceName]);
  const workspaceAuthEntry = useMemo(() => getWorkspaceAuth(workspaceConfig, requestKind,
    draft.auth.type === "inherit" ? draft.auth.inherit.profileId : undefined), [draft.auth, requestKind, workspaceConfig]);
  const workspaceAuth = useMemo(() => draft.workspace.authEnabled && workspaceAuthEntry
    ? { id: workspaceAuthEntry.id, name: workspaceAuthEntry.name || workspaceName, auth: workspaceAuthEntry.value } : undefined,
  [draft.workspace.authEnabled, workspaceAuthEntry, workspaceName]);
  const sensitiveVariableNames = useMemo(() => runtimeVariables.filter((variable) => variable.sensitive).map((variable) => variable.name), [runtimeVariables]);
  const [authContext, setAuthContext] = useState<AuthContext>(withSchemaAuthContext(draft, workspaceConfig, { variables, sensitiveVariableNames, workspace: workspaceAuth, workspaceProfiles, requestDocumentId: documentId }));
  useEffect(() => setAuthContext((previous) => withSchemaAuthContext(draft, workspaceConfig, { ...previous, variables, sensitiveVariableNames, workspace: workspaceAuth, workspaceProfiles, requestDocumentId: documentId })), [variables, sensitiveVariableNames, workspaceAuth, workspaceProfiles, documentId, draft.graphql?.schemaId, workspaceConfig]);
  const [codeOpen, setCodeOpen] = useState(false);
  const [urlInvalid, setUrlInvalid] = useState(false);
  const effectiveDraft = useMemo(() => applyWorkspaceRequestConfig(draft, requestKind, workspaceConfig), [draft, requestKind, workspaceConfig]);
  const { sending, response, error, canvasFocus } = session;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!sending) { setElapsed(0); return; }
    const started = session.executionStartedAt ?? performance.now();
    const tick = () => setElapsed(Math.max(0, performance.now() - started));
    tick();
    const timer = window.setInterval(tick, 50);
    return () => window.clearInterval(timer);
  }, [sending, session.executionStartedAt]);
  const setResponse = (response: StoredHttpResponse | null) => onSessionChange({ response });
  const setError = (error: string) => onSessionChange({ error });
  const setCanvasFocus = (canvasFocus: RequestSession["canvasFocus"]) => onSessionChange({ canvasFocus });
  const sendingRef = useRef(false);
  const executionRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const cancelHistoryRef = useRef<(() => void) | null>(null);
  const [progress, setProgress] = useState<HttpTransportProgress | null>(null);
  useEffect(() => setUrlInvalid(false), [documentId, draft.url]);
  const authRuntime = useAuthRuntime(
    draft,
    setDraft,
    authContext,
    setAuthContext,
    onWorkspaceAuthChange,
  );

  const contextFor = useCallback((request: RequestDraft, kind: RequestKind, id: string, resolvedVariables = variables, sensitiveNames = sensitiveVariableNames): AuthContext => withSchemaAuthContext(request, workspaceConfig, {
    ...authContext,
    variables: resolvedVariables,
    sensitiveVariableNames: sensitiveNames,
    requestDocumentId: id,
    workspaceProfiles: getWorkspaceAuthProfiles(workspaceConfig, kind).map((entry) => ({ id: entry.id, name: entry.name || workspaceName, auth: entry.value })),
    workspace: (() => {
      const entry = getWorkspaceAuth(workspaceConfig, kind, request.auth.type === "inherit" ? request.auth.inherit.profileId : undefined);
      return request.workspace.authEnabled && entry
        ? { id: entry.id, name: entry.name || workspaceName, auth: entry.value }
        : undefined;
    })(),
  }), [authContext, variables, sensitiveVariableNames, workspaceConfig, workspaceName]);
  const dynamicCodeContext = useMemo<DynamicRequestCodeContext>(() => ({
    rootId: documentId, environmentId, documents: sourceDocuments, variablesForEnvironment, workspaceConfig,
    contextForDocument: async (document, sourceEnvironmentId) => {
      const scoped = await variablesForEnvironment(sourceEnvironmentId);
      return contextFor(document.request, document.kind, document.id, Object.fromEntries(scoped.filter((item) => item.kind === "static" && item.enabled).map((item) => [item.name, item.kind === "static" ? item.value : ""])), scoped.filter((item) => item.sensitive).map((item) => item.name));
    },
  }), [documentId, environmentId, sourceDocuments, variablesForEnvironment, workspaceConfig, contextFor]);
  const resolveFor = async (
    root: DynamicVariableRequest,
    rootEnvironmentId: string | null,
    execution?: { signal: AbortSignal; onProgress: (value: HttpTransportProgress) => void },
  ) => resolveDynamicVariables({
    root,
    workspaceConfig,
    signal: execution?.signal,
    onSteps: (steps) => { if (!execution?.signal.aborted) onSessionChange({ dependencySteps: steps }); },
    onExecuted: async (record) => persistence.history?.append(workspaceId, { ...record, documentId: record.document.id, name: record.document.name, kind: record.document.kind, editor: snapshotSchemaRequest(record.document.request, workspaceConfig, contextFor(record.document.request, record.document.kind, record.document.id)) }),
    onHistoryError: () => onHistoryError?.("Could not save dependency history."),
    environmentId: rootEnvironmentId,
    documents: sourceDocuments,
    variablesForEnvironment,
    persistentCache: dynamicVariableCache,
    sessionCache: dynamicVariableSessionCache,
    responseContent,
    execute: async (document, resolvedVariables, sourceEnvironmentId, dispatch) => {
      const scoped = await variablesForEnvironment(sourceEnvironmentId);
      const sensitive = scoped.filter((variable) => variable.sensitive).map((variable) => variable.name);
      const sourceContext = contextFor(document.request, document.kind, document.id, resolvedVariables, sensitive);
      const outgoing = applyWorkspaceRequestConfig(document.request, document.kind, workspaceConfig);
      return executeRequest(outgoing, sourceContext, cookieJar, createDependencyAuthRuntime(outgoing, sourceContext, httpTransport, responseContent, execution?.signal), httpTransport, responseContent, { ...execution, onDispatch: dispatch.onDispatch }, requestBodies);
    },
  });
  const send = async (graphqlOperationName?: string) => {
    if (sendingRef.current || sending) return;
    if (!effectiveDraft.url.trim()) {
      setCanvasFocus("request");
      setUrlInvalid(true);
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[aria-label="Request URL"]')?.focus());
      return;
    }
    if (onReplay) { onReplay(graphqlOperationName); return; }
    const normalizedUrl = normalizeRequestUrlProtocol(effectiveDraft.url);
    if (normalizedUrl !== draft.url) {
      setDraft((current) => current.url === draft.url
        ? {
            ...current,
            url: normalizedUrl,
            params: getRequestQueryParamsFromUrl(normalizedUrl, current.params),
            pathParams: getRequestPathParamsFromUrl(normalizedUrl, current.pathParams),
          }
        : current);
    }
    setUrlInvalid(false);
    setCanvasFocus("response");
    const execution = ++executionRef.current;
    const abort = new AbortController();
    abortRef.current = abort;
    sendingRef.current = true;
    onSessionChange({ sending: true, executionStartedAt: performance.now() });
    setProgress(null);
    onSessionChange({ dependencySteps: [], dependencyFailure: false, resolvingDependencies: true });
    setError("");
    const startedAt = Date.now();
    const editor = cloneRequestDraft(snapshotSchemaRequest(draft, workspaceConfig, authContext));
    if (graphqlOperationName && editor.graphql) editor.graphql.operationName = graphqlOperationName;
    const releaseAttachments = persistence.history?.retainAttachments(workspaceId);
    let dispatched = false;
    let recorded = false;
    const record = (outcome: "response" | "error" | "cancelled", response: StoredHttpResponse | null, error = "") => {
      if (recorded || !dispatched) return;
      recorded = true;
      const pending = persistence.history?.append(workspaceId, { documentId, name: documentName, kind: requestKind,
        editor, response, error, outcome, startedAt, durationMs: Date.now() - startedAt });
      if (pending) void pending.catch(() => onHistoryError?.("Could not save request history. The response is still available in this tab."))
        .finally(() => releaseAttachments?.());
      else releaseAttachments?.();
    };
    cancelHistoryRef.current = () => record("cancelled", null, "Request canceled.");
    onSessionChange({ cancelExecution: cancelSend });
    try {
      const normalizedDraft: RequestDraft = {
        ...effectiveDraft,
        url: normalizedUrl,
        params: getRequestQueryParamsFromUrl(normalizedUrl, effectiveDraft.params),
        pathParams: getRequestPathParamsFromUrl(normalizedUrl, effectiveDraft.pathParams),
      };
      const outgoing = graphqlOperationName && normalizedDraft.graphql
        ? { ...normalizedDraft, graphql: { ...normalizedDraft.graphql, operationName: graphqlOperationName } }
        : normalizedDraft;
      const reportProgress = (value: HttpTransportProgress) => {
        if (execution === executionRef.current) setProgress(value);
      };
      const dynamic = await resolveFor(
        { id: documentId, name: documentName, kind: requestKind, request: outgoing },
        environmentId,
        { signal: abort.signal, onProgress: reportProgress },
      );
      if (execution !== executionRef.current) return;
      onSessionChange({ resolvingDependencies: false });
      onDynamicVariableCacheChange(dynamic.cache);
      setAuthContext((current) => ({ ...current, variables: dynamic.values, sensitiveVariableNames: [...dynamic.sensitiveNames] }));
      const outgoingContext = contextFor(outgoing, requestKind, documentId, dynamic.values, [...dynamic.sensitiveNames]);
      const result = await executeRequest(outgoing, outgoingContext, cookieJar, authRuntime, httpTransport, responseContent, { signal: abort.signal, onProgress: reportProgress, onDispatch: () => { dispatched = true; } }, requestBodies);
      if (execution !== executionRef.current) return;
      setResponse(result);
      record("response", result);
    } catch (cause) {
      if (execution !== executionRef.current) return;
      if (cause instanceof DynamicVariableResolutionError) { onDynamicVariableCacheChange(cause.cache); onSessionChange({ dependencyFailure: true, resolvingDependencies: false }); }
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      record(abort.signal.aborted ? "cancelled" : "error", null, message);
    } finally {
      if (!recorded) releaseAttachments?.();
      if (execution !== executionRef.current) return;
      cancelHistoryRef.current = null;
      sendingRef.current = false;
      abortRef.current = null;
      setProgress(null);
      onSessionChange({ sending: false, executionStartedAt: undefined, cancelExecution: undefined });
    }
  };
  const cancelSend = () => {
    if (!sendingRef.current && session.cancelExecution) { session.cancelExecution(); return; }
    if (!sendingRef.current && !sending) return;
    cancelHistoryRef.current?.();
    cancelHistoryRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    authRuntime.cancel();
    executionRef.current += 1;
    sendingRef.current = false;
    onSessionChange({ sending: false, executionStartedAt: undefined, cancelExecution: undefined, resolvingDependencies: false });
    setProgress(null);
    if (!response) setCanvasFocus("request");
  };

  useImperativeHandle(actionsRef, () => ({
    send: (operationName) => { void send(operationName); },
    focusUrl: () => {
      document.querySelector<HTMLInputElement>('[aria-label="Request URL"]')?.focus();
    },
  }));

  const hasActivity = Boolean(response || error || sending);
  const canvasCollapsed = view === "canvas" && canvasFocus === "response";
  const canvasPreview = view === "canvas" && hasActivity && !canvasCollapsed;
  const canvasCompose = view === "canvas" && !hasActivity && !canvasCollapsed;
  const requestPane = (
    <RequestComposer
      schema={schema}
      onOpenSchema={onOpenSchema}
      onOpenGraphqlType={onOpenGraphqlType}
      onRunGraphqlOperation={(name) => { void send(name); }}
      draft={draft}
      requestKind={requestKind}
      workspaceConfig={workspaceConfig}
      variableDefinitions={runtimeVariables}
      onOpenVariable={onOpenVariable}
      onCreateMissingVariable={onCreateMissingVariable}
      onImportCurl={onImportCurl}
      onDraftChange={setDraft}
      onSend={() => {
        void send();
      }}
      sending={sending}
      schemaSelector={schemaSelector}
      elapsed={elapsed}
      authContext={authContext}
      authRuntime={authRuntime}
      activeSection={requestSection}
      onSectionChange={onRequestSectionChange}
      onOpenCode={() => setCodeOpen(true)}
      historyAction={canvasCompose && onOpenHistory ? <HistoryPopover workspaceId={workspaceId} documentId={documentId} onOpen={onOpenHistory} /> : undefined}
      historical={Boolean(historyEntryId)}
      historyStartedAt={historyStartedAt}
      urlInvalid={urlInvalid}
      detailsCollapsed={canvasCollapsed}
      onToggleDetails={
        view === "canvas"
          ? () => setCanvasFocus(canvasCollapsed ? "request" : "response")
          : undefined
      }
    />
  );
  const responsePane = (
    <ResponseArea dynamicExecution={dynamicExecution} dependencySteps={session.dependencySteps} dependencyFailure={session.dependencyFailure} resolvingDependencies={session.resolvingDependencies} onOpenDependency={onOpenDependency} onOpenVariable={onOpenVariable} documentName={documentName} response={response} error={error} sending={sending} elapsed={elapsed} graphql={Boolean(draft.graphql)} onCreateVariable={onCreateVariable} onCancel={cancelSend} progress={progress} workspaceId={workspaceId} documentId={documentId} onOpenHistory={onOpenHistory} historyEntryId={historyEntryId} historyStartedAt={historyStartedAt} onReturnCurrent={onReturnCurrent} />
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-purr-base">
      <main className="flex min-h-0 w-full flex-1 flex-col px-ui-2 pb-ui-2">
        <div
          className="min-h-0 flex-1"
          data-workbench-view={view}
        >
          <SplitPane
            orientation={view === "canvas" ? "horizontal" : view}
            first={requestPane}
            second={responsePane}
            firstLabel="Request editor"
            secondLabel="Response viewer"
            firstSize={
              canvasCompose ? "100%"
                : canvasCollapsed ? "var(--request-collapsed-height)"
                  : canvasPreview ? "calc((100% - var(--splitter-gutter)) * var(--request-focus-expanded-ratio))"
                    : undefined
            }
            hideSecond={canvasCompose}
            dimSecond={canvasPreview}
            onFocusSecond={() => setCanvasFocus("response")}
            animated={view === "canvas"}
            ratio={splitRatios[view === "vertical" ? "vertical" : "horizontal"]}
            onRatioChange={(ratio) => onSplitRatioChange(view === "vertical" ? "vertical" : "horizontal", ratio)}
          />
        </div>
      </main>
      {codeOpen ? <RequestCodeDialog draft={effectiveDraft} context={authContext} cookieJar={cookieJar} dynamicContext={dynamicCodeContext} onClose={() => setCodeOpen(false)} /> : null}
    </div>
  );
}
