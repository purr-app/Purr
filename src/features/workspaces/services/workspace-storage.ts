import { invoke, isTauri } from "@tauri-apps/api/core";
import { WorkspacePersistence } from "../../../application/workspace-persistence";
import { BrowserPersistenceBackend, BrowserSecureStore } from "../../../storage/browser-backend";
import { NativePersistenceBackend, NativeSecureStore } from "../../../storage/native-backend";
import type { Workspace, WorkspaceStore } from "../model/workspace";

let persistence: WorkspacePersistence | undefined;
export function workspacePersistence() {
  return persistence ??= isTauri()
    ? new WorkspacePersistence(new NativePersistenceBackend(), new NativeSecureStore())
    : new WorkspacePersistence(new BrowserPersistenceBackend(), new BrowserSecureStore());
}
let loading: Promise<WorkspaceStore> | undefined;
export const loadWorkspaceStore = () => loading ??= workspacePersistence().load().finally(() => { loading = undefined; });
export const saveWorkspaceStore = (store: WorkspaceStore) => workspacePersistence().save(store);
export const watchWorkspaceChanges = (onReload: (workspace: Workspace) => void, onError: (message: string) => void, current: () => WorkspaceStore | null) => workspacePersistence().watchChanges(onReload, onError, current);
export async function openWorkspaceFolder(id: string): Promise<void> { if (isTauri()) await invoke("open_project_folder", { id }); }
