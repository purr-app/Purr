import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { IntegrationSettingsProps } from "./contracts";
import { useTabState } from "../shared/state/tab-state";
import { AuthEditor } from "../features/request-workbench/components/auth-editor";
import { HeadersEditor } from "../features/request-workbench/components/headers-editor";
import { TemplateVariablePopover } from "../features/request-workbench/components/template-variable-popover";
import { ColorizedUrlInput } from "../features/request-workbench/components/colorized-url-input";
import { useAuthRuntime } from "../features/request-workbench/hooks/use-auth-runtime";
import { createRequestAuth, normalizeRequestAuth, type AuthContext } from "../features/request-workbench/model/request-auth";
import { initialRequestDraft, type RequestDraft } from "../features/request-workbench/model/request";
import { Button } from "../shared/components/ui/button";
import { FormField } from "../shared/components/ui/form-field";
import { SelectField } from "../shared/components/ui/select-field";

/** Shared connection editor available to first-party and private provider modules. */
export function IntegrationConnectionSettings({ value, onSave, onCancel, setCredential, getCredential, variables = {}, variableActions, authContext, endpointHint }: IntegrationSettingsProps & { endpointHint?: string }) {
  const prefix = `integration.${value.id}`;
  const [name, setName] = useTabState(`${prefix}.name`, value.name);
  const [endpoint, setEndpoint] = useTabState(`${prefix}.endpoint`, String(value.config.endpoint ?? ""));
  const [tracing, setTracing] = useTabState(`${prefix}.tracing`, value.tracing ?? { propagation: "w3c" as const, requestHeaders: [], responseHeaders: [] });
  const [draft, setDraft] = useTabState<RequestDraft>(`${prefix}.auth`, () => ({ ...initialRequestDraft, auth: createRequestAuth() }));
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [context, setContext] = useState<AuthContext>({ ...authContext, variables });
  const runtime = useAuthRuntime(draft, setDraft as Dispatch<SetStateAction<RequestDraft>>, context, setContext);
  useEffect(() => { setContext({ ...authContext, variables }); }, [authContext, variables]);
  useEffect(() => {
    let live = true;
    async function restore() {
      try {
        if (value.config.auth === "request" && getCredential) {
          const stored = await getCredential("auth");
          if (stored && live) setDraft((current) => current.auth.type !== "none" ? current : { ...current, auth: normalizeRequestAuth(JSON.parse(stored)) });
        } else if (value.config.auth === "bearer" && getCredential) {
          const token = await getCredential("apiToken");
          if (live) setDraft((current) => current.auth.type !== "none" ? current : { ...current, auth: { ...createRequestAuth(), type: "bearer", bearer: { token: token ?? "", prefix: "Bearer" } } });
        }
        if (live) setReady(true);
      } catch { if (live) setError("Could not read the saved authentication from secure storage."); }
    }
    void restore();
    return () => { live = false; };
  }, [value.id, value.config.auth, getCredential, setDraft]);
  async function save() {
    setSaving(true); setError("");
    try {
      // All auth modes and inactive fields stay inside the vault, including OAuth tokens.
      await setCredential("auth", JSON.stringify(draft.auth));
      await onSave({ ...value, name: name.trim(), config: { ...value.config, endpoint: endpoint.trim(), auth: "request" }, tracing });
    } catch { setError("Could not save this integration. Check the endpoint and secure storage."); }
    finally { setSaving(false); }
  }
  const headerEditor = (kind: "requestHeaders" | "responseHeaders") => <HeadersEditor
    headers={tracing[kind].map((header, index) => ({ ...header, id: `${kind}-${index}` }))}
    variableActions={variableActions}
    onHeadersChange={(headers) => setTracing((current) => ({ ...current, [kind]: headers.filter((header) => header.name || header.value).map(({ name, value, enabled }) => ({ name, value, enabled })) }))} />;
  return <div className="space-y-ui-5 p-ui-5">
    <FormField label="Integration name" value={name} placeholder="Production traces" onChange={(event) => setName(event.target.value)} />
    <div className="space-y-ui-2">
      <label htmlFor={`${value.id}-endpoint`} className="block text-ui-sm text-content-secondary">Endpoint URL</label>
      <TemplateVariablePopover value={endpoint} actions={variableActions ?? { definitions: [], onOpenVariable: () => {}, onCreateMissingVariable: () => {} }} onValueChange={setEndpoint}>
        {(bindings) => 
        <ColorizedUrlInput {...bindings} id={`${value.id}-endpoint`} aria-label="Integration endpoint URL" value={endpoint} placeholder="https://jaeger.example.com or {{jaegerUrl}}" />}
      </TemplateVariablePopover>
      {endpointHint ? <p className="m-ui-0 text-ui-sm text-content-tertiary">{endpointHint}</p> : null}
    </div>
    <section className="space-y-ui-2"><h3 className="text-ui-md font-medium">Authentication</h3>
      <div className="overflow-hidden rounded-ui-lg border border-border-subtle"><AuthEditor auth={draft.auth} onAuthChange={(auth) => setDraft((current) => ({ ...current, auth }))} context={context} runtime={runtime} variableActions={variableActions} allowInherit={Boolean(context.workspaceProfiles?.length)} idPrefix={`integration-${value.id}`} ariaLabel="Integration authentication" /></div>
    </section>
    <section className="space-y-ui-3"><h3 className="text-ui-md font-medium">Propagation</h3>
      <SelectField label="Trace propagation" value={tracing.propagation} onValueChange={(propagation) => setTracing((current) => ({ ...current, propagation }))} options={[{ value: "off", label: "Off" }, { value: "w3c", label: "W3C Trace Context" }, { value: "b3", label: "B3" }]} />
      <details className="rounded-ui-lg border border-border-subtle"><summary className="ui-focus-ring cursor-pointer p-ui-3 text-ui-sm text-content-secondary">Custom propagation headers</summary>
        <div className="space-y-ui-3 border-t border-border-subtle py-ui-3">
          <p className="m-ui-0 px-ui-3 text-ui-sm text-content-secondary">Request headers</p>
          <p className="m-ui-0 px-ui-3 text-ui-sm text-content-tertiary">Leave empty for standard headers. Values support {'{{$traceparent}}'}, {'{{$b3}}'}, {'{{$traceId}}'}, {'{{$spanId}}'} and workspace variables.</p>
          {headerEditor("requestHeaders")}
          <p className="m-ui-0 px-ui-3 text-ui-sm text-content-secondary">Response headers</p>
          <p className="m-ui-0 px-ui-3 text-ui-sm text-content-tertiary">Map your response header name to traceparent, b3 or traceId.</p>
          {headerEditor("responseHeaders")}
        </div>
      </details>
    </section>
    {error ? <p role="alert" className="text-ui-sm text-accent-red">{error}</p> : null}
    <div className="flex justify-end gap-ui-2 border-t border-border-subtle pt-ui-4"><Button variant="brand" disabled={saving} onClick={onCancel}>Cancel</Button><Button variant="brand" disabled={saving || !ready || !name.trim() || !endpoint.trim()} onClick={() => void save()}>{saving ? "Saving…" : "Save integration"}</Button></div>
  </div>;
}
