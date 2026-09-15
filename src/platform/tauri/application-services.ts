import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { z } from "zod";

import { defaultResponseStoragePolicy, type HttpTransportOptions, type HttpTransportResponse } from "../../application/ports/http";
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
import type { ResponseContentPort } from "../../application/ports/response-content";
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

const contentInfoSchema = z.object({
  size: z.number().int().nonnegative(),
  mediaType: z.string().optional(),
  textEncoding: z.string().optional(),
});
const contentWindowSchema = z.object({
  offset: z.number().int().nonnegative(),
  bytesRead: z.number().int().nonnegative(),
  content: z.string(),
  complete: z.boolean(),
});
const linePageSchema = z.object({
  lines: z.array(z.string()),
  nextCursor: z.string().optional(),
  complete: z.boolean(),
});

const contentReferenceSchema = z.object({
  id: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  mediaType: z.string().optional(),
  charset: z.string().optional(),
  complete: z.boolean(),
});
const transportMetadataSchema = z.object({
  status: z.number().int(),
  statusText: z.string(),
  headers: z.array(z.tuple([z.string(), z.string()])),
  durationMs: z.number().nonnegative(),
  headersDurationMs: z.number().nonnegative().optional(),
  downloadDurationMs: z.number().nonnegative().optional(),
  httpVersion: z.string().optional(),
  localAddress: z.string().optional(),
  remoteAddress: z.string().optional(),
  pipelineTimings: z.object({
    setupMs: z.number().finite().nonnegative(),
    networkMs: z.number().finite().nonnegative(),
    encryptionMs: z.number().finite().nonnegative(),
    sqliteWriteMs: z.number().finite().nonnegative(),
    storageBackpressureMs: z.number().finite().nonnegative(),
    nativeTotalMs: z.number().finite().nonnegative(),
  }).optional(),
});
const transportResponseSchema = z.union([
  transportMetadataSchema.extend({ bodyBase64: z.string() }),
  transportMetadataSchema.extend({ content: contentReferenceSchema }),
]);

const nativeHttpEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("headers"),
    totalBytes: z.number().finite().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("progress"),
    receivedBytes: z.number().finite().nonnegative(),
    totalBytes: z.number().finite().nonnegative().optional(),
  }),
  z.object({ type: z.literal("complete") }),
]);

function supportsTauriChannels() {
  return typeof (globalThis as typeof globalThis & {
    window?: { __TAURI_INTERNALS__?: { transformCallback?: unknown } };
  }).window?.__TAURI_INTERNALS__?.transformCallback === "function";
}

async function startHttp(
  request: HttpRequestSnapshot,
  options?: HttpTransportOptions,
): Promise<HttpTransportResponse> {
  options?.signal?.throwIfAborted();
  const operationId = crypto.randomUUID();
  const invokedAt = performance.now();
  const cancel = () => {
    void invoke<void>("cancel_http", { operationId }).catch(() => {});
  };
  options?.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const channel = supportsTauriChannels()
      ? new Channel<unknown>((candidate) => {
          const parsed = nativeHttpEventSchema.safeParse(candidate);
          if (!parsed.success) return;
          const event = parsed.data;
          if (event.type === "headers")
            options?.onProgress?.({ receivedBytes: 0, totalBytes: event.totalBytes });
          if (event.type === "progress")
            options?.onProgress?.({ receivedBytes: event.receivedBytes, totalBytes: event.totalBytes });
        })
      : undefined;
    const response = await invoke<unknown>("start_http", {
      operationId,
      request: {
        ...request,
        responseStorage: options?.responseStorage ?? defaultResponseStoragePolicy,
      },
      ...(channel ? { onEvent: channel } : {}),
    });
    const parsed = transportResponseSchema.parse(response) as HttpTransportResponse;
    if (!parsed.pipelineTimings) return parsed;
    return {
      ...parsed,
      pipelineTimings: {
        ...parsed.pipelineTimings,
        ipcMs: Math.max(0, performance.now() - invokedAt - parsed.pipelineTimings.nativeTotalMs),
      },
    };
  } finally {
    options?.signal?.removeEventListener("abort", cancel);
  }
}

function rejectAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

class TauriResponseContent implements ResponseContentPort {
  async inspect(reference: ResponseContentRef, signal?: AbortSignal) {
    rejectAborted(signal);
    return contentInfoSchema.parse(
      await invoke("response_content_inspect", { reference }),
    );
  }

  async readRange(
    reference: ResponseContentRef,
    range: { offset: number; length: number },
    mode: "bytes" | "text" | "hex" | "base64",
    signal?: AbortSignal,
  ) {
    rejectAborted(signal);
    return contentWindowSchema.parse(
      await invoke("response_content_read_range", { reference, range, mode }),
    );
  }

  async readLines(
    reference: ResponseContentRef,
    cursor: string | undefined,
    limit: number,
    signal?: AbortSignal,
  ) {
    rejectAborted(signal);
    return linePageSchema.parse(
      await invoke("response_content_read_lines", {
        reference,
        cursor,
        limit,
      }),
    );
  }

  search = unavailableContent;
  format = unavailableContent;
  query = unavailableContent;
  save = unavailableContent;

  async release(reference: ResponseContentRef) {
    await invoke<void>("response_content_release", { reference });
  }
}

export function createTauriPlatformAdapters(): PlatformAdapters {
  const secureStore = new TauriSecureStore();
  return {
    persistenceBackend: new TauriPersistence(),
    secureStore,
    httpTransport: startHttp,
    responseContent: new TauriResponseContent(),
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
