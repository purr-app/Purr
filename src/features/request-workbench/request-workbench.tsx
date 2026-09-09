import { useEffect, useImperativeHandle, useRef, useState, type Dispatch, type Ref, type SetStateAction } from "react";

import { SplitPane } from "../../shared/components/ui/split-pane";
import { EmptyResponse } from "./components/empty-response";
import { RequestComposer } from "./components/request-composer";
import { type WorkbenchView } from "./components/request-tab-bar";
import { resolveRequestEnvironment } from "../workspaces/model/environment";
import type { RequestEditorSection } from "./model/request-editor-section";
import { ResponseViewer } from "./components/response-viewer";
import {
  applyRequestQueryParamsToUrl,
  getRequestHeaders,
  getRequestQueryParams,
  type RequestDraft,
} from "./model/request";
import {
  getRequestBodyValidationMessage,
  serializeRequestBody,
} from "./model/request-body";
import {
  captureBearerResponseToken,
  getAuthBindingForRequest,
  resolveAuth,
  type AuthContext,
} from "./model/request-auth";
import { SessionCookieJar } from "./model/cookie-jar";
import { useAuthRuntime } from "./hooks/use-auth-runtime";
import {
  encodeBody,
  executeHttp,
  type HttpResult,
} from "./services/http-client";

function ResponseArea({
  response,
  error,
  sending,
}: {
  response: HttpResult | null;
  error: string;
  sending: boolean;
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
          <ResponseViewer response={response} />
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

export function RequestWorkbench({ draft, setDraft, view, splitRatios, onSplitRatioChange, requestSection, onRequestSectionChange, variables, cookieJar, session, onSessionChange, actionsRef }: {
  draft: RequestDraft;
  setDraft: Dispatch<SetStateAction<RequestDraft>>;
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
  const [authContext, setAuthContext] = useState<AuthContext>({ variables });
  useEffect(() => setAuthContext((previous) => ({ ...previous, variables })), [variables]);
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

  const send = async () => {
    if (sendingRef.current || sending) return;
    setCanvasFocus("response");
    sendingRef.current = true;
    setSending(true);
    setError("");
    try {
      const resolvedDraft = resolveRequestEnvironment(draft, variables);
      const bodyError = getRequestBodyValidationMessage(resolvedDraft.body);
      if (bodyError) throw new Error(bodyError);
      let effective = resolveAuth(draft.auth, authContext);
      if (effective.error) throw new Error(effective.error);
      if (effective.auth.type === "oauth2") {
        const config = effective.auth.oauth2;
        let token = config.token;
        if (
          !token ||
          (config.autoRefresh &&
            token.expiresAt !== undefined &&
            token.expiresAt <= Date.now())
        ) {
          if (!token && config.grantType === "authorization_code")
            throw new Error("Open Auth and authorize in your browser first.");
          token = await authRuntime.run(token ? "refresh" : "initial");
          if (!token)
            throw new Error(
              "Could not obtain an access token. See Auth for details.",
            );
        }
        if (token.expiresAt !== undefined && token.expiresAt <= Date.now())
          throw new Error(
            "Access token expired. Refresh it in Auth before sending.",
          );
        effective = {
          ...effective,
          auth: { ...effective.auth, oauth2: { ...config, token } },
        };
      }
      const outgoing = { ...resolvedDraft, auth: effective.auth };
      const authResult = getAuthBindingForRequest(
        outgoing.auth,
        outgoing.url,
        authContext,
      );
      if (authResult.error) throw new Error(authResult.error);
      const headers = getRequestHeaders(outgoing, authContext)
        .filter((header) => header.enabled && header.name.trim())
        .map((header) => [header.name, header.value] as [string, string]);
      const result = await executeHttp(
        {
          url: applyRequestQueryParamsToUrl(
            outgoing.url,
            getRequestQueryParams(outgoing, authContext),
          ),
          method: draft.method,
          headers,
          bodyBase64: await encodeBody(serializeRequestBody(outgoing.body)),
        },
        {
          jar: draft.useCookieJar ? cookieJar : undefined,
          sensitiveHeaders:
            authResult.binding?.target === "header"
              ? [authResult.binding.name]
              : [],
          sensitiveQueryParams:
            authResult.binding?.target === "query"
              ? [authResult.binding.name]
              : [],
        },
      );
      setResponse(result);
      let body: unknown = result.text;
      try {
        body = JSON.parse(result.text);
      } catch {
        /* Plain text can be read using an empty JSON Pointer. */
      }
      setDraft((previous) => ({
        ...previous,
        auth: captureBearerResponseToken(previous.auth, result.url, body),
      }));
      setAuthContext((previous) => {
        return {
          ...previous,
          workspace: previous.workspace
            ? {
                ...previous.workspace,
                auth: captureBearerResponseToken(
                  previous.workspace.auth,
                  result.url,
                  body,
                ),
              }
            : undefined,
          environment: previous.environment
            ? {
                ...previous.environment,
                auth: captureBearerResponseToken(
                  previous.environment.auth,
                  result.url,
                  body,
                ),
              }
            : undefined,
        };
      });
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
      draft={draft}
      onDraftChange={setDraft}
      onSend={() => {
        void send();
      }}
      sending={sending}
      authContext={authContext}
      authRuntime={authRuntime}
      activeSection={requestSection}
      onSectionChange={onRequestSectionChange}
      detailsCollapsed={canvasCollapsed}
      onToggleDetails={
        view === "canvas"
          ? () => setCanvasFocus(canvasCollapsed ? "request" : "response")
          : undefined
      }
    />
  );
  const responsePane = (
    <ResponseArea response={response} error={error} sending={sending} />
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
                  : canvasPreview ? "calc((100% - var(--splitter-gutter)) * 0.5)"
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
    </div>
  );
}
