import { WorkspacePersistence } from "../../../application/workspace-persistence";
import type { Workspace, WorkspaceStore } from "../model/workspace";

const loading = new WeakMap<WorkspacePersistence, Promise<WorkspaceStore>>();

export function loadWorkspaceStore(persistence: WorkspacePersistence) {
  const existing = loading.get(persistence);
  if (existing) return existing;
  const pending = persistence.load().finally(() => loading.delete(persistence));
  loading.set(persistence, pending);
  return pending;
}

export const saveWorkspaceStore = (
  persistence: WorkspacePersistence,
  store: WorkspaceStore,
) => persistence.save(store);

export const watchWorkspaceChanges = (
  persistence: WorkspacePersistence,
  onReload: (workspace: Workspace) => void,
  onError: (message: string) => void,
  current: () => WorkspaceStore | null,
) => persistence.watchChanges(onReload, onError, current);
