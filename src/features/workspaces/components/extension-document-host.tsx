import { AlertTriangle, Unplug } from "lucide-react";
import { useEffect, useMemo } from "react";

import type { ExtensionDocumentDefinition } from "../../../domain/project";
import type { RegisteredDocumentType } from "../../../extension-api/registry";
import type { ExtensionDocument } from "../model/workspace";

export function ExtensionDocumentHost({ document, registration, onChange }: {
  document: ExtensionDocument;
  registration?: RegisteredDocumentType;
  onChange: (change: Pick<ExtensionDocument, "configVersion" | "config">) => void;
}) {
  const validation = useMemo(() => {
    if (!registration) return null;
    try { return { value: registration.validateAndMigrate(document.configVersion, document.config) }; }
    catch (cause) { return { error: cause instanceof Error ? cause.message : String(cause) }; }
  }, [document.config, document.configVersion, registration]);
  useEffect(() => {
    if (!validation?.value) return;
    if (validation.value.configVersion !== document.configVersion || JSON.stringify(validation.value.config) !== JSON.stringify(document.config))
      onChange(validation.value);
  }, [document.config, document.configVersion, onChange, validation]);
  if (!registration) return <section aria-label="Unavailable extension document" className="flex h-full min-h-0 items-center justify-center bg-purr-base p-ui-6">
    <div className="max-w-ui-dialog rounded-ui-xl border border-border-subtle bg-purr-surface p-ui-6 text-center">
      <Unplug className="mx-auto size-ui-6 text-content-tertiary" />
      <h1 className="mb-ui-0 mt-ui-3 text-ui-lg font-semibold text-content-primary">Extension unavailable</h1>
      <p className="mb-ui-0 mt-ui-2 text-ui-sm text-content-tertiary">This build does not provide <span className="font-code text-content-secondary">{document.extensionType}</span>. Purr will preserve its configuration; you can still rename, move, or delete the document.</p>
    </div>
  </section>;
  if (validation?.error) return <section aria-label="Invalid extension document" className="flex h-full min-h-0 items-center justify-center bg-purr-base p-ui-6">
    <div className="max-w-ui-dialog rounded-ui-xl border border-accent-red bg-purr-surface p-ui-6 text-center">
      <AlertTriangle className="mx-auto size-ui-6 text-accent-red" />
      <h1 className="mb-ui-0 mt-ui-3 text-ui-lg font-semibold text-content-primary">Extension configuration is invalid</h1>
      <p role="alert" className="mb-ui-0 mt-ui-2 text-ui-sm text-accent-red">{validation.error}</p>
    </div>
  </section>;
  const Editor = registration.controller.editor;
  const definition: ExtensionDocumentDefinition = { id: document.id, name: document.name, kind: "extension", extensionType: document.extensionType,
    configVersion: validation!.value!.configVersion, config: validation!.value!.config,
    ...(document.description ? { description: document.description } : {}), ...(document.folderId ? { folderId: document.folderId } : {}) };
  return <Editor document={definition} onChange={onChange} />;
}
