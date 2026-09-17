import { useState } from "react";

import { defineExtensionModule, type ExtensionDocumentEditorProps, type IntegrationSettingsProps } from "@purr/core/extension-api";
import { Button, FormField, Input } from "@purr/core/ui";
import { consumerNativeService } from "./native-service";

const counter = { value: 0, increment() { this.value += 1; return this.value; } };

function ConsumerPage() {
  const [count, setCount] = useState(counter.value);
  const [native, setNative] = useState("not called");
  return <main className="h-full overflow-auto bg-purr-base p-ui-6 font-ui text-content-primary">
    <h1 className="m-ui-0 text-ui-xl font-semibold">External consumer page</h1>
    <p>Module service: <span className="font-code">{count}</span></p>
    <div className="flex gap-ui-2">
      <Button onClick={() => setCount(counter.increment())}>Run module service</Button>
      <Button variant="secondary" onClick={() => void consumerNativeService.ping().then(setNative).catch(() => setNative("native unavailable"))}>Call native plugin</Button>
    </div>
    <p role="status" className="font-code text-ui-sm text-content-secondary">{native}</p>
  </main>;
}

function ConsumerDocument({ document, onChange }: ExtensionDocumentEditorProps) {
  const value = typeof document.config.message === "string" ? document.config.message : "";
  return <main aria-label="External protocol editor" className="h-full bg-purr-base p-ui-6 font-ui text-content-primary">
    <h1 className="m-ui-0 text-ui-lg font-semibold">External protocol</h1>
    <FormField label="Message" value={value} onChange={(event) => onChange({ configVersion: 1, config: { message: event.target.value } })} />
  </main>;
}

function ConsumerIntegrationSettings({ value, onSave, onCancel }: IntegrationSettingsProps) {
  const [name, setName] = useState(value.name);
  return <div className="space-y-ui-3 rounded-ui-lg border border-border-subtle p-ui-4">
    <h3 className="m-ui-0 text-ui-md font-medium">Consumer trace fixture</h3>
    <label className="block text-ui-sm">Name<Input aria-label="Consumer integration name" value={name} onChange={(event) => setName(event.target.value)} /></label>
    <div className="flex justify-end gap-ui-2">
      <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      <Button disabled={!name.trim()} onClick={() => void onSave({ ...value, name: name.trim(), configVersion: 1, config: { fixture: true } })}>Save integration</Button>
    </div>
  </div>;
}

export const consumerModule = defineExtensionModule({
  manifest: { id: "consumer.fixture", extensionApi: 1, version: "1.0.0" },
  register(registrar) {
    registrar.integrations.register({ id: "consumer.fixture", label: "Consumer trace provider", initialConfig: { fixture: true }, Settings: ConsumerIntegrationSettings });
    registrar.pages.register({ id: "home", routeSegment: "home", title: "Consumer",
      navigation: { area: "primary", label: "External consumer", order: 20 }, create: () => ({ component: ConsumerPage }) });
    registrar.documentTypes.register({ extensionType: "consumer.fixture.protocol", label: "External protocol",
      validateAndMigrate(configVersion, config) {
        if (configVersion !== 1 || typeof config.message !== "string") throw new Error("Invalid external protocol config");
        return { configVersion, config };
      },
      create: () => ({ editor: ConsumerDocument, createNew: () => ({ name: "External protocol", configVersion: 1, config: { message: "hello" } }) }),
    });
  },
});
