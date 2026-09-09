import { useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import { SplitPane } from "../../shared/components/ui/split-pane";
import { keyboardShortcuts } from "../../shared/config/keyboard-shortcuts";
import { EmptyResponse } from "./components/empty-response";
import { RequestComposer } from "./components/request-composer";
import {
  RequestTabBar,
  type WorkbenchView,
} from "./components/request-tab-bar";
import { ResponseViewer } from "./components/response-viewer";
import {
  applyRequestQueryParamsToUrl,
  getRequestHeaders,
  getRequestQueryParams,
  initialRequestDraft,
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

export function RequestWorkbench() {
  const [draft, setDraft] = useState<RequestDraft>(initialRequestDraft);
  const [authContext, setAuthContext] = useState<AuthContext>({});
  const [cookieJar] = useState(() => new SessionCookieJar());
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [response, setResponse] = useState<HttpResult | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<WorkbenchView>("canvas");
  const [canvasFocus, setCanvasFocus] = useState<"request" | "response">(
    "request",
  );
  const authRuntime = useAuthRuntime(
    draft,
    setDraft,
    authContext,
    setAuthContext,
  );
  const selectView = (nextView: WorkbenchView) => {
    setView(nextView);
    if (nextView === "canvas")
      setCanvasFocus(response || error || sending ? "response" : "request");
  };
  useHotkeys(
    keyboardShortcuts.canvasView.hotkey,
    () => selectView("canvas"),
    { enableOnFormTags: true, enableOnContentEditable: true, preventDefault: true },
    [response, error, sending],
  );
  useHotkeys(
    keyboardShortcuts.horizontalSplitView.hotkey,
    () => selectView("horizontal"),
    { enableOnFormTags: true, enableOnContentEditable: true, preventDefault: true },
  );
  useHotkeys(
    keyboardShortcuts.verticalSplitView.hotkey,
    () => selectView("vertical"),
    { enableOnFormTags: true, enableOnContentEditable: true, preventDefault: true },
  );

  const send = async () => {
    if (sendingRef.current) return;
    setCanvasFocus("response");
    sendingRef.current = true;
    setSending(true);
    setError("");
    try {
      const bodyError = getRequestBodyValidationMessage(draft.body);
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
      const outgoing = { ...draft, auth: effective.auth };
      const authResult = getAuthBindingForRequest(
        outgoing.auth,
        draft.url,
        authContext,
      );
      if (authResult.error) throw new Error(authResult.error);
      const headers = getRequestHeaders(outgoing, authContext)
        .filter((header) => header.enabled && header.name.trim())
        .map((header) => [header.name, header.value] as [string, string]);
      const result = await executeHttp(
        {
          url: applyRequestQueryParamsToUrl(
            draft.url,
            getRequestQueryParams(outgoing, authContext),
          ),
          method: draft.method,
          headers,
          bodyBase64: await encodeBody(serializeRequestBody(draft.body)),
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
      cookieJar={cookieJar}
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
    <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-purr-base">
      <main className="flex min-h-0 w-full flex-1 flex-col px-ui-3 pb-ui-2 pt-ui-6 sm:px-ui-4 sm:pt-ui-8">
        <RequestTabBar view={view} onViewChange={selectView} />
        <div
          className="mt-ui-3 min-h-0 flex-1"
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
          />
        </div>
      </main>
      <footer className="pointer-events-none flex h-control-lg shrink-0 items-center justify-end px-ui-3 font-code text-ui-xs text-content-tertiary sm:px-ui-4">
        Purr v0.0.0
      </footer>
    </div>
  );
}
