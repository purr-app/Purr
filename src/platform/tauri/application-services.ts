import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";

import type { HttpTransportResponse } from "../../application/ports/http";
import type { PlatformAdapters } from "../../application/ports/platform";
import type {
  FileChange,
  LocalChange,
  PersistencePort,
  ProjectFile,
  StorageSnapshot,
  StoredWorkspace,
} from "../../application/ports/persistence";
import type { SecureStore } from "../../application/ports/credentials";
import type { HttpRequestSnapshot, ResponseContentRef } from "../../domain/http";
import type { SecretRef } from "../../domain/project";

class TauriSecureStore implements SecureStore {
  get(reference: SecretRef) {
    return invoke<string | null>("secure_get", { reference });
  }

  set(reference: SecretRef, value: string) {
    return invoke<void>("secure_set", { reference, value });
  }

  delete(reference: SecretRef) {
    return invoke<void>("secure_delete", { reference });
  }

  exists(reference: SecretRef) {
    return invoke<boolean>("secure_exists", { reference });
  }
}

class TauriPersistence implements PersistencePort {
  private cache = new Map<string, Record<string, ProjectFile>>();

  async load() {
    const snapshot = await invoke<StorageSnapshot>("load_persistence");
    for (const workspace of snapshot.workspaces)
      this.cache.set(workspace.id, workspace.files);
    return snapshot;
  }

  async loadWorkspace(id: string) {
    const workspace = await invoke<StoredWorkspace>("load_project", { id });
    this.cache.set(id, workspace.files);
    return workspace;
  }

  async readLocal(id: string) {
    return (await this.loadWorkspace(id)).local;
  }

  async commit(id: string, files: FileChange[], local: LocalChange[]) {
    const changed = await invoke<Record<string, ProjectFile | null>>(
      "commit_project",
      { id, files, local },
    );
    const next = { ...(this.cache.get(id) ?? {}) };
    for (const [path, file] of Object.entries(changed)) {
      if (file) next[path] = file;
      else delete next[path];
    }
    this.cache.set(id, next);
    return next;
  }

  async writeLocal(id: string, local: LocalChange[]) {
    await this.commit(id, [], local);
  }

  saveResource(id: string, change: FileChange) {
    return this.commit(id, [change], []);
  }

  async deleteResource(
    id: string,
    path: string,
    expectedRevision: string,
  ) {
    await this.commit(
      id,
      [{ path, content: null, expectedRevision }],
      [],
    );
  }

  async moveResource(
    id: string,
    from: string,
    to: string,
    expectedRevision: string,
  ) {
    const file = await this.reloadResource(id, from);
    if (!file) throw new Error("Resource does not exist");
    await this.commit(
      id,
      [
        { path: from, content: null, expectedRevision },
        { path: to, content: file.content, expectedRevision: null },
      ],
      [],
    );
  }

  async reloadResource(id: string, path: string) {
    const file = await invoke<ProjectFile | null>("reload_project_file", {
      id,
      path,
    });
    const files = { ...(this.cache.get(id) ?? {}) };
    if (file) files[path] = file;
    else delete files[path];
    this.cache.set(id, files);
    return file;
  }

  setActiveWorkspace(id: string) {
    return invoke<void>("set_local_active_workspace", { id });
  }

  writeGlobal(local: LocalChange[]) {
    return invoke<void>("write_global_state", { local });
  }

  async deleteWorkspace(id: string) {
    await invoke<void>("delete_project", { id });
    this.cache.delete(id);
  }

  finishMigration() {
    return invoke<void>("finish_legacy_migration");
  }

  watchChanges(listener: (id: string, paths: string[]) => void) {
    return listen<Array<{ id: string; paths: string[] }>>(
      "project-files-changed",
      (event) => {
        for (const change of event.payload)
          listener(change.id, change.paths);
      },
    );
  }

  async attachDirectory(id: string, directory: string) {
    const workspace = await invoke<StoredWorkspace>(
      "attach_project_directory",
      { id, directory },
    );
    this.cache.set(id, workspace.files);
    return workspace;
  }
}

const unavailableContent = () =>
  Promise.reject(
    new Error("Native response content is not available before Phase 5."),
  );

export function createTauriPlatformAdapters(): PlatformAdapters {
  const secureStore = new TauriSecureStore();
  return {
    persistenceBackend: new TauriPersistence(),
    secureStore,
    httpTransport: (request: HttpRequestSnapshot) =>
      invoke<HttpTransportResponse>("send_http", { request }),
    responseContent: {
      inspect: unavailableContent,
      readRange: unavailableContent,
      readLines: unavailableContent,
      search: unavailableContent,
      format: unavailableContent,
      query: unavailableContent,
      save: unavailableContent,
      release: async (_reference: ResponseContentRef) => unavailableContent(),
    },
    oauthCallback: {
      authorize: (input) => invoke<string>("authorize_oauth", input),
      cancel: (sessionId) => invoke<void>("cancel_oauth", { sessionId }),
    },
    imports: {
      normalize: (source, workspaceId) =>
        invoke("import_collection", { source, workspaceId }),
    },
    downloads: {
      saveInlineResponse: (bodyBase64, suggestedName) => {
        const extension = suggestedName.match(/\.([a-z0-9]{1,12})$/i)?.[1];
        return invoke<string | null>("save_response_body", {
          bodyBase64,
          suggestedName,
          extension: extension ?? "bin",
        });
      },
    },
    importDialog: {
      choosePath: async (directory) => {
        const selected = await open({ directory, multiple: false });
        return typeof selected === "string" ? selected : null;
      },
    },
    workspaceShell: {
      openWorkspaceFolder: (id) =>
        invoke<void>("open_project_folder", { id }),
    },
    lifecycle: {
      onCloseRequested: (listener) =>
        Promise.resolve().then(() =>
          getCurrentWindow().onCloseRequested((event) => listener(event)),
        ),
      exit: () => invoke<void>("exit_app"),
    },
    runtime: Object.freeze({
      kind: "desktop",
      os: /mac/i.test(navigator.platform) ? "macos" : "other",
    }),
  };
}

export { TauriPersistence as NativePersistenceBackend };
export { TauriSecureStore as NativeSecureStore };
