import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadWorkspaceStore, saveWorkspaceStore } from "../services/workspace-storage";
import type { Workspace, WorkspaceStore } from "../model/workspace";

export function useWorkspaces() {
  const [store, setStore] = useState<WorkspaceStore | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const latest = useRef(store);
  latest.current = store;
  const load = useCallback(() => {
    setLoadError("");
    void loadWorkspaceStore().then(setStore).catch((error) => setLoadError(String(error)));
  }, []);
  useEffect(load, [load]);
  const flush = useCallback(async () => {
    if (!latest.current) return;
    const snapshot = latest.current;
    setSaving(true);
    try {
      await saveWorkspaceStore(snapshot);
      if (latest.current === snapshot) { setSaving(false); setSaveError(""); }
    } catch (error) { setSaving(false); setSaveError(String(error)); throw error; }
  }, []);
  useEffect(() => {
    if (!store) return;
    setSaving(true);
    const timer = setTimeout(() => { void flush().catch(() => {}); }, 180);
    return () => clearTimeout(timer);
  }, [store, flush]);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let closing = false;
    void Promise.resolve().then(() => getCurrentWindow().onCloseRequested(async (event) => {
      if (closing || !latest.current) return;
      event.preventDefault();
      try { await flush(); closing = true; await getCurrentWindow().close(); }
      catch { closing = false; /* The save error remains visible; the window stays open. */ }
    })).then((listener) => { if (disposed) listener(); else unlisten = listener; }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, [flush]);
  const updateWorkspace = useCallback((id: string, update: (workspace: Workspace) => Workspace) => {
    setStore((current) => current ? { ...current, workspaces: current.workspaces.map((workspace) => workspace.id === id ? update(workspace) : workspace) } : current);
  }, []);
  return { store, setStore, updateWorkspace, loadError, saveError, saving, retry: load, flush };
}
