import { useEffect, useState } from "react";
import { FolderOpen, MoveRight } from "lucide-react";
import { useApplicationServices } from "../../../app/application-services-context";
import { Button } from "../../../shared/components/ui/button";
import { Modal } from "../../../shared/components/ui/modal";
import { SettingsRow, SettingsSection } from "../../../shared/components/ui/settings-section";
import { ProjectDirectoryField } from "./new-workspace-dialog";

export function ProjectDirectorySettings({ workspaceId, onBeforeChange }: { workspaceId: string; onBeforeChange: () => Promise<void> }) {
  const { persistence, runtime, workspaceShell } = useApplicationServices();
  const [info, setInfo] = useState<{ directory: string; pendingMove?: string | null } | null>(null);
  const [open, setOpen] = useState(false); const [directory, setDirectory] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const refresh = () => persistence.directoryInfo(workspaceId).then(setInfo);
  useEffect(() => { if (runtime.kind === "desktop") void persistence.directoryInfo(workspaceId).then(setInfo).catch((cause) => setError(String(cause))); }, [workspaceId, persistence, runtime.kind]);
  if (runtime.kind !== "desktop") return null;
  const move = async () => { setBusy(true); setError(""); try { await onBeforeChange(); await persistence.moveDirectory(workspaceId, directory.trim()); await refresh(); setOpen(false); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); await refresh().catch(() => {}); } finally { setBusy(false); } };
  return <>
    <SettingsSection title="Project directory">
      <SettingsRow label="Location" description={info?.directory ?? "Loading project directory…"}>
        <Button variant="secondary" size="sm" title="Open project directory" onClick={() => { void workspaceShell.openWorkspaceFolder(workspaceId).catch((cause) => setError(String(cause))); }}><FolderOpen className="size-ui-4" />Open folder</Button>
        <Button variant="secondary" size="sm" disabled={!info || busy} onClick={() => { setDirectory(info?.pendingMove ?? ""); setError(""); setOpen(true); }}><MoveRight className="size-ui-4" />{info?.pendingMove ? "Resume move…" : "Move project…"}</Button>
      </SettingsRow>
      {error && !open && <p role="alert" className="text-ui-sm text-accent-red">{error}</p>}
    </SettingsSection>
    {open && <Modal title="Move project" onClose={() => { if (!busy) setOpen(false); }} className="w-ui-name-dialog">
      <form className="space-y-ui-4 p-ui-5" onSubmit={(event) => { event.preventDefault(); void move(); }}>
        <p className="text-ui-sm text-content-secondary">Move the project and its Git repository to a new or empty directory. Local history and credentials stay on this device.</p>
        <ProjectDirectoryField value={directory} onChange={setDirectory} disabled={busy || Boolean(info?.pendingMove)} />
        {error && <p role="alert" className="text-ui-sm text-accent-red">{error}</p>}
        <div className="flex flex-wrap justify-end gap-ui-2">
          {info?.pendingMove && <Button variant="ghost" type="button" disabled={busy} onClick={() => { setBusy(true); void persistence.backend.cancelMove?.(workspaceId).then(refresh).then(() => setOpen(false)).catch((cause) => setError(String(cause))).finally(() => setBusy(false)); }}>Cancel pending move</Button>}
          <Button variant="ghost" type="button" disabled={busy} onClick={() => setOpen(false)}>Close</Button><Button variant="brand" type="submit" disabled={busy || !directory.trim() || directory.trim() === info?.directory && !info?.pendingMove}>{busy ? "Moving…" : info?.pendingMove ? "Resume move" : "Move project"}</Button>
        </div>
      </form>
    </Modal>}
  </>;
}
