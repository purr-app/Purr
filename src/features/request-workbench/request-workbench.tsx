import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Dispatch, type Ref, type SetStateAction } from "react";

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
import type { InlineHttpResponse } from "../../domain/http";
import { applyWorkspaceRequestConfig, getWorkspaceAuth, getWorkspaceAuthProfiles, type RequestKind, type WorkspaceRequestConfig } from "./model/request-workspace-config";
import { RequestCodeDialog } from "./components/request-code-dialog";
import { DynamicVariableResolutionError, resolveDynamicVariables, type DynamicVariableRequest } from "../workspaces/services/dynamic-variable-resolver";
import type { DynamicVariableCacheEntry, Variable } from "../workspaces/model/workspace";

function ResponseArea({
  response,
  error,
  sending,
  graphql,
  onCreateVariable,
  onCancel,
}: {
  response: InlineHttpResponse | null;
  error: string;
  sending: boolean;
  graphql: boolean;
  onCreateVariable?: (candidate: ResponseVariableCandidate) => void;
  onCancel: () => void;
}) {
  if (sending) return <PendingResponse graphql={graphql} onCancel={onCancel} />;
  if (error) return <ErrorResponse message={error} />;
  if (response) return <ResponseViewer response={response} graphql={graphql} onCreateVariable={onCreateVariable} />;
  return <EmptyResponse />;
}

export type RequestSession = {
  response: InlineHttpResponse | null;
  error: string;
  sending: boolean;
  canvasFocus: "request" | "response";
};
export const emptyRequestSession: RequestSession = { response: null, error: "", sending: false, canvasFocus: "request" };
export type RequestActions = { send: () => void; focusUrl: () => void };
export type DynamicSourceRequestDocument = {
  id: string;
  name: string;
  kind: RequestKind;
  request: RequestDraft;
};

