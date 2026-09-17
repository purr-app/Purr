import { Braces, Fingerprint } from "lucide-react";
import { useState } from "react";
import { Button } from "../../../shared/components/ui/button";
import { FormField } from "../../../shared/components/ui/form-field";
import { Checkbox } from "../../../shared/components/ui/checkbox";
import { JsonCodePreview } from "../../../shared/components/ui/json-code-preview";
import { SelectField } from "../../../shared/components/ui/select-field";
import { cn } from "../../../shared/lib/cn";
import {
  getBearerToken,
  inspectJwt,
  tokenExpiryLabel,
  type AuthContext,
  type RequestAuth,
} from "../model/request-auth";

export function BearerAuthForm({
  auth,
  onAuthChange,
  context,
  now,
  secureStorageOnly = false,
}: {
  auth: RequestAuth;
  onAuthChange: (auth: RequestAuth) => void;
  context: AuthContext;
  now: number;
  secureStorageOnly?: boolean;
}) {
  const [inspect, setInspect] = useState(false);
  let bearer = "";
  try {
    bearer = getBearerToken(auth, context);
  } catch {
    /* inline binding status explains unresolved source */
  }
  const jwt = inspectJwt(bearer);

  return (
    <div className="space-y-ui-4">
      <div className="flex flex-wrap items-center justify-between gap-ui-3">
        <div className="flex items-center gap-ui-2 text-ui-md">
          <Fingerprint className="size-ui-4 text-action-brand" />
          Bearer credentials
        </div>
      </div>
      <div className="ui-auth-bearer-grid">
        <div className="space-y-ui-2">
          <span className="block text-ui-xs font-medium text-content-secondary">
            Token prefix
          </span>
          <SelectField
            label="Token prefix"
            size="lg"
            value={auth.bearer.prefix}
            options={[
              { value: "Bearer", label: "Bearer" },
              { value: "Token", label: "Token" },
              { value: "", label: "No prefix" },
            ]}
            className="w-full font-code"
            onValueChange={(prefix) =>
              onAuthChange({
                ...auth,
                bearer: { ...auth.bearer, prefix },
              })
            }
          />
        </div>
        <div className="space-y-ui-2"><FormField
            label="Bearer token"
            secret
            placeholder="Paste your token"
            value={auth.bearer.token}
            onChange={(event) =>
              onAuthChange({
                ...auth,
                bearer: {
                  ...auth.bearer,
                  token: event.target.value.trim().replace(/^Bearer\s+/i, ""),
                },
              })
            }
          />{!secureStorageOnly ? <Checkbox label="Store token as secret" checked={auth.credentialStorage?.bearer !== "plain"} onCheckedChange={(secret) => onAuthChange({ ...auth, credentialStorage: { ...auth.credentialStorage, bearer: secret ? "secret" : "plain" } })} /> : null}</div>
      </div>
      {jwt ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setInspect(!inspect)}
            aria-expanded={inspect}
          >
            <Braces className="size-ui-3-5" />
            {inspect ? "Hide" : "Inspect"} JWT{" "}
            <span
              className={cn(
                "font-code text-ui-xs",
                jwt.expiresAt && jwt.expiresAt <= now
                  ? "text-accent-orange"
                  : "text-content-tertiary",
              )}
            >
              {jwt.expiresAt === undefined
                ? "No exp claim"
                : tokenExpiryLabel(jwt.expiresAt, now)}
            </span>
          </Button>
        </div>
      ) : null}
      {inspect && jwt ? (
        <div className="rounded-ui-xl bg-purr-elevated p-ui-4">
          <div className="grid min-w-0 gap-ui-4 md:grid-cols-2">
            {[
              ["Header", jwt.header],
              ["Claims", jwt.claims],
            ].map(([label, value]) => (
              <div key={String(label)} className="flex min-w-0 flex-col">
                <h3 className="mb-ui-2 text-ui-xs text-content-secondary">
                  {String(label)}
                </h3>
                <JsonCodePreview
                  value={value}
                  label={`${String(label)} JWT JSON`}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
