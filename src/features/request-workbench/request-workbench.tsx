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
import { type RequestDraft } from "./model/request";
import {
  type AuthContext,
} from "./model/request-auth";
import { SessionCookieJar } from "./model/cookie-jar";
import { useAuthRuntime } from "./hooks/use-auth-runtime";
import {
  type HttpResult,
} from "./services/http-client";
import { applyWorkspaceRequestConfig, getWorkspaceAuth, type RequestKind, type WorkspaceRequestConfig } from "./model/request-workspace-config";
import { RequestCodeDialog } from "./components/request-code-dialog";
import { DynamicVariableResolutionError, resolveDynamicVariables, type DynamicVariableRequest } from "../workspaces/services/dynamic-variable-resolver";
import type { DynamicVariableCacheEntry, Variable } from "../workspaces/model/workspace";

function ResponseArea({
  response,
  error,
  sending,
  graphql,
  onCreateVariable,
}: {
  response: HttpResult | null;
  error: string;
  sending: boolean;
  graphql: boolean;
  onCreateVariable?: (candidate: ResponseVariableCandidate) => void;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-ui-2">
      {error ? (
        <p
          role="alert"
          className="m-ui-0 shrink-0 rounded-ui-lg bg-purr-elevated px-ui-4 py-ui-3 text-ui-md text-accent-red"
        >
          {error}
        </p>
      ) : null}
      <div className="min-h-0 min-w-0 flex-1">
        {response ? (
          <ResponseViewer response={response} graphql={graphql} onCreateVariable={onCreateVariable} />
        ) : (
          <EmptyResponse sending={sending} />
        )}
      </div>
    </div>
  );
}

export type RequestSession = {
  response: HttpResult | null;
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

export function RequestWorkbench({ draft, setDraft, requestKind, workspaceConfig, workspaceName, documentId, documentName, sourceDocuments, onCreateVariable, onOpenVariable, onCreateMissingVariable, view, splitRatios, onSplitRatioChange, requestSection, onRequestSectionChange, variables, runtimeVariables, environmentId, variablesForEnvironment, dynamicVariableCache, dynamicVariableSessionCache, onDynamicVariableCacheChange, cookieJar, session, onSessionChange, actionsRef, schema, onOpenSchema, onOpenGraphqlType }: {
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
  onCreateMissingVariable: (name: string, kind: "static" | "dynamic-request") => void;
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
  const workspaceAuthEntry = useMemo(() => getWorkspaceAuth(workspaceConfig, requestKind), [requestKind, workspaceConfig]);
  const workspaceAuth = useMemo(() => draft.workspace.authEnabled && workspaceAuthEntry
    ? { id: `workspace-auth-${workspaceAuthEntry.id}`, name: workspaceAuthEntry.name || workspaceName, auth: workspaceAuthEntry.value } : undefined,
  [draft.workspace.authEnabled, workspaceAuthEntry, workspaceName]);
  const sensitiveVariableNames = useMemo(() => runtimeVariables.filter((variable) => variable.sensitive).map((variable) => variable.name), [runtimeVariables]);
  const [authContext, setAuthContext] = useState<AuthContext>({ variables, sensitiveVariableNames, workspace: workspaceAuth, requestDocumentId: documentId });
  useEffect(() => setAuthContext((previous) => ({ ...previous, variables, sensitiveVariableNames, workspace: workspaceAuth, requestDocumentId: documentId })), [variables, sensitiveVariableNames, workspaceAuth, documentId]);
  const [codeOpen, setCodeOpen] = useState(false);
  const effectiveDraft = useMemo(() => applyWorkspaceRequestConfig(draft, requestKind, workspaceConfig), [draft, requestKind, workspaceConfig]);
  const { sending, response, error, canvasFocus } = session;
  const setSending = (sending: boolean) => onSessionChange({ sending });
  const setResponse = (response: HttpResult | null) => onSessionChange({ response });
  const setError = (error: string) => onSessionChange({ error });
  const setCanvasFocus = (canvasFocus: RequestSession["canvasFocus"]) => onSessionChange({ canvasFocus });
  const sendingRef = useRef(false);
  const authRuntime = useAuthRuntime(
    draft,
    setDraft,
    authContext,
    setAuthContext,
  );

  const contextFor = (request: RequestDraft, kind: RequestKind, id: string, resolvedVariables = variables, sensitiveNames = sensitiveVariableNames): AuthContext => ({
    ...authContext,
    variables: resolvedVariables,
    sensitiveVariableNames: sensitiveNames,
    requestDocumentId: id,
    workspace: (() => {
      const entry = getWorkspaceAuth(workspaceConfig, kind);
      return request.workspace.authEnabled && entry
        ? { id: `workspace-auth-${entry.id}`, name: entry.name || workspaceName, auth: entry.value }
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
    setCanvasFocus("response");
    sendingRef.current = true;
    setSending(true);
    setError("");
    try {
      const outgoing = graphqlOperationName && effectiveDraft.graphql
        ? { ...effectiveDraft, graphql: { ...effectiveDraft.graphql, operationName: graphqlOperationName } }
        : effectiveDraft;
      const dynamic = await resolveFor({ id: documentId, name: documentName, kind: requestKind, request: outgoing }, environmentId);
      onDynamicVariableCacheChange(dynamic.cache);
      setAuthContext((current) => ({ ...current, variables: dynamic.values, sensitiveVariableNames: [...dynamic.sensitiveNames] }));
      const outgoingContext = contextFor(draft, requestKind, documentId, dynamic.values, [...dynamic.sensitiveNames]);
      const result = await executeRequest(outgoing, outgoingContext, cookieJar, authRuntime);
      setResponse(result);
    } catch (cause) {
      if (cause instanceof DynamicVariableResolutionError) onDynamicVariableCacheChange(cause.cache);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
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
      detailsCollapsed={canvasCollapsed}
      onToggleDetails={
        view === "canvas"
          ? () => setCanvasFocus(canvasCollapsed ? "request" : "response")
          : undefined
      }
    />
  );
  const responsePane = (
    <ResponseArea response={response} error={error} sending={sending} graphql={Boolean(draft.graphql)} onCreateVariable={onCreateVariable} />
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
