import {
  ArrowDownToLine,
  ExternalLink,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useId } from "react";
import { Button } from "../../../shared/components/ui/button";
import { Checkbox } from "../../../shared/components/ui/checkbox";
import { FormField } from "../../../shared/components/ui/form-field";
import { Input } from "../../../shared/components/ui/input";
import { SecretInput } from "../../../shared/components/ui/secret-input";
import { SelectField } from "../../../shared/components/ui/select-field";
import { cn } from "../../../shared/lib/cn";
import {
  tokenExpiryLabel,
  type OAuthConfig,
  type RequestAuth,
} from "../model/request-auth";
import type { AuthRuntime } from "../hooks/use-auth-runtime";
import { TemplateVariablePopover, type TemplateVariableActions } from "./template-variable-popover";

function OAuthVariableField({ label, value, placeholder, secret = false, secretVariablesOnly = false, variableActions, onChange }: {
  label: string;
  value: string;
  placeholder?: string;
  secret?: boolean;
  secretVariablesOnly?: boolean;
  variableActions?: TemplateVariableActions;
  onChange: (value: string) => void;
}) {
  const id = useId();
  if (!variableActions) return <FormField label={label} value={value} placeholder={placeholder} secret={secret} onChange={(event) => onChange(event.target.value)} />;
  const actions = secretVariablesOnly
    ? {
        ...variableActions,
        definitions: variableActions.definitions.filter((variable) => variable.sensitive),
        onCreateMissingVariable: (name: string, kind: "static" | "dynamic-request") =>
          variableActions.onCreateMissingVariable(name, kind, true),
      }
    : variableActions;
  return <div className="min-w-0 space-y-ui-2">
    <label htmlFor={id} className="block text-ui-xs font-medium text-content-secondary">{label}</label>
    <TemplateVariablePopover value={value} onValueChange={onChange} actions={actions}>{(bindings) => secret
      ? <SecretInput {...bindings} id={id} aria-label={label} value={value} placeholder={placeholder} className="font-code" />
      : <Input {...bindings} id={id} aria-label={label} value={value} placeholder={placeholder} className="ui-focus-ring bg-purr-elevated font-code" autoComplete="off" spellCheck={false} />}
    </TemplateVariablePopover>
  </div>;
}

