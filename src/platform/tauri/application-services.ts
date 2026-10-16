import { nativeSecretTransfer } from "./secret-transfer";
import { getVersion } from "@tauri-apps/api/app";
import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { externalHttpUrl } from "../../shared/lib/external-url";
import { z } from "zod";

import { defaultResponseStoragePolicy, type HttpTransportOptions, type HttpTransportResponse, type PreparedHttpTransportRequest, type RequestFileRef } from "../../application/ports/http";
import type { PlatformAdapters } from "../../application/ports/platform";
import type {
  FileChange,
  LocalChange,
  PersistencePort,
  ProjectFile,
  StorageSnapshot,
  StoredWorkspace,
  WorkspaceDeletionResult,
} from "../../application/ports/persistence";
import { commitRejection, isCommitRejected, RecoveryRequiredError, type CommitState, type SecretBatch, type SecretResolution, type SecretSnapshot, type SecureStore } from "../../application/ports/credentials";
import type {
  FormatRequest,
  JsonQueryRequest,
  ResponseContentPort,
  SearchQuery,
} from "../../application/ports/response-content";
import type { ResponseContentRef } from "../../domain/http";
import type { SecretRef } from "../../domain/project";
import { getLocalAttachmentReference } from "../../storage/file-codec";
import { tauriObservability } from "./observability";
import { tauriAttachments } from "./attachments";
import { tauriHistory } from "./history";

class TauriSecureStore implements SecureStore {
  inspect(references: readonly SecretRef[]) { return invoke<import("../../application/ports/credentials").SecretInspection[]>("secure_inspect", { references }); }
  async resolve(reference: SecretRef): Promise<SecretResolution> {
    try { return await invoke<SecretResolution>("secure_resolve", { reference }); }
    catch { return { status: "unavailable", code: "secure-resolution-unavailable", retryable: true }; }
  }
  read(reference: SecretRef) { return invoke<SecretSnapshot>("secure_read", { reference }); }
  operationStatus(operationId: string) { return invoke<CommitState>("secure_operation_status", { operationId }); }
  async commit(batch: SecretBatch) { await confirmedCommit(() => invoke<void>("secure_commit", { batch }), batch); }
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

async function confirmedCommit<T>(work: () => Promise<T>, batch: SecretBatch, committed?: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (isCommitRejected(error)) throw commitRejection(error);
    let status: CommitState;
    try { status = await invoke<CommitState>("secure_operation_status", { operationId: batch.operationId }); }
    catch { throw new RecoveryRequiredError(batch.operationId); }
    if (status.status === "committed") return committed ? committed() : undefined as T;
    if (status.status === "recovery-required") throw new RecoveryRequiredError(batch.operationId);
    throw error;
  }
}

class TauriPersistence implements PersistencePort {
  readonly history = tauriHistory;
  readonly attachments = tauriAttachments;
  private cache = new Map<string, Record<string, ProjectFile>>();

  async load() {
    const snapshot = await invoke<StorageSnapshot>("load_persistence");
    for (const workspace of snapshot.workspaces)
      this.cache.set(workspace.id, workspace.files);
    return snapshot;
  }

  async retryProtectedStorage() {
    const snapshot = await invoke<StorageSnapshot>("retry_protected_storage");
    this.cache.clear();
    for (const workspace of snapshot.workspaces) this.cache.set(workspace.id, workspace.files);
    return snapshot;
  }

  async loadWorkspace(id: string) {
    const workspace = await invoke<StoredWorkspace>("load_project", { id });
    this.cache.set(id, workspace.files);
    return workspace;
  }

  async readLocal(id: string) {
    const workspace = await this.loadWorkspace(id);
    if (workspace.protectedState && workspace.protectedState.status !== "available")
      throw new Error(workspace.protectedState.code);
    return workspace.local;
  }

