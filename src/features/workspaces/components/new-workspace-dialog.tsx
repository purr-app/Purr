import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { useApplicationServices } from "../../../app/application-services-context";
import { createWorkspace } from "../model/workspace";
import { Button } from "../../../shared/components/ui/button";
import { Input } from "../../../shared/components/ui/input";
import { Checkbox } from "../../../shared/components/ui/checkbox";
import { Modal } from "../../../shared/components/ui/modal";
import type { Workspace } from "../model/workspace";

export function ProjectDirectoryField({ value, onChange, disabled = false }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const { importDialog } = useApplicationServices();
  const [error, setError] = useState("");
  return <div className="space-y-ui-1">
    <label className="block space-y-ui-2 text-ui-sm text-content-secondary">Project directory
      <div className="flex items-center gap-ui-2"><Input aria-label="Project directory" className="ui-focus-ring min-w-0 font-code" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} spellCheck={false} placeholder="/path/to/project" />
        <Button variant="secondary" type="button" disabled={disabled} aria-label="Choose project directory" title="Choose project directory" onClick={() => { void importDialog.choosePath(true).then((path) => { if (path) { onChange(path); setError(""); } }).catch((cause) => setError(String(cause))); }}><FolderOpen className="size-ui-4" /></Button>
      </div>
    </label>
    {error && <p role="alert" className="text-ui-xs text-accent-red">{error}</p>}
  </div>;
}

export function NewWorkspaceDialog({ onCreate, onClose }: { onCreate: (workspace: Workspace, directory: string, initializeGit: boolean) => Promise<void>; onClose: () => void }) {
  const { persistence, runtime } = useApplicationServices();
  const [workspace] = useState(() => createWorkspace(""));
  const [name, setName] = useState(""); const [directory, setDirectory] = useState(""); const [initializeGit, setInitializeGit] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => { if (runtime.kind === "desktop") void persistence.directoryInfo(workspace.id).then((info) => { if (!info || typeof info.directory !== "string") throw new Error("Cannot read the default project directory."); setDirectory((current) => current || info.directory); }).catch((cause) => setError(String(cause))); }, [persistence, workspace.id, runtime.kind]);
  return <Modal title="New workspace" onClose={() => { if (!busy) onClose(); }} className="w-ui-name-dialog">
    <form className="space-y-ui-4 p-ui-5" onSubmit={(event) => { event.preventDefault(); if (!name.trim() || busy) return; setBusy(true); setError(""); void onCreate({ ...workspace, name: name.trim() }, directory.trim(), initializeGit).catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }); }}>
      <label className="block space-y-ui-2 text-ui-sm text-content-secondary">Workspace name<Input className="ui-focus-ring" autoFocus aria-label="Workspace name" maxLength={160} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} required /></label>
      {runtime.kind === "desktop" && <><ProjectDirectoryField value={directory} onChange={setDirectory} disabled={busy} /><Checkbox label="Initialize Git" checked={initializeGit} onCheckedChange={setInitializeGit} disabled={busy} /></>}
      {error && <p role="alert" className="text-ui-sm text-accent-red">{error}</p>}
      <div className="flex justify-end gap-ui-2"><Button variant="ghost" type="button" disabled={busy} onClick={onClose}>Cancel</Button><Button variant="brand" type="submit" disabled={busy || !name.trim() || runtime.kind === "desktop" && !directory.trim()}>{busy ? "Creating…" : "Create"}</Button></div>
    </form>
  </Modal>;
}
