import { useState, type DragEvent } from "react";
import { FileInput, FolderOpen } from "lucide-react";
import type { ImportSource, ImportTarget } from "../../../importing/contracts";
import { Button } from "../../../shared/components/ui/button";
import { Input } from "../../../shared/components/ui/input";
import { Modal } from "../../../shared/components/ui/modal";
import { cn } from "../../../shared/lib/cn";
import { useApplicationServices } from "../../../app/application-services-context";

function sourceFromLocation(location: string): ImportSource {
  const value = location.trim();
  return /^https?:\/\//i.test(value) ? { kind: "url", url: value } : { kind: "path", path: value };
}

export function ImportWorkspaceDialog({ onImport, onClose, target = "workspace" }: { onImport: (source: ImportSource) => Promise<void>; onClose: () => void; target?: ImportTarget }) {
  const { importDialog } = useApplicationServices();
  const [location, setLocation] = useState("");
  const [selectedSource, setSelectedSource] = useState<ImportSource | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const choose = async (directory: boolean) => {
    if (busy) return;
    try {
      const selected = await importDialog.choosePath(directory);
      if (!selected) return;
      setLocation(selected);
      setSelectedSource(directory ? { kind: "directory", path: selected } : { kind: "file", path: selected });
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const drop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault(); event.stopPropagation(); setDragActive(false);
    const file = event.dataTransfer.files[0] as (File & { path?: string }) | undefined;
    if (!file || busy) return;
    if (file.size > 64 * 1024 * 1024) { setError("The import source exceeds the 64 MiB safety limit."); return; }
    try {
      if (file.path) {
        setLocation(file.path); setSelectedSource({ kind: "file", path: file.path });
      } else {
        const content = await file.text();
        setLocation(file.name); setSelectedSource({ kind: "text", name: file.name, content });
      }
      setError("");
    } catch { setError("The selected import file could not be read."); }
  };
  const valid = Boolean(location.trim());
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true); setError("");
    try { await onImport(selectedSource ?? sourceFromLocation(location)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
  };

  return <Modal title={target === "environment" ? "Import environment" : "Import workspace"} onClose={() => { if (!busy) onClose(); }} className="w-ui-name-dialog">
    <form className="space-y-ui-3 p-ui-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className={cn("rounded-ui-lg border border-dashed border-border bg-purr-surface transition-colors duration-ui-fast", dragActive && "border-action-brand bg-action-brand-surface")}
        onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.stopPropagation(); setDragActive(true); } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }}
        onDrop={(event) => { void drop(event); }}>
        <button type="button" className="ui-focus-ring flex w-full flex-col items-center gap-ui-2 rounded-ui-lg p-ui-5 text-center" aria-label="Choose import file" disabled={busy} onClick={() => { void choose(false); }}>
          <FileInput className="size-ui-6 text-action-brand" />
          <span className="text-ui-md font-medium text-content-primary">Choose a file or drag it here</span>
          <span className="text-ui-xs text-content-tertiary">{target === "environment" ? "Postman environment JSON" : "OpenAPI 3.x or Postman Collection v2.0/v2.1"}</span>
        </button>
        {target === "workspace" && <div className="flex justify-center border-t border-border-subtle p-ui-1">
          <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => { void choose(true); }}><FolderOpen className="size-ui-3-5" />Choose folder instead</Button>
        </div>}
      </div>
      <label className="block space-y-ui-1 text-ui-xs text-content-secondary">File path or URL
        <Input autoFocus disabled={busy} className="ui-focus-ring w-full font-code" value={location} onChange={(event) => { setLocation(event.target.value); setSelectedSource(null); setError(""); }} placeholder={target === "environment" ? "/path/to/environment.postman_environment.json" : "/path/to/collection.postman_collection.json"} spellCheck={false} />
      </label>
      {error ? <div role="alert" className="rounded-ui-md border border-accent-red bg-purr-surface p-ui-2 text-ui-xs text-accent-red">{error}</div> : null}
      <Button type="submit" variant="brand" className="w-full" disabled={!valid || busy}>{busy ? "Importing…" : "Import"}</Button>
    </form>
  </Modal>;
}
