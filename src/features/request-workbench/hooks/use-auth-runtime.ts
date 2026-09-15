import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { RequestDraft } from "../model/request";
import {
  resolveAuth,
  type AuthContext,
  type OAuthToken,
  type RequestAuth,
} from "../model/request-auth";
import {
  authorizeOAuth,
  fetchOAuthToken,
  oauthIdentity,
  resolvedOAuth,
} from "../services/oauth-client";
import { useApplicationServices } from "../../../app/application-services-context";

export type AuthRuntime = {
  busy: boolean;
  authorizing: boolean;
  error: string;
  now: number;
  run: (action: "initial" | "refresh") => Promise<OAuthToken | null>;
  cancel: () => void;
  clearError: () => void;
};
export function useAuthRuntime(
  draft: RequestDraft,
  setDraft: Dispatch<SetStateAction<RequestDraft>>,
  context: AuthContext,
  setContext: Dispatch<SetStateAction<AuthContext>>,
  onInheritedAuthChange?: (profileId: string, auth: RequestAuth) => void,
) {
  const { httpTransport, oauthCallback } = useApplicationServices();
  const [busy, setBusy] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const current = useRef({ draft, context });
  current.current = { draft, context };
  const pending = useRef<{
    sessionId: string;
    identity: string;
    abort: AbortController;
    promise: Promise<OAuthToken | null>;
  } | null>(null);
  const resolved = resolveAuth(draft.auth, context);
  const identity =
    resolved.auth.type === "oauth2" ? oauthIdentity(resolved.auth.oauth2) : "";
  const cancel = useCallback(() => {
    const job = pending.current;
    pending.current = null;
    setBusy(false);
    setAuthorizing(false);
    if (job) {
      job.abort.abort();
      void oauthCallback.cancel(job.sessionId).catch(() => {});
      setError("Token request canceled.");
    }
  }, [oauthCallback]);
  useEffect(() => {
    if (pending.current?.identity !== identity) cancel();
    setError("");
  }, [identity, cancel]);
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(interval);
      const job = pending.current;
      pending.current = null;
      if (job) {
        job.abort.abort();
        void oauthCallback.cancel(job.sessionId).catch(() => {});
      }
    };
  }, [oauthCallback]);

  const run = useCallback(
    (action: "initial" | "refresh"): Promise<OAuthToken | null> => {
      if (pending.current) return pending.current.promise;
      const snapshot = current.current;
      const effective = resolveAuth(snapshot.draft.auth, snapshot.context);
      if (effective.error || effective.auth.type !== "oauth2")
        return Promise.resolve(null);
      const sourceConfig = effective.auth.oauth2;
      const key = oauthIdentity(sourceConfig);
      const sessionId = crypto.randomUUID();
      const abort = new AbortController();
      setBusy(true);
      setError("");
      const isAuthorize =
        action === "initial" && sourceConfig.grantType === "authorization_code";
      setAuthorizing(isAuthorize);
      // Defer until the pending job is registered, including synchronous validation errors.
      const promise = Promise.resolve().then(async () => {
        try {
          const config = resolvedOAuth(sourceConfig, snapshot.context);
          const token = isAuthorize
            ? await authorizeOAuth(
                config,
                sessionId,
                oauthCallback,
                httpTransport,
                abort.signal,
              )
            : await fetchOAuthToken(
                config,
                action,
                undefined,
                httpTransport,
              );
          if (pending.current?.sessionId !== sessionId) return null;
          const update = (auth: RequestAuth) =>
            oauthIdentity(auth.oauth2) === key
              ? { ...auth, oauth2: { ...auth.oauth2, token } }
              : auth;
          if (effective.source) {
            const updatedSourceAuth = update(effective.source.auth);
            setContext((previous) => ({
              ...previous,
              workspace:
                previous.workspace &&
                previous.workspace.id === effective.source?.id
                  ? {
                      ...previous.workspace,
                      auth: updatedSourceAuth,
                    }
                  : previous.workspace,
              workspaceProfiles: previous.workspaceProfiles?.map((profile) =>
                profile.id === effective.source?.id
                  ? { ...profile, auth: updatedSourceAuth }
                  : profile),
              environment:
                previous.environment &&
                previous.environment.id === effective.source?.id
                  ? {
                      ...previous.environment,
                      auth: updatedSourceAuth,
                    }
                  : previous.environment,
            }));
            onInheritedAuthChange?.(effective.source.id, updatedSourceAuth);
          } else
            setDraft((previous) => ({
              ...previous,
              auth: update(previous.auth),
            }));
          return token;
        } catch (cause) {
          if (pending.current?.sessionId === sessionId)
            setError(cause instanceof Error ? cause.message : String(cause));
          return null;
        } finally {
          if (pending.current?.sessionId === sessionId) {
            pending.current = null;
            setBusy(false);
            setAuthorizing(false);
          }
        }
      });
      pending.current = { sessionId, identity: key, abort, promise };
      return promise;
    },
    [
      httpTransport,
      oauthCallback,
      onInheritedAuthChange,
      setDraft,
      setContext,
    ],
  );

  const token =
    resolved.auth.type === "oauth2" ? resolved.auth.oauth2.token : null;
  const config = resolved.auth.oauth2;
  const refreshable =
    config.grantType === "client_credentials" || Boolean(token?.refreshToken);
  useEffect(() => {
    if (
      !identity ||
      !config.autoRefresh ||
      !token?.expiresAt ||
      !refreshable ||
      busy ||
      error
    )
      return;
    const lead = Math.min(
      30000,
      Math.max(0, (token.expiresAt - token.obtainedAt) * 0.1),
    );
    // Guard pathological zero-lifetime tokens against a refresh loop.
    const delay = Math.max(1000, token.expiresAt - lead - Date.now());
    const timer = setTimeout(
      () => {
        void run("refresh");
      },
      Math.min(delay, 2147483647),
    );
    return () => clearTimeout(timer);
  }, [identity, config.autoRefresh, token, refreshable, busy, error, run]);

  return {
    busy,
    authorizing,
    error,
    now,
    run,
    cancel,
    clearError: () => setError(""),
  } satisfies AuthRuntime;
}
