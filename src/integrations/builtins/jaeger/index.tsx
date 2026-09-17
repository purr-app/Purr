import { useState } from "react";
import { defineExtensionModule, type IntegrationSettingsProps } from "../../../extension-api";
import { Button, Input, SelectField } from "../../../extension-api/ui";

function JaegerSettings({ value, onSave, onCancel, setCredential }: IntegrationSettingsProps) {
  const [name, setName] = useState(value.name);
  const [endpoint, setEndpoint] = useState(String(value.config.endpoint ?? "http://127.0.0.1:16686"));
  const [auth, setAuth] = useState(String(value.config.auth ?? "none"));
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true); setError("");
    try {
      if (token) { await setCredential("apiToken", token); setToken(""); }
      await onSave({ ...value, name: name.trim(), configVersion: 1, config: { endpoint, auth } });
    } catch { setError("Could not save. Check the endpoint, provider availability and secure storage."); }
    finally { setSaving(false); }
  }
  return <div className="space-y-ui-3 rounded-ui-lg border border-border-subtle p-ui-4">
    <h3 className="m-ui-0 text-ui-md font-medium">Jaeger integration</h3>
    <label className="block text-ui-sm">Name<Input aria-label="Integration name" value={name} onChange={(e) => setName(e.target.value)} /></label>
    <label className="block text-ui-sm">Query endpoint<Input aria-label="Jaeger endpoint" className="font-code" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} /></label>
    <p className="text-ui-xs text-content-tertiary">Use the Jaeger query server with HTTP API v3 support. A base path is supported.</p>
    <SelectField label="Integration authentication" value={auth} options={[{ value: "none", label: "None" }, { value: "bearer", label: "Bearer token" }]} onValueChange={setAuth} />
    {auth === "bearer" ? <label className="block text-ui-sm">New token<Input type="password" autoComplete="off" aria-label="Integration token" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Leave blank to keep the stored token" /></label> : null}
    {error ? <p role="alert" className="text-ui-xs text-accent-red">{error}</p> : null}
    <div className="flex justify-end gap-ui-2"><Button variant="ghost" disabled={saving} onClick={onCancel}>Cancel</Button><Button disabled={saving || !name.trim()} onClick={() => void save()}>Save integration</Button></div>
  </div>;
}
export const jaegerModule = defineExtensionModule({
  manifest: { id: "purr.jaeger", version: "1.0.0", extensionApi: 1 },
  register(registrar) { registrar.integrations.register({ id: "jaeger", label: "Jaeger", initialConfig: { endpoint: "http://127.0.0.1:16686", auth: "none" }, credentialKeys: ["apiToken"], Settings: JaegerSettings }); },
});
