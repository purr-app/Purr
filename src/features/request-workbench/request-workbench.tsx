import { useRef, useState } from "react";

import { RequestComposer } from "./components/request-composer";
import { RequestTabBar } from "./components/request-tab-bar";
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

export function RequestWorkbench() {
  const [draft, setDraft] = useState<RequestDraft>(initialRequestDraft);
  const [authContext, setAuthContext] = useState<AuthContext>({});
  const [cookieJar] = useState(() => new SessionCookieJar());
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [response, setResponse] = useState<HttpResult | null>(null);
  const [error, setError] = useState("");
  const authRuntime = useAuthRuntime(
    draft,
    setDraft,
    authContext,
    setAuthContext,
  );

  const send = async () => {
    if (sendingRef.current) return;
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

  return (
    <div className="flex min-h-screen flex-col bg-purr-base">
      <main className="mx-auto flex w-full max-w-content flex-1 flex-col px-ui-4 pb-ui-6 pt-ui-6 sm:px-ui-7 sm:pt-ui-8">
        <div className="shrink-0">
          <RequestTabBar />
          <div className="mt-ui-3">
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
            />
          </div>
        </div>
        {error ? (
          <p
            role="alert"
            className="mt-ui-4 rounded-ui-lg bg-purr-elevated px-ui-4 py-ui-3 text-ui-md text-accent-red"
          >
            {error}
          </p>
        ) : null}
        {response ? <ResponseViewer response={response} /> : null}
      </main>
      <footer className="pointer-events-none flex h-control-lg items-center justify-end px-ui-7 font-code text-ui-xs text-content-tertiary">
        Purr v0.0.0
      </footer>
    </div>
  );
}
