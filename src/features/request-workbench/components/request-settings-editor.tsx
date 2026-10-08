import { useEffect, useState } from "react";
import { useWorkspaceIntegrations } from "../../../integrations/workspace-integrations";
import { Button } from "../../../shared/components/ui/button";
import { Input } from "../../../shared/components/ui/input";
import { SelectField } from "../../../shared/components/ui/select-field";
import { Switch } from "../../../shared/components/ui/switch";
import { SettingsRow, SettingsSection } from "../../../shared/components/ui/settings-section";
import type { RequestSettings } from "../../../domain/request-settings";
import { getRequestSettings, type RequestDraft } from "../model/request";
import { resolveRequestTracing } from "../model/request-tracing";

function NumberSetting({ label, value, min, max, disabled = false, onChange }: {
  label: string; value: number; min: number; max: number; disabled?: boolean; onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const valid = text.trim() !== "" && Number.isInteger(Number(text)) && Number(text) >= min && Number(text) <= max;
  return <Input aria-label={label} type="number" min={min} max={max} step={1} disabled={disabled}
    aria-invalid={!valid} className="ui-focus-ring w-ui-setting-control font-code" value={text}
    onChange={(event) => {
      const next = event.target.value;
      setText(next);
      const number = Number(next);
      if (next.trim() && Number.isInteger(number) && number >= min && number <= max) onChange(number);
    }} onBlur={() => { if (!valid) setText(String(value)); }} />;
}

export function RequestSettingsEditor({ draft, effectiveDraft, onChange }: {
  draft: RequestDraft; effectiveDraft: RequestDraft; onChange: (draft: RequestDraft) => void;
}) {
  const integrations = useWorkspaceIntegrations();
  const providers = integrations.traces.filter((item) => item.enabled && item.available);
  const tracing = resolveRequestTracing(draft, integrations.definitions, effectiveDraft.tracePropagation);
  const selectedProvider = providers.find((item) => item.id === draft.tracing?.integrationId) ?? (!draft.tracing?.integrationId ? providers[0] : undefined);
  const settings = getRequestSettings(draft);
  const change = (patch: Partial<RequestSettings>) => onChange({ ...draft, settings: { ...draft.settings, ...patch } });
  return <div aria-label="Request settings" className="space-y-ui-8 p-ui-4 font-ui">
    <SettingsSection title="Tracing">
      <SettingsRow label="Tracing provider" description="Connect this request to a workspace integration.">
        {!providers.length ? <Button variant="brand" onClick={integrations.addProvider}>Add provider</Button>
          : providers.length === 1 ? <span className="text-ui-md text-content-primary">{providers[0].name}</span>
            : <SelectField label="Tracing provider" value={selectedProvider?.id ?? ""} options={[...(!selectedProvider ? [{ value: "", label: "Select provider" }] : []), ...providers.map((item) => ({ value: item.id, label: item.name }))]}
              onValueChange={(integrationId) => onChange({ ...draft, tracing: { enabled: tracing.enabled, integrationId } })} />}
      </SettingsRow>
      <SettingsRow label="Enable tracing" description="Apply tracing to this request and inspect its spans.">
        <Switch label="Enable tracing for this request" checked={draft.tracing?.enabled ?? tracing.enabled} disabled={!providers.length && !(draft.tracing?.enabled ?? tracing.enabled)}
          onCheckedChange={(enabled) => onChange({ ...draft, tracing: { enabled, integrationId: (selectedProvider ?? providers[0])?.id } })} />
      </SettingsRow>
    </SettingsSection>
    <SettingsSection title="Redirects">
      <SettingsRow label="Follow redirects" description="Follow 301, 302, 303, 307 and 308 responses automatically.">
        <Switch label="Follow redirects" checked={settings.followRedirects} onCheckedChange={(followRedirects) => change({ followRedirects })} />
      </SettingsRow>
      <SettingsRow label="Maximum redirects" description="Stop with an error when this limit is exceeded. From 0 to 50; default 10.">
        <NumberSetting label="Maximum redirects" value={settings.maxRedirects} min={0} max={50} disabled={!settings.followRedirects} onChange={(maxRedirects) => change({ maxRedirects })} />
      </SettingsRow>
    </SettingsSection>
    <SettingsSection title="Connection">
      <SettingsRow label="Maximum timeout" description="Total network time across redirects, including the response body. 1–3,600,000 ms; default 60,000 ms.">
        <NumberSetting label="Maximum timeout (ms)" value={settings.timeoutMs} min={1} max={3_600_000} onChange={(timeoutMs) => change({ timeoutMs })} />
      </SettingsRow>
      <SettingsRow label="Validate TLS certificates" description="Verify HTTPS certificate trust and hostname. Disable only for a trusted development server.">
        <Switch label="Validate TLS certificates" checked={settings.validateTlsCertificates} onCheckedChange={(validateTlsCertificates) => change({ validateTlsCertificates })} />
      </SettingsRow>
      <SettingsRow label="HTTP version" description="Auto negotiates with the server. HTTP/2 requires server support and does not fall back to HTTP/1.1.">
        <SelectField label="HTTP version" size="lg" className="w-ui-setting-control" value={settings.httpVersion} options={[
          { value: "auto", label: "Auto" }, { value: "http1", label: "HTTP/1.1" }, { value: "http2", label: "HTTP/2" },
        ]} onValueChange={(httpVersion) => change({ httpVersion })} />
      </SettingsRow>
    </SettingsSection>
    <SettingsSection title="Cookies">
      <SettingsRow label="Automatically send cookies" description="Attach matching cookies from the workspace jar. Explicit Cookie headers are still sent.">
        <Switch label="Automatically send cookies" checked={draft.useCookieJar} onCheckedChange={(useCookieJar) => onChange({ ...draft, useCookieJar, settings: { ...draft.settings, storeCookies: settings.storeCookies } })} />
      </SettingsRow>
      <SettingsRow label="Automatically store cookies" description="Save Set-Cookie headers from responses and redirect hops to the workspace jar.">
        <Switch label="Automatically store cookies" checked={settings.storeCookies} onCheckedChange={(storeCookies) => change({ storeCookies })} />
      </SettingsRow>
    </SettingsSection>
  </div>;
}
