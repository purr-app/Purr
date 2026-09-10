import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Dispatch, type Ref, type SetStateAction } from "react";

import { SplitPane } from "../../shared/components/ui/split-pane";
import { EmptyResponse } from "./components/empty-response";
import { RequestComposer } from "./components/request-composer";
import { type WorkbenchView } from "./components/request-tab-bar";
import type { GraphQLSchema } from "graphql";
import { executeRequest } from "./services/execute-request";
import type { RequestEditorSection } from "./model/request-editor-section";
import { ResponseViewer } from "./components/response-viewer";
import { type RequestDraft } from "./model/request";
import {
  captureBearerResponseToken,
  resolveAuth,
  type AuthSourceDocumentOption,
  type AuthContext,
  type RequestAuth,
} from "./model/request-auth";
import { SessionCookieJar } from "./model/cookie-jar";
import { useAuthRuntime } from "./hooks/use-auth-runtime";
import {
  type HttpResult,
} from "./services/http-client";
import { applyWorkspaceRequestConfig, getWorkspaceAuth, type RequestKind, type WorkspaceRequestConfig } from "./model/request-workspace-config";
import { RequestCodeDialog } from "./components/request-code-dialog";

function ResponseArea({
  response,
  error,
  sending,
  graphql,
}: {
  response: HttpResult | null;
  error: string;
  sending: boolean;
  graphql: boolean;
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
          <ResponseViewer response={response} graphql={graphql} />
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
export type AuthSourceRequestDocument = AuthSourceDocumentOption & {
  kind: RequestKind;
  request: RequestDraft;
};

export function RequestWorkbench({ draft, setDraft, requestKind, workspaceConfig, workspaceName, documentId, responseSourceDocuments, onWorkspaceAuthChange, view, splitRatios, onSplitRatioChange, requestSection, onRequestSectionChange, variables, cookieJar, session, onSessionChange, actionsRef, schema, onOpenSchema, onOpenGraphqlType }: {
  schema?: GraphQLSchema;
  onOpenSchema?: () => void;
  onOpenGraphqlType?: (name: string) => void;
  draft: RequestDraft;
  setDraft: Dispatch<SetStateAction<RequestDraft>>;
  requestKind: RequestKind;
  workspaceConfig: WorkspaceRequestConfig;
  workspaceName: string;
  documentId: string;
  responseSourceDocuments: readonly AuthSourceRequestDocument[];
  onWorkspaceAuthChange: (id: string, auth: RequestAuth) => void;
  view: WorkbenchView;
  splitRatios: { horizontal: number; vertical: number };
  onSplitRatioChange: (orientation: "horizontal" | "vertical", ratio: number) => void;
  requestSection: RequestEditorSection;
  onRequestSectionChange: (section: RequestEditorSection) => void;
  variables: Record<string, string>;
  cookieJar: SessionCookieJar;
  session: RequestSession;
  onSessionChange: (patch: Partial<RequestSession>) => void;
  actionsRef: Ref<RequestActions>;
}) {
  const workspaceAuthEntry = useMemo(() => getWorkspaceAuth(workspaceConfig, requestKind), [requestKind, workspaceConfig]);
  const workspaceAuth = useMemo(() => draft.workspace.authEnabled && workspaceAuthEntry
    ? { id: `workspace-auth-${workspaceAuthEntry.id}`, name: workspaceAuthEntry.name || workspaceName, auth: workspaceAuthEntry.value } : undefined,
  [draft.workspace.authEnabled, workspaceAuthEntry, workspaceName]);
  const [authContext, setAuthContext] = useState<AuthContext>({ variables, workspace: workspaceAuth, requestDocumentId: documentId });
  useEffect(() => setAuthContext((previous) => ({ ...previous, variables, workspace: workspaceAuth, requestDocumentId: documentId })), [variables, workspaceAuth, documentId]);
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

  const contextFor = (request: RequestDraft, kind: RequestKind, id: string): AuthContext => ({
    ...authContext,
    variables,
    requestDocumentId: id,
    workspace: (() => {
      const entry = getWorkspaceAuth(workspaceConfig, kind);
      return request.workspace.authEnabled && entry
        ? { id: `workspace-auth-${entry.id}`, name: entry.name || workspaceName, auth: entry.value }
        : undefined;
    })(),
  });
  const readResultBody = (result: HttpResult): unknown => {
    try { return JSON.parse(result.text); }
    catch { return result.text; }
  };
  const persistCapturedAuth = (
    previous: ReturnType<typeof resolveAuth>,
    next: RequestAuth,
  ) => {
    if (next === previous.auth) return;
    if (previous.source?.id.startsWith("workspace-auth-")) {
      onWorkspaceAuthChange(previous.source.id.slice("workspace-auth-".length), next);
      setAuthContext((context) => ({
        ...context,
        workspace: context.workspace ? { ...context.workspace, auth: next } : context.workspace,
      }));
    } else if (previous.source?.id) {
      setAuthContext((context) => ({
        ...context,
        environment: context.environment && context.environment.id === previous.source?.id
          ? { ...context.environment, auth: next }
          : context.environment,
      }));
    } else setDraft((request) => ({ ...request, auth: next }));
  };

  const send = async (graphqlOperationName?: string) => {
    if (sendingRef.current || sending) return;
    setCanvasFocus("response");
    sendingRef.current = true;
    setSending(true);
    setError("");
    try {
      let outgoing = graphqlOperationName && effectiveDraft.graphql
        ? { ...effectiveDraft, graphql: { ...effectiveDraft.graphql, operationName: graphqlOperationName } }
        : effectiveDraft;
      let outgoingContext = contextFor(draft, requestKind, documentId);
      let resolved = resolveAuth(outgoing.auth, outgoingContext);
      if (resolved.error) throw new Error(resolved.error);
      if (resolved.auth.type === "bearer" && resolved.auth.bearer.source === "response"
        && resolved.auth.bearer.endpointDocumentId && !resolved.auth.bearer.receivedToken) {
        const source = responseSourceDocuments.find((document) => document.id === resolved.auth.bearer.endpointDocumentId);
        if (!source) throw new Error("The selected token request is no longer available. Choose another saved request in Auth.");
        const sourceDraft = applyWorkspaceRequestConfig(source.request, source.kind, workspaceConfig);
        const sourceContext = contextFor(source.request, source.kind, source.id);
        const tokenResult = await executeRequest(sourceDraft, sourceContext, cookieJar, authRuntime);
        const captured = captureBearerResponseToken(resolved.auth, tokenResult.url, readResultBody(tokenResult), source.id);
        persistCapturedAuth(resolved, captured);
        if (captured.bearer.responseError) throw new Error(captured.bearer.responseError);
        if (source.id === documentId) {
          setResponse(tokenResult);
          return;
        }
        outgoing = { ...outgoing, auth: captured };
        if (resolved.source?.id.startsWith("workspace-auth-") && outgoingContext.workspace)
          outgoingContext = { ...outgoingContext, workspace: { ...outgoingContext.workspace, auth: captured } };
        resolved = { ...resolved, auth: captured };
      }
      const result = await executeRequest(outgoing, outgoingContext, cookieJar, authRuntime);
      setResponse(result);
      persistCapturedAuth(resolved, captureBearerResponseToken(
        resolved.auth,
        result.url,
        readResultBody(result),
        documentId,
      ));
    } catch (cause) {
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
      responseSourceDocuments={responseSourceDocuments}
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
    <ResponseArea response={response} error={error} sending={sending} graphql={Boolean(draft.graphql)} />
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
