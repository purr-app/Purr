import { useCallback, useEffect, useRef, useState } from "react";
import { saveBeforeApplicationExit } from "../../../application/application-close";
import { loadWorkspaceStore, saveWorkspaceStore, watchWorkspaceChanges } from "../services/workspace-storage";
import { createWorkspace, type Workspace, type WorkspaceStore } from "../model/workspace";
import { useApplicationServices } from "../../../app/application-services-context";

export function useWorkspaces() {
  const { lifecycle, persistence } = useApplicationServices();
  const [store, setStore] = useState<WorkspaceStore | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const latest = useRef(store);
  latest.current = store;
  const load = useCallback(() => {
    setLoadError("");
    void loadWorkspaceStore(persistence).then(setStore).catch((error) => setLoadError(String(error)));
  }, [persistence]);
  useEffect(load, [load]);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void watchWorkspaceChanges(persistence, (workspace) => setStore((current) => current ? { ...current, workspaces: current.workspaces.map((item) => item.id === workspace.id ? workspace : item) } : current), setSaveError, () => latest.current)
      .then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; }).catch(() => setSaveError("Project file watching is unavailable. Reload before editing external changes."));
    return () => { disposed = true; stop?.(); };
  }, [persistence]);
  const flush = useCallback(async () => {
    if (!latest.current) return;
    const snapshot = latest.current;
    setSaving(true);
    try {
      await saveWorkspaceStore(persistence, snapshot);
      if (latest.current === snapshot) { setSaving(false); setSaveError(""); }
    } catch (error) { setSaving(false); setSaveError(String(error)); throw error; }
  }, [persistence]);
  const retrySave = useCallback(async () => {
    const snapshot = latest.current;
    if (!snapshot) return;
    setSaving(true);
    try {
      const reconciled = await persistence.reconcileExternalChanges(snapshot);
      latest.current = reconciled;
      setStore(reconciled);
      await saveWorkspaceStore(persistence, reconciled);
      if (latest.current === reconciled) { setSaving(false); setSaveError(""); }
    } catch (error) { setSaving(false); setSaveError(String(error)); throw error; }
  }, [persistence]);
  useEffect(() => {
    if (!store) return;
    setSaving(true);
    const timer = setTimeout(() => { void flush().catch(() => {}); }, 180);
    return () => clearTimeout(timer);
  }, [store, flush]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let closing = false;
    void lifecycle.onCloseRequested(async (event) => {
      if (closing) return;
      if (!latest.current) return;
      event.preventDefault();
      closing = true;
      try { await saveBeforeApplicationExit(flush, lifecycle.exit); }
      catch { closing = false; }
    }).then((listener) => { if (disposed) listener(); else unlisten = listener; }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, [flush, lifecycle]);
  const updateWorkspace = useCallback((id: string, update: (workspace: Workspace) => Workspace) => {
    setStore((current) => current ? { ...current, workspaces: current.workspaces.map((workspace) => workspace.id === id ? update(workspace) : workspace) } : current);
  }, []);
  const deleteWorkspace = useCallback(async (id: string) => {
    await persistence.deleteWorkspace(id);
    setStore((current) => {
      if (!current) return current;
      let workspaces = current.workspaces.filter((workspace) => workspace.id !== id);
      if (!workspaces.length) workspaces = [createWorkspace("Personal")];
      return { ...current, workspaces, activeWorkspaceId: current.activeWorkspaceId === id ? workspaces[0].id : current.activeWorkspaceId };
    });
  }, [persistence]);
  return { store, setStore, updateWorkspace, deleteWorkspace, loadError, saveError, saving, retry: load, flush, retrySave };
}
