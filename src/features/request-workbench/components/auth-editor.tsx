import { useEffect, useRef } from "react";
import { credentialState } from "../../../application/resolve-request-secrets";
import { CircleOff, GitBranch } from "lucide-react";
import { AuthVariableField } from "./auth-variable-field";
import { SegmentedTabs } from "../../../shared/components/ui/segmented-tabs";
import { SelectField } from "../../../shared/components/ui/select-field";
import {
  authTypeOptions,
  resolveAuth,
  type AuthContext,
  type RequestAuth,
} from "../model/request-auth";
import type { AuthRuntime } from "../hooks/use-auth-runtime";
import { BearerAuthForm } from "./bearer-auth-form";
import { OAuthAuthForm } from "./oauth-auth-form";
import type { TemplateVariableActions } from "./template-variable-popover";

type Props = {
  auth: RequestAuth;
  onAuthChange: (auth: RequestAuth) => void;
  context: AuthContext;
  runtime: AuthRuntime;
  allowInherit?: boolean;
  secureStorageOnly?: boolean;
  idPrefix?: string;
  ariaLabel?: string;
  variableActions?: TemplateVariableActions;
};

export function AuthEditor({
  auth,
  onAuthChange: publishAuth,
  context,
  runtime,
  allowInherit = true,
  secureStorageOnly = false,
  idPrefix = "request",
  ariaLabel,
  variableActions,
}: Props) {
  const current = useRef(auth);
  current.current = auth;
  const credentialValues = (value: RequestAuth): Record<string, string> => ({ bearer: value.bearer.token, password: value.basic.password, "api-key": value.apiKey.value, "client-secret": value.oauth2.clientSecret, "oauth-access-token": value.oauth2.token?.accessToken ?? "", "oauth-refresh-token": value.oauth2.token?.refreshToken ?? "" });
  const onAuthChange = (next: RequestAuth) => {
    const previousValues = credentialValues(auth);
    const states = { ...next.credentialStates };
    for (const [slot, value] of Object.entries(credentialValues(next))) if (previousValues[slot] !== value && credentialState(auth, slot)) states[slot] = { ...credentialState(auth, slot)!, status: "available", edit: { kind: "set", value } };
    if (auth.oauth2.token && !next.oauth2.token) for (const slot of ["oauth-access-token", "oauth-refresh-token"]) if (credentialState(auth, slot)) states[slot] = { ...credentialState(auth, slot)!, status: "missing", edit: { kind: "delete" } };
    publishAuth({ ...next, credentialStates: states });
  };
  useEffect(() => {
    if (!context.secretStore) return;
    const slots = auth.type === "bearer" ? ["bearer"] : auth.type === "basic" ? ["password"] : auth.type === "api-key" ? ["api-key"] : auth.type === "oauth2" ? ["client-secret", "oauth-access-token", "oauth-refresh-token"] : [];
    const pending = slots.filter((slot) => credentialState(auth, slot)?.status === "unresolved" && !credentialState(auth, slot)?.edit?.kind?.match(/set|delete/));
    if (!pending.length) return;
    let active = true;
    void Promise.all(pending.map(async (slot) => ({ slot, result: await context.secretStore!.resolve(credentialState(auth, slot)!.ref) }))).then((results) => {
      if (!active || current.current !== auth) return;
      const next = { ...auth, bearer: { ...auth.bearer }, basic: { ...auth.basic }, apiKey: { ...auth.apiKey }, oauth2: { ...auth.oauth2, token: auth.oauth2.token ? { ...auth.oauth2.token } : null }, credentialStates: { ...auth.credentialStates } };
      for (const { slot, result } of results) {
        next.credentialStates[slot] = { ...credentialState(auth, slot)!, status: result.status, edit: { kind: "keep" }, ...("code" in result ? { code: result.code } : {}) };
        if (result.status !== "available") continue;
        if (slot === "bearer") next.bearer.token = result.value;
        if (slot === "password") next.basic.password = result.value;
        if (slot === "api-key") next.apiKey.value = result.value;
        if (slot === "client-secret") next.oauth2.clientSecret = result.value;
        if (slot === "oauth-access-token" && next.oauth2.token) next.oauth2.token.accessToken = result.value;
        if (slot === "oauth-refresh-token" && next.oauth2.token) next.oauth2.token.refreshToken = result.value;
      }
      publishAuth(next);
    }).catch(() => { /* Operation-time resolution reports typed failures; no value is replaced. */ });
    return () => { active = false; };
  }, [auth, context.secretStore, publishAuth]);
  const resolved = resolveAuth(auth, context);
  const typeOptions = allowInherit
    ? authTypeOptions
    : authTypeOptions.filter((option) => option.value !== "inherit");
  const workspaceProfiles = context.workspaceProfiles ?? (context.workspace ? [context.workspace] : []);

  return (
    <section
      id={`${idPrefix}-section-auth`}
      role="tabpanel"
      aria-labelledby={ariaLabel ? undefined : "request-tab-auth"}
      aria-label={ariaLabel ?? "Request authentication"}
      className="h-full min-h-0 min-w-0 overflow-auto bg-purr-surface"
    >
      <div className="flex flex-wrap items-center gap-ui-2 border-b border-border-subtle bg-purr-surface px-ui-3 py-ui-2">
        <SegmentedTabs
          id={`${idPrefix}-auth-type`}
          panelId={`${idPrefix}-auth-type-panel`}
          label="Authentication type"
          value={auth.type}
          options={typeOptions}
          onValueChange={(type) => {
            onAuthChange({ ...auth, type, ...(type === "inherit" && context.schema ? { inherit: { source: "schema" as const } } : {}) });
            runtime.clearError();
          }}
        />
      </div>
      <div
        id={`${idPrefix}-auth-type-panel`}
        role="tabpanel"
        aria-labelledby={`${idPrefix}-auth-type-${auth.type}`}
        className={
          auth.type === "none" ? "p-ui-3 sm:p-ui-4" : "p-ui-4 sm:p-ui-5"
        }
      >
        {auth.type === "none" ? (
          <div className="flex items-center gap-ui-2 text-content-tertiary">
            <CircleOff className="size-ui-4" aria-hidden="true" />
            <span className="text-ui-sm">No authentication</span>
          </div>
        ) : null}

        {auth.type === "bearer" ? (
          <BearerAuthForm
            secureStorageOnly={secureStorageOnly}
            auth={auth}
            onAuthChange={onAuthChange}
            context={context}
            now={runtime.now}
            variableActions={variableActions}
          />
        ) : null}

        {auth.type === "basic" ? (
          <div className="grid gap-ui-4 sm:grid-cols-2">
              <AuthVariableField variableActions={variableActions}
                label="Username"
                placeholder="Username"
                value={auth.basic.username}
                onChange={(value) =>
                  onAuthChange({
                    ...auth,
                    basic: { ...auth.basic, username: value },
                  })
                }
              />
              <AuthVariableField variableActions={variableActions}
                label="Password"
                state={auth.credentialStates?.password}
                secret
                placeholder="Password"
                value={auth.basic.password}
                onChange={(value) =>
                  onAuthChange({
                    ...auth,
                    basic: { ...auth.basic, password: value },
                  })
                }
              />
          </div>
        ) : null}

        {auth.type === "api-key" ? (
          <div className="grid gap-ui-4 md:grid-cols-3">
              <AuthVariableField variableActions={variableActions}
                label="Key name"
                placeholder={
                  auth.apiKey.placement === "header" ? "X-API-Key" : "api_key"
                }
                value={auth.apiKey.name}
                onChange={(value) =>
                  onAuthChange({
                    ...auth,
                    apiKey: { ...auth.apiKey, name: value },
                  })
                }
              />
              <AuthVariableField variableActions={variableActions}
                label="Key value"
                state={auth.credentialStates?.["api-key"]}
                secret
                placeholder="Enter API key"
                value={auth.apiKey.value}
                onChange={(value) =>
                  onAuthChange({
                    ...auth,
                    apiKey: { ...auth.apiKey, value: value },
                  })
                }
              />
              <div className="space-y-ui-2">
                <span className="block text-ui-xs text-content-secondary">
                  Add to
                </span>
                <SelectField
                  label="Add API key to"
                  size="lg"
                  value={auth.apiKey.placement}
                  options={[
                    { value: "header", label: "Header" },
                    { value: "query", label: "Query param" },
                    { value: "cookie", label: "Cookie" },
                  ]}
                  onValueChange={(placement) =>
                    onAuthChange({
                      ...auth,
                      apiKey: { ...auth.apiKey, placement },
                    })
                  }
                  className="w-full"
                />
              </div>
          </div>
        ) : null}

        {auth.type === "oauth2" ? (
          <OAuthAuthForm
            auth={auth}
            onAuthChange={onAuthChange}
            runtime={runtime}
            variableActions={variableActions}
          />
        ) : null}

        {auth.type === "inherit" ? (
          <div className="space-y-ui-4">
            {(context.schema || workspaceProfiles.length > 1) ? <div className="max-w-ui-dialog space-y-ui-2">
              <span className="block text-ui-xs font-medium text-content-secondary">Shared authentication profile</span>
              <SelectField label="Inherit authentication from" size="lg"
                value={auth.inherit.source === "schema" ? "schema" : auth.inherit.profileId ?? resolved.source?.id ?? workspaceProfiles[0]?.id ?? ""}
                options={[...(context.schema ? [{ value: "schema", label: `Schema: ${context.schema.name}` }] : []), ...workspaceProfiles.map((profile) => ({ value: profile.id, label: profile.name }))]}
                onValueChange={(profileId) => onAuthChange({ ...auth, inherit: profileId === "schema" ? { source: "schema" } : { source: "workspace", profileId } })}
                className="w-full" />
            </div> : null}
            <div className="flex items-center gap-ui-2 text-ui-sm">
              <GitBranch className="size-ui-4 shrink-0 text-action-brand" />
              {resolved.error ? (
                <span role="alert" className="text-accent-red">{resolved.error}</span>
              ) : (
                <span role="status" className="text-content-tertiary">
                  Authentication inherited from <span className="text-content-secondary">{resolved.source?.name ?? "workspace"}</span>
                  {resolved.auth.type !== "inherit" ? <> · <span className="text-content-secondary">{authTypeOptions.find((option) => option.value === resolved.auth.type)?.label ?? resolved.auth.type}</span></> : null}
                </span>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