export function RequestWorkbench({ draft, setDraft, requestKind, workspaceConfig, workspaceName, documentId, documentName, sourceDocuments, onCreateVariable, onOpenVariable, onCreateMissingVariable, onWorkspaceAuthChange, onImportCurl, view, splitRatios, onSplitRatioChange, requestSection, onRequestSectionChange, variables, runtimeVariables, environmentId, variablesForEnvironment, dynamicVariableCache, dynamicVariableSessionCache, onDynamicVariableCacheChange, cookieJar, session, onSessionChange, actionsRef, schema, onOpenSchema, onOpenGraphqlType }: {
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
  const workspaceAuthEntries = useMemo(() => getWorkspaceAuthProfiles(workspaceConfig, requestKind), [requestKind, workspaceConfig]);
  const workspaceProfiles = useMemo(() => workspaceAuthEntries.map((entry) => ({ id: entry.id, name: entry.name || workspaceName, auth: entry.value })), [workspaceAuthEntries, workspaceName]);
  const workspaceAuthEntry = useMemo(() => getWorkspaceAuth(workspaceConfig, requestKind,
    draft.auth.type === "inherit" ? draft.auth.inherit.profileId : undefined), [draft.auth, requestKind, workspaceConfig]);
  const workspaceAuth = useMemo(() => draft.workspace.authEnabled && workspaceAuthEntry
    ? { id: workspaceAuthEntry.id, name: workspaceAuthEntry.name || workspaceName, auth: workspaceAuthEntry.value } : undefined,
  [draft.workspace.authEnabled, workspaceAuthEntry, workspaceName]);
  const sensitiveVariableNames = useMemo(() => runtimeVariables.filter((variable) => variable.sensitive).map((variable) => variable.name), [runtimeVariables]);
  const [authContext, setAuthContext] = useState<AuthContext>({ variables, sensitiveVariableNames, workspace: workspaceAuth, workspaceProfiles, requestDocumentId: documentId });
  useEffect(() => setAuthContext((previous) => ({ ...previous, variables, sensitiveVariableNames, workspace: workspaceAuth, workspaceProfiles, requestDocumentId: documentId })), [variables, sensitiveVariableNames, workspaceAuth, workspaceProfiles, documentId]);
  const [codeOpen, setCodeOpen] = useState(false);
  const [urlInvalid, setUrlInvalid] = useState(false);
  const effectiveDraft = useMemo(() => applyWorkspaceRequestConfig(draft, requestKind, workspaceConfig), [draft, requestKind, workspaceConfig]);
  const { sending, response, error, canvasFocus } = session;
  const setSending = (sending: boolean) => onSessionChange({ sending });
  const setResponse = (response: InlineHttpResponse | null) => onSessionChange({ response });
  const setError = (error: string) => onSessionChange({ error });
  const setCanvasFocus = (canvasFocus: RequestSession["canvasFocus"]) => onSessionChange({ canvasFocus });
  const sendingRef = useRef(false);
  const executionRef = useRef(0);
  useEffect(() => setUrlInvalid(false), [documentId, draft.url]);
  const authRuntime = useAuthRuntime(
    draft,
    setDraft,
    authContext,
    setAuthContext,
    onWorkspaceAuthChange,
  );

  const contextFor = (request: RequestDraft, kind: RequestKind, id: string, resolvedVariables = variables, sensitiveNames = sensitiveVariableNames): AuthContext => ({
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
  });
  const resolveFor = async (root: DynamicVariableRequest, rootEnvironmentId: string | null) => resolveDynamicVariables({
    root,
    environmentId: rootEnvironmentId,
    documents: sourceDocuments,
    variablesForEnvironment,
    persistentCache: dynamicVariableCache,
    sessionCache: dynamicVariableSessionCache,
    execute: async (document, resolvedVariables, sourceEnvironmentId) => {
      const scoped = await variablesForEnvironment(sourceEnvironmentId);
      const sensitive = scoped.filter((variable) => variable.sensitive).map((variable) => variable.name);
      return executeRequest(applyWorkspaceRequestConfig(document.request, document.kind, workspaceConfig), contextFor(document.request, document.kind, document.id, resolvedVariables, sensitive), cookieJar, authRuntime);
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
    sendingRef.current = true;
    setSending(true);
    setError("");
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
      const dynamic = await resolveFor({ id: documentId, name: documentName, kind: requestKind, request: outgoing }, environmentId);
      if (execution !== executionRef.current) return;
      onDynamicVariableCacheChange(dynamic.cache);
      setAuthContext((current) => ({ ...current, variables: dynamic.values, sensitiveVariableNames: [...dynamic.sensitiveNames] }));
      const outgoingContext = contextFor(outgoing, requestKind, documentId, dynamic.values, [...dynamic.sensitiveNames]);
      const result = await executeRequest(outgoing, outgoingContext, cookieJar, authRuntime);
      if (execution !== executionRef.current) return;
      setResponse(result);
    } catch (cause) {
      if (execution !== executionRef.current) return;
      if (cause instanceof DynamicVariableResolutionError) onDynamicVariableCacheChange(cause.cache);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (execution !== executionRef.current) return;
      sendingRef.current = false;
      setSending(false);
    }
  };
  const cancelSend = () => {
    if (!sendingRef.current && !sending) return;
    executionRef.current += 1;
    sendingRef.current = false;
    setSending(false);
    if (!response) setCanvasFocus("request");
  };

  useImperativeHandle(actionsRef, () => ({
    send: () => { void send(); },
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
      authContext={authContext}
      authRuntime={authRuntime}
      activeSection={requestSection}
      onSectionChange={onRequestSectionChange}
      onOpenCode={() => setCodeOpen(true)}
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
    <ResponseArea response={response} error={error} sending={sending} graphql={Boolean(draft.graphql)} onCreateVariable={onCreateVariable} onCancel={cancelSend} />
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-purr-base">
      <main className="flex min-h-0 w-full flex-1 flex-col p-ui-2">
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
      {codeOpen ? <RequestCodeDialog draft={effectiveDraft} context={authContext} cookieJar={cookieJar} onClose={() => setCodeOpen(false)} /> : null}
    </div>
  );
}
