import { useCallback, useEffect, useRef, useState } from "react";
import { saveBeforeApplicationExit } from "../../../application/application-close";
import { loadWorkspaceStore, saveWorkspaceStore, watchWorkspaceChanges } from "../services/workspace-storage";
import { comparableDefinitionState, createWorkspace, type Workspace, type WorkspaceStore } from "../model/workspace";
import { useApplicationServices } from "../../../app/application-services-context";
import type { SecretPreparationStore } from "../../../storage/secrets";
import { CommitRejectedError, RecoveryRequiredError } from "../../../application/ports/credentials";

const needsRecovery = (error: unknown) => error instanceof RecoveryRequiredError || error instanceof CommitRejectedError && error.recoveryRequired;

export function useWorkspaces() {
  const { lifecycle, persistence } = useApplicationServices();
  const [store, setStore] = useState<WorkspaceStore | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saveNeedsRecovery, setSaveNeedsRecovery] = useState(false);
  const [saving, setSaving] = useState(false);
  const pendingExplicit = useRef<{ candidate: Workspace; before?: Workspace; upgrade: boolean; secrets?: SecretPreparationStore } | null>(null);
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
    const watchError = (message: string) => { setSaveError(message); setSaveNeedsRecovery(false); };
    void watchWorkspaceChanges(persistence, (workspace) => setStore((current) => current ? { ...current, workspaces: current.workspaces.map((item) => item.id === workspace.id ? workspace : item) } : current), watchError, () => latest.current)
      .then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; }).catch(() => watchError("Project file watching is unavailable. Reload before editing external changes."));
    return () => { disposed = true; stop?.(); };
  }, [persistence]);
  const flush = useCallback(async () => {
    if (!latest.current) return;
    const snapshot = latest.current;
    setSaving(true);
    try {
      await saveWorkspaceStore(persistence, snapshot);
      if (latest.current === snapshot) { setSaving(false); if (!pendingExplicit.current) { setSaveError(""); setSaveNeedsRecovery(false); } }
    } catch (error) { setSaving(false); setSaveError(String(error)); setSaveNeedsRecovery(needsRecovery(error)); throw error; }
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
    setStore((current) => current ? { ...current, workspaces: current.workspaces.map((workspace) => {
      if (workspace.id !== id) return workspace;
      const next = update(workspace);
      if (persistence.getWorkspaceStatus(id).publicWritable) return next;
      // Navigation remains in memory while the protected baseline is unavailable.
      return { ...workspace, ui: next.ui, activeEnvironmentId: next.activeEnvironmentId, documents: workspace.documents.map((document) => {
        const proposed = next.documents.find((item) => item.id === document.id);
        return proposed && "ui" in proposed && "ui" in document ? { ...document, ui: proposed.ui } as typeof document : document;
      }) };
    }) } : current);
  }, [persistence]);
  const saveExplicitWorkspace = useCallback(async (candidate: Workspace, upgrade = false, secrets?: SecretPreparationStore) => {
    const before = latest.current?.workspaces.find((item) => item.id === candidate.id);
    pendingExplicit.current = { candidate, before, upgrade, secrets };
    setSaving(true);
    try {
      const saved = upgrade && !secrets ? await persistence.upgradeWorkspace(candidate) : await persistence.saveWorkspace(candidate, secrets, { intent: "explicit" });
      setStore((current) => current ? { ...current, workspaces: current.workspaces.map((workspace) => {
        if (workspace.id !== saved.id) return workspace;
        const concurrent = Object.fromEntries(Object.entries(workspace).filter(([key, value]) => key !== "documents" && key !== "ui" && key !== "activeEnvironmentId"
          && JSON.stringify(comparableDefinitionState(value)) !== JSON.stringify(comparableDefinitionState(before?.[key as keyof Workspace]))));
        return { ...saved, ...concurrent, ui: workspace.ui, activeEnvironmentId: workspace.activeEnvironmentId, documents: saved.documents.map((document) => {
          const live = workspace.documents.find((item) => item.id === document.id);
          const prior = before?.documents.find((item) => item.id === document.id);
          if (!live) return document;
          if ("request" in live && "request" in document && "request" in (prior ?? {}) && JSON.stringify(comparableDefinitionState(live.request)) !== JSON.stringify(comparableDefinitionState((prior as typeof live).request))) return { ...document, request: live.request, ui: live.ui };
          return "ui" in live && "ui" in document ? { ...document, ui: live.ui } as typeof document : document;
        }) };
      }) } : current);
      pendingExplicit.current = null;
      setSaveError(""); setSaveNeedsRecovery(false);
      return saved;
    } catch (error) { setSaveError(String(error)); setSaveNeedsRecovery(needsRecovery(error)); throw error; }
    finally { setSaving(false); }
  }, [persistence]);
  const retrySave = useCallback(async () => {
    const snapshot = latest.current;
    if (!snapshot) return;
    setSaving(true);
    try {
      const reconciled = await persistence.reconcileExternalChanges(snapshot);
      latest.current = reconciled;
      setStore(reconciled);
      const pending = pendingExplicit.current;
      if (pending) {
        const current = reconciled.workspaces.find((item) => item.id === pending.candidate.id);
        if (!current) throw new Error("The workspace for the pending Save is no longer available.");
        // Retry the saved definition the user approved, while retaining subsequent
        // working edits and names. Never promote those later edits implicitly.
        const changes = Object.fromEntries(Object.entries(pending.candidate).filter(([key, value]) => {
          const field = key as keyof Workspace;
          return key !== "documents" && key !== "ui" && key !== "activeEnvironmentId"
            && JSON.stringify(comparableDefinitionState(value)) !== JSON.stringify(comparableDefinitionState(pending.before?.[field]))
            && JSON.stringify(comparableDefinitionState(current[field])) === JSON.stringify(comparableDefinitionState(pending.before?.[field]));
        }));
        const candidate = { ...current, ...changes, documents: current.documents.map((document) => {
          const proposed = pending.candidate.documents.find((item) => item.id === document.id);
          const before = pending.before?.documents.find((item) => item.id === document.id);
          if (!proposed) return document;
          const name = document.name === before?.name ? proposed.name : document.name;
          if ("savedRequest" in proposed && "request" in document) return { ...document, name, saved: proposed.saved, savedRequest: proposed.savedRequest };
          if ("savedConfig" in proposed && "config" in document) return { ...document, name, saved: proposed.saved, savedConfig: proposed.savedConfig, savedConfigVersion: proposed.savedConfigVersion };
          return document;
        }) };
        await saveExplicitWorkspace(candidate, pending.upgrade, pending.secrets);
      } else await saveWorkspaceStore(persistence, reconciled);
      setSaving(false); setSaveError(""); setSaveNeedsRecovery(false);
    } catch (error) { setSaving(false); setSaveError(String(error)); setSaveNeedsRecovery(needsRecovery(error)); throw error; }
  }, [persistence, saveExplicitWorkspace]);
  const retryProtectedStorage = useCallback(async () => {
    const restored = await persistence.retryProtectedStorage();
    latest.current = restored; setStore(restored); setSaveError(""); setSaveNeedsRecovery(false);
  }, [persistence]);
  const deleteWorkspace = useCallback(async (id: string) => {
    const result = await persistence.deleteWorkspace(id);
    setStore((current) => {
      if (!current) return current;
      let workspaces = current.workspaces.filter((workspace) => workspace.id !== id);
      if (!workspaces.length) workspaces = [createWorkspace("Personal")];
      return { ...current, workspaces, activeWorkspaceId: current.activeWorkspaceId === id ? workspaces[0].id : current.activeWorkspaceId };
    });
    return result;
  }, [persistence]);
  return { store, setStore, updateWorkspace, deleteWorkspace, loadError, saveError, saveNeedsRecovery, saving, retry: load, flush, retrySave, saveExplicitWorkspace, retryProtectedStorage };
}