export function OAuthAuthForm({
  auth,
  onAuthChange,
  runtime,
  variableActions,
}: {
  auth: RequestAuth;
  onAuthChange: (auth: RequestAuth) => void;
  runtime: AuthRuntime;
  variableActions?: TemplateVariableActions;
}) {
  const oauth = auth.oauth2;
  const setOAuth = (patch: Partial<OAuthConfig>) => {
    runtime.clearError();
    onAuthChange({
      ...auth,
      oauth2: {
        ...oauth,
        ...patch,
        ...(Object.keys(patch).some(
          (key) => key !== "autoRefresh" && key !== "token",
        )
          ? { token: null }
          : {}),
      },
    });
  };

  return (
    <div className="grid items-stretch gap-ui-5 lg:grid-cols-2">
        <div className="space-y-ui-4">
          <div className="space-y-ui-2">
            <div className="flex items-center justify-between gap-ui-3">
              <span className="text-ui-xs font-medium text-content-secondary">
                Grant type
              </span>
              {oauth.grantType === "authorization_code" && (
                <span className="flex items-center gap-ui-1 font-code text-ui-xs text-action-brand">
                  <ShieldCheck className="size-ui-3" />
                  PKCE · S256
                </span>
              )}
            </div>
            <SelectField
              label="OAuth grant type"
              size="lg"
              value={oauth.grantType}
              options={[
                { value: "client_credentials", label: "Client Credentials" },
                {
                  value: "authorization_code",
                  label: "Authorization Code + PKCE",
                },
              ]}
              onValueChange={(grantType) => setOAuth({ grantType })}
              className="w-full bg-purr-highlight"
            />
          </div>
          {oauth.grantType === "authorization_code" && (
            <OAuthVariableField
              label="Authorization URL"
              value={oauth.authorizationUrl}
              placeholder="https://auth.example.com/authorize"
              variableActions={variableActions}
              onChange={(authorizationUrl) => setOAuth({ authorizationUrl })}
            />
          )}
          <OAuthVariableField
            label="Token URL"
            value={oauth.tokenUrl}
            placeholder="https://auth.example.com/oauth/token"
            variableActions={variableActions}
            onChange={(tokenUrl) => setOAuth({ tokenUrl })}
          />
          <div className="grid gap-ui-4 sm:grid-cols-2">
            <OAuthVariableField
              label="Client ID"
              value={oauth.clientId}
              placeholder="Client ID"
              variableActions={variableActions}
              onChange={(clientId) => setOAuth({ clientId })}
            />
            <OAuthVariableField
              label={`Client Secret${oauth.grantType === "authorization_code" ? " (optional)" : ""}`}
              secret
              secretVariablesOnly
              value={oauth.clientSecret}
              placeholder="Client secret"
              variableActions={variableActions}
              onChange={(clientSecret) => setOAuth({ clientSecret })}
            />
          </div>
          <OAuthVariableField
            label="Scopes"
            value={oauth.scopes}
            placeholder="read:profile write:orders"
            variableActions={variableActions}
            onChange={(scopes) => setOAuth({ scopes })}
          />
          {oauth.grantType === "authorization_code" && (
            <OAuthVariableField
              label="Callback URL"
              value={oauth.redirectUri}
              variableActions={variableActions}
              onChange={(redirectUri) => setOAuth({ redirectUri })}
            />
          )}
          <div className="space-y-ui-2">
            <span className="block text-ui-xs text-content-secondary">
              Client authentication
            </span>
            <SelectField
              label="OAuth client authentication"
              size="lg"
              value={oauth.clientAuthentication}
              options={[
                { value: "body", label: "Send credentials in body" },
                { value: "basic", label: "Send as Basic Auth header" },
              ]}
              onValueChange={(clientAuthentication) =>
                setOAuth({ clientAuthentication })
              }
              className="w-full"
            />
          </div>
        </div>
        <div className="flex h-full min-w-0 flex-col gap-ui-4 self-stretch rounded-ui-lg bg-purr-elevated p-ui-4">
          <div className="flex flex-wrap items-center justify-between gap-ui-3">
            <h3 className="text-ui-md font-medium">Access token</h3>
            <div className="flex flex-wrap items-center gap-ui-2">
              <span className="rounded-ui-sm bg-action-brand-surface px-ui-2 py-ui-1 font-code text-ui-xs text-action-brand">
                Authorization header
              </span>
              <span
                className={cn(
                  "flex items-center gap-ui-1-5 font-code text-ui-xs",
                  oauth.token
                    ? oauth.token.expiresAt &&
                      oauth.token.expiresAt <= runtime.now
                      ? "text-accent-orange"
                      : "text-syntax-string"
                    : "text-content-tertiary",
                )}
              >
                <span className="size-ui-1-5 rounded-full bg-current" />
                {oauth.token
                  ? tokenExpiryLabel(oauth.token.expiresAt, runtime.now)
                  : "Not authorized"}
              </span>
            </div>
          </div>
          {oauth.token ? (
            <>
              <SecretInput
                value={oauth.token.accessToken}
                readOnly
                aria-label="OAuth access token"
              />
              <div className="flex flex-wrap gap-x-ui-4 gap-y-ui-1 font-code text-ui-xs text-content-tertiary">
                <span>Bearer</span>
                {oauth.token.expiresAt && (
                  <span>
                    Expires{" "}
                    {new Date(oauth.token.expiresAt).toLocaleTimeString()}
                  </span>
                )}
                <span>
                  {oauth.token.refreshToken
                    ? "Refresh token available"
                    : oauth.grantType === "client_credentials"
                      ? "Renews with client credentials"
                      : "No refresh token provided"}
                </span>
              </div>
            </>
          ) : (
            <div className="flex min-h-panel items-center justify-center text-content-tertiary">
              <LockKeyhole className="size-ui-6" />
            </div>
          )}
          <div className="mt-auto flex flex-wrap gap-ui-2">
            <Button
              type="button"
              disabled={runtime.busy}
              onClick={() => {
                void runtime.run("initial");
              }}
              className="flex-1 bg-action-brand text-content-primary hover:bg-action-brand-hover"
            >
              {runtime.busy ? (
                <LoaderCircle className="size-ui-4 animate-spin" />
              ) : oauth.grantType === "authorization_code" ? (
                <ExternalLink className="size-ui-4" />
              ) : (
                <ArrowDownToLine className="size-ui-4" />
              )}
              {runtime.busy
                ? runtime.authorizing
                  ? "Waiting for authorization…"
                  : "Fetching token…"
                : oauth.grantType === "authorization_code"
                  ? "Authorize & use token"
                  : "Fetch & use token"}
            </Button>
            {runtime.busy ? (
              <Button
                variant="secondary"
                type="button"
                onClick={runtime.cancel}
              >
                Cancel
              </Button>
            ) : (
              oauth.token && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    oauth.grantType === "authorization_code" &&
                    !oauth.token.refreshToken
                  }
                  onClick={() => {
                    void runtime.run("refresh");
                  }}
                >
                  <RefreshCw className="size-ui-3-5" />
                  Refresh
                </Button>
              )
            )}
          </div>
          <Checkbox
            checked={oauth.autoRefresh}
            label="Refresh automatically"
            onCheckedChange={(autoRefresh) => setOAuth({ autoRefresh })}
          />
          {runtime.error && (
            <p role="alert" className="break-words text-ui-sm text-accent-red">
              {runtime.error}
            </p>
          )}
          {oauth.token && (
            <Button
              variant="ghost"
              type="button"
              size="sm"
              className="self-start"
              onClick={() => {
                runtime.cancel();
                setOAuth({ token: null });
              }}
            >
              Clear local token
            </Button>
          )}
        </div>
    </div>
  );
}
