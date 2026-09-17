import { useState } from "react";

import { defineExtensionModule, type ExtensionDocumentEditorProps } from "@purr/core/extension-api";
import { Button, FormField } from "@purr/core/ui";

const service = { count: 0, increment() { this.count += 1; return this.count; } };

function FakePage() {
  const [count, setCount] = useState(service.count);
  return <main className="h-full overflow-auto bg-purr-base p-ui-6 font-ui text-content-primary">
    <h1 className="m-ui-0 text-ui-xl font-semibold">Synthetic extension page</h1>
    <p className="mb-ui-4 mt-ui-2 text-ui-sm text-content-tertiary">Module-owned service count: <span className="font-code">{count}</span></p>
    <Button onClick={() => setCount(service.increment())}>Run module action</Button>
  </main>;
}

function FakeDocumentEditor({ document, onChange }: ExtensionDocumentEditorProps) {
  const message = typeof document.config.message === "string" ? document.config.message : "";
  return <main aria-label="Synthetic protocol editor" className="h-full overflow-auto bg-purr-base p-ui-6 font-ui text-content-primary">
    <h1 className="m-ui-0 text-ui-lg font-semibold">Synthetic protocol</h1>
    <div className="mt-ui-4 max-w-ui-dialog"><FormField label="Synthetic message" value={message}
      onChange={(event) => onChange({ configVersion: 1, config: { ...document.config, message: event.target.value } })} /></div>
  </main>;
}

export const fakeExtensionModule = defineExtensionModule({
  manifest: { id: "test.fake", extensionApi: 1, version: "1.0.0" },
  register(registrar) {
    registrar.integrations.register({ id: "test.fake", label: "Synthetic provider" });
    registrar.pages.register({ id: "dashboard", routeSegment: "dashboard", title: "Synthetic dashboard",
      navigation: { area: "primary", label: "Synthetic extension", order: 10 }, create: () => ({ component: FakePage }) });
    registrar.documentTypes.register({ extensionType: "test.fake.protocol", label: "Synthetic protocol",
      validateAndMigrate(configVersion, config) {
        if (configVersion !== 1 || typeof config.message !== "string") throw new Error("Synthetic protocol requires a message.");
        return { configVersion: 1, config };
      },
      create: () => ({ editor: FakeDocumentEditor, createNew: () => ({ name: "Synthetic protocol", configVersion: 1, config: { message: "hello" } }) }),
    });
  },
});

export const fakeModuleService = service;
