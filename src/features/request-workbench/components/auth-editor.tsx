import { CircleOff, GitBranch } from "lucide-react";
import { FormField } from "../../../shared/components/ui/form-field";
import { SegmentedTabs } from "../../../shared/components/ui/segmented-tabs";
import { SelectField } from "../../../shared/components/ui/select-field";
import {
  authTypeOptions,
  resolveAuth,
  type AuthContext,
  type AuthSourceDocumentOption,
  type RequestAuth,
} from "../model/request-auth";
import type { AuthRuntime } from "../hooks/use-auth-runtime";
import { BearerAuthForm } from "./bearer-auth-form";
import { OAuthAuthForm } from "./oauth-auth-form";

type Props = {
  auth: RequestAuth;
  onAuthChange: (auth: RequestAuth) => void;
  context: AuthContext;
  runtime: AuthRuntime;
  allowInherit?: boolean;
  idPrefix?: string;
  ariaLabel?: string;
  responseSourceDocuments?: readonly AuthSourceDocumentOption[];
};

export function AuthEditor({
  auth,
  onAuthChange,
  context,
  runtime,
  allowInherit = true,
  idPrefix = "request",
  ariaLabel,
  responseSourceDocuments = [],
}: Props) {
  const resolved = resolveAuth(auth, context);
  const typeOptions = allowInherit
    ? authTypeOptions
    : authTypeOptions.filter((option) => option.value !== "inherit");

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
            onAuthChange({ ...auth, type });
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
            auth={auth}
            onAuthChange={onAuthChange}
            context={context}
            now={runtime.now}
            responseSourceDocuments={responseSourceDocuments}
          />
        ) : null}

        {auth.type === "basic" ? (
          <div className="grid gap-ui-4 sm:grid-cols-2">
              <FormField
                label="Username"
                placeholder="Username"
                value={auth.basic.username}
                onChange={(event) =>
                  onAuthChange({
                    ...auth,
                    basic: { ...auth.basic, username: event.target.value },
                  })
                }
              />
              <FormField
                label="Password"
                secret
                placeholder="Password"
                value={auth.basic.password}
                onChange={(event) =>
                  onAuthChange({
                    ...auth,
                    basic: { ...auth.basic, password: event.target.value },
                  })
                }
              />
          </div>
        ) : null}

        {auth.type === "api-key" ? (
          <div className="grid gap-ui-4 md:grid-cols-3">
              <FormField
                label="Key name"
                placeholder={
                  auth.apiKey.placement === "header" ? "X-API-Key" : "api_key"
                }
                value={auth.apiKey.name}
                onChange={(event) =>
                  onAuthChange({
                    ...auth,
                    apiKey: { ...auth.apiKey, name: event.target.value },
                  })
                }
              />
              <FormField
                label="Key value"
                secret
                placeholder="Enter API key"
                value={auth.apiKey.value}
                onChange={(event) =>
                  onAuthChange({
                    ...auth,
                    apiKey: { ...auth.apiKey, value: event.target.value },
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
          />
        ) : null}

        {auth.type === "inherit" ? (
          <div className="flex items-center gap-ui-2 text-ui-sm">
            <GitBranch className="size-ui-4 shrink-0 text-action-brand" />
            {resolved.error ? (
              <span role="alert" className="text-accent-red">No workspace authentication is configured for this request type.</span>
            ) : (
              <span role="status" className="text-content-tertiary">
                Authentication inherited from <span className="text-content-secondary">{resolved.source?.name ?? "workspace"}</span>
                {resolved.auth.type !== "inherit" ? <> · <span className="text-content-secondary">{authTypeOptions.find((option) => option.value === resolved.auth.type)?.label ?? resolved.auth.type}</span></> : null}
              </span>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