  async commit(id: string, files: FileChange[], local: LocalChange[], secrets: SecretBatch = { operationId: crypto.randomUUID(), mutations: [] }) {
    const changed = await confirmedCommit(() => invoke<Record<string, ProjectFile | null>>(
      "commit_project",
      { id, files, local, secrets },
    ), secrets, async () => (await invoke<StoredWorkspace>("load_project", { id })).files);
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

  async writeGlobal(local: LocalChange[], secrets: SecretBatch = { operationId: crypto.randomUUID(), mutations: [] }) {
    await confirmedCommit(() => invoke<void>("write_global_state", { local, secrets }), secrets);
  }

  async deleteWorkspace(id: string) {
    const batch = { operationId: crypto.randomUUID(), mutations: [] };
    const request = () => invoke<WorkspaceDeletionResult>("delete_project", { id, operationId: batch.operationId });
    const result = await confirmedCommit(request, batch, request);
    this.cache.delete(id);
    return result;
  }

  finishMigration() {
    return invoke<void>("finish_legacy_migration");
  }

  async readAttachment(workspaceId: string, attachmentId: string) {
    const result = await invoke<ArrayBuffer | Uint8Array>(
      "read_local_attachment",
      { workspaceId, attachmentId },
    );
    return result instanceof Uint8Array ? result : new Uint8Array(result);
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

  inspectDirectory(directory: string, optional = false) {
    return invoke<StoredWorkspace | null>("read_project_directory", { directory, optional });
  }

  async openDirectory(directory: string, expectedRevisions: Record<string, string>) {
    const workspace = await invoke<StoredWorkspace>("open_project_directory", { directory, expectedRevisions });
    this.cache.set(workspace.id, workspace.files);
    return workspace;
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

const contentInfoSchema = z.object({
  size: z.number().int().nonnegative(),
  mediaType: z.string().optional(),
  textEncoding: z.string().optional(),
  lineCount: z.number().int().nonnegative().optional(),
  maxLineBytes: z.number().int().nonnegative().optional(),
});
const contentWindowSchema = z.object({
  offset: z.number().int().nonnegative(),
  bytesRead: z.number().int().nonnegative(),
  content: z.string(),
  complete: z.boolean(),
});
const linePageSchema = z.object({
  offset: z.number().int().nonnegative(),
  bytesRead: z.number().int().nonnegative(),
  segments: z.array(z.object({
    byteOffset: z.number().int().nonnegative(),
    byteLength: z.number().int().nonnegative(),
    lineStartOffset: z.number().int().nonnegative().optional(),
    hiddenBytes: z.number().int().nonnegative().optional(),
    suffix: z.string().optional(),
    text: z.string(),
    continuesFromPrevious: z.boolean(),
    continuesToNext: z.boolean(),
  })),
  previousCursor: z.string().optional(),
  nextCursor: z.string().optional(),
  complete: z.boolean(),
});

const contentReferenceSchema = z.object({
  id: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  mediaType: z.string().optional(),
  charset: z.string().optional(),
  lineCount: z.number().int().nonnegative().optional(),
  maxLineBytes: z.number().int().nonnegative().optional(),
  complete: z.boolean(),
});
const searchPageSchema = z.object({
  matches: z.array(z.object({
    byteOffset: z.number().int().nonnegative(),
    byteLength: z.number().int().nonnegative().optional(),
    line: z.number().int().nonnegative().optional(),
    snippet: z.string(),
  })),
  nextCursor: z.string().optional(),
  totalKnown: z.number().int().nonnegative().optional(),
});
const contentOperationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("value"), value: z.unknown() }),
  z.object({ kind: z.literal("window"), window: contentWindowSchema }),
  z.object({ kind: z.literal("content"), reference: contentReferenceSchema }),
]);
const transportMetadataSchema = z.object({
  injectedTraceHeaders: z.array(z.tuple([z.string().max(64), z.string().max(128)])).max(4).optional(),
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
  request: PreparedHttpTransportRequest,
  options?: HttpTransportOptions,
): Promise<HttpTransportResponse> {
  options?.signal?.throwIfAborted();
  const workspaceId = options?.workspaceId;
  if (!workspaceId || !/^[a-zA-Z0-9_-]{1,128}$/.test(workspaceId))
    throw new Error("A workspace is required for protected response storage.");
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
        workspaceId,
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

async function invokeContentOperation(
  command: string,
  arguments_: Record<string, unknown>,
  signal?: AbortSignal,
) {
  rejectAborted(signal);
  const operationId = crypto.randomUUID();
  const cancel = () => {
    void invoke("cancel_response_content_operation", { operationId }).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = await invoke<unknown>(command, { operationId, ...arguments_ });
    if (signal?.aborted) {
      const parsed = contentOperationResultSchema.safeParse(result);
      if (parsed.success && parsed.data.kind === "content") {
        void invoke("response_content_release", { reference: parsed.data.reference }).catch(() => {});
      }
    }
    rejectAborted(signal);
    return result;
  } catch (cause) {
    rejectAborted(signal);
    throw cause;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
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

  async search(
    reference: ResponseContentRef,
    query: SearchQuery,
    cursor?: string,
    signal?: AbortSignal,
  ) {
    return searchPageSchema.parse(
      await invokeContentOperation(
        "response_content_search",
        { reference, query, cursor },
        signal,
      ),
    );
  }

  async format(
    reference: ResponseContentRef,
    request: FormatRequest,
    signal?: AbortSignal,
  ) {
    return contentOperationResultSchema.parse(
      await invokeContentOperation(
        "response_content_format",
        { reference, request },
        signal,
      ),
    );
  }

  async query(
    reference: ResponseContentRef,
    request: JsonQueryRequest,
    signal?: AbortSignal,
  ) {
    return contentOperationResultSchema.parse(
      await invokeContentOperation(
        "response_content_query",
        { reference, request },
        signal,
      ),
    );
  }
  save(reference: ResponseContentRef, suggestion: { fileName: string; mediaType: string }) {
    return invoke<string | null>("response_content_save", { reference, suggestion });
  }

  mediaUrl(reference: ResponseContentRef) {
    return convertFileSrc(reference.id, "purr-content");
  }

  async release(reference: ResponseContentRef) {
    await invoke<void>("response_content_release", { reference });
  }
}

export function createTauriPlatformAdapters(): PlatformAdapters {
  const secureStore = new TauriSecureStore();
  return {
    observability: tauriObservability,
    persistenceBackend: new TauriPersistence(),
    secureStore,
    secretTransfer: nativeSecretTransfer,
    httpTransport: startHttp,
    responseContent: new TauriResponseContent(),
    oauthCallback: {
      authorize: (input) => invoke<string>("authorize_oauth", input),
      cancel: (sessionId) => invoke<void>("cancel_oauth", { sessionId }),
    },
    imports: {
      normalize: (source, workspaceId, target = "workspace") =>
        invoke("import_collection", { source, workspaceId, target, importId: crypto.randomUUID() }),
    },
    downloads: {
      saveInlineResponse: (bodyBase64, suggestedName, _mediaType, options) => {
        const extension = suggestedName.match(/\.([a-z0-9]{1,12})$/i)?.[1];
        return invoke<string | null>("save_response_body", {
          bodyBase64,
          suggestedName,
          extension: extension ?? "bin",
          dialogTitle: options?.dialogTitle,
        });
      },
    },
    requestBodies: {
      stage: async (file, signal) => {
        signal?.throwIfAborted();
        const local = getLocalAttachmentReference(file);
        if (local) {
          const reference = await invoke<RequestFileRef>("request_file_from_attachment", {
            workspaceId: local.workspaceId,
            attachmentId: local.attachmentId,
          });
          if (signal?.aborted) {
            await invoke<void>("request_file_release", { reference }).catch(() => {});
            signal.throwIfAborted();
          }
          return reference;
        }
        const pending = await invoke<RequestFileRef>("request_file_create", {
          name: file.name,
          size: file.size,
          mediaType: file.type || "application/octet-stream",
        });
        try {
          const chunkBytes = 256 * 1024;
          for (let offset = 0; offset < file.size; offset += chunkBytes) {
            signal?.throwIfAborted();
            const chunk = new Uint8Array(
              await file.slice(offset, Math.min(file.size, offset + chunkBytes)).arrayBuffer(),
            );
            await invoke<void>("request_file_append", chunk, {
              headers: {
                "x-purr-file-id": pending.id,
                "x-purr-file-offset": String(offset),
              },
            });
          }
          signal?.throwIfAborted();
          const reference = await invoke<RequestFileRef>("request_file_finish", {
            reference: pending,
          });
          signal?.throwIfAborted();
          return reference;
        } catch (cause) {
          await invoke<void>("request_file_release", { reference: pending }).catch(() => {});
          throw cause;
        }
      },
      release: (reference) => invoke<void>("request_file_release", { reference }),
    },
    importDialog: {
      choosePath: async (directory) => {
        const selected = await open({ directory, multiple: false });
        return typeof selected === "string" ? selected : null;
      },
    },
    workspaceShell: {
      openExternalUrl: (url) => openUrl(externalHttpUrl(url)),
      openWorkspaceFolder: (id) =>
        invoke<void>("open_project_folder", { id }),
    },
    lifecycle: {
      version: getVersion,
      observeFullscreen: async (listener) => {
        const window = getCurrentWindow();
        let active = true;
        let revision = 0;
        const update = async () => {
          const requested = ++revision;
          const fullscreen = await window.isFullscreen();
          if (active && requested === revision) listener(fullscreen);
        };
        const unlisten = await window.onResized(() => {
          // Keep the last known state if the window closes during the query.
          void update().catch(() => {});
        });
        try { await update(); }
        catch (error) { active = false; unlisten(); throw error; }
        return () => { active = false; unlisten(); };
      },
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
