import type { DynamicExecutionMetadata, HistoryEntry, HistoryOutcome, HistoryPort, HistoryQuery } from "./ports/history";
import type { SecureStore } from "./ports/credentials";
import { isInlineHttpResponse, responseForPersistence, type StoredHttpResponse } from "../domain/http";
import type { RequestDraft } from "../features/request-workbench/model/request";
import { cloneRequestDraft } from "../features/workspaces/model/workspace";
import { decodeFiles, encodeFiles, type FileAttachmentRecord, type NativeFileAttachmentRecord } from "../storage/file-codec";
import { protectRuntime, resolveRuntime } from "../storage/secrets";

export type HistoryExecution = {
  documentId: string;
  name: string;
  kind: "http" | "graphql";
  editor: RequestDraft;
  response: StoredHttpResponse | null;
  error: string;
  outcome: HistoryOutcome;
  startedAt: number;
  durationMs: number;
  dynamicExecution?: DynamicExecutionMetadata;
};
export type OpenHistoryEntry = Omit<HistoryEntry, "editor"> & { editor: RequestDraft | null };
type Enqueue = <T>(work: () => Promise<T>) => Promise<T>;

/** History owns immutable executions independently of document autosave. */
export class RequestHistory {
  private listeners = new Set<() => void>();
  private revision = 0;
  private attachmentLeases = new Map<string, number>();
  constructor(private port: HistoryPort, private secure: SecureStore, private enqueue: Enqueue) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.revision;
  /** Keep native upload references alive through Send and history adoption. */
  retainAttachments(workspaceId: string): () => void {
    this.attachmentLeases.set(workspaceId, (this.attachmentLeases.get(workspaceId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.attachmentLeases.get(workspaceId) ?? 1) - 1;
      if (remaining > 0) this.attachmentLeases.set(workspaceId, remaining);
      else this.attachmentLeases.delete(workspaceId);
    };
  }
  hasPendingExecutions(workspaceId: string) { return this.attachmentLeases.has(workspaceId); }
  private changed() { this.revision += 1; this.listeners.forEach((listener) => listener()); }
  append(workspaceId: string, execution: HistoryExecution): Promise<string> {
    // Capture before joining the persistence queue: later keystrokes must not
    // change a completed execution. Files retain their immutable native handles.
    const editor = cloneRequestDraft(execution.editor);
    const response = execution.response ? structuredClone(responseForPersistence(execution.response)) : null;
    const id = crypto.randomUUID();
    const entry = { ...execution, editor, response, dynamicExecution: execution.dynamicExecution ? structuredClone(execution.dynamicExecution) : undefined };
    return this.enqueue(async () => {
      const attachments = new Map<string, FileAttachmentRecord | NativeFileAttachmentRecord>();
      const protectedEditor = await protectRuntime(editor, this.secure, workspaceId, `history/${id}/editor`);
      const encodedEditor = await encodeFiles(protectedEditor, attachments);
      const metadata = response && (isInlineHttpResponse(response) ? response : response.response);
      await this.port.append(workspaceId, {
        version: 1, id, documentId: entry.documentId, name: entry.name, kind: entry.kind,
        method: entry.kind === "graphql" ? "POST" : editor.method,
        url: response?.timeline.displayRequest?.url ?? response?.timeline.request.url ?? editor.url,
        startedAt: Math.trunc(response?.timeline.startedAtMs ?? entry.startedAt), durationMs: Math.max(0, metadata?.durationMs ?? entry.durationMs),
        outcome: entry.outcome, status: metadata?.status ?? null,
        size: response ? isInlineHttpResponse(response) ? response.size : response.content.byteLength : 0,
        pinned: false, editor: encodedEditor, response, error: entry.error,
        files: Object.fromEntries(attachments),
        ...(entry.dynamicExecution ? { dynamicExecution: entry.dynamicExecution } : {}),
      });
      this.changed();
      // Resolves only after the storage adapter has adopted response content.
      return id;
    });
  }
  list(workspaceId: string, query: HistoryQuery = {}) {
    return this.enqueue(() => this.port.list(workspaceId, query));
  }
  existing(workspaceId: string, ids: string[]) {
    return this.enqueue(() => this.port.existing(workspaceId, ids));
  }
  read(workspaceId: string, id: string): Promise<OpenHistoryEntry | null> {
    return this.enqueue(async () => {
      const entry = await this.port.read(workspaceId, id);
      if (!entry) return null;
      const decoded = entry.editor == null ? null : decodeFiles(entry.editor, new Map(Object.entries(entry.files ?? {})), workspaceId,
        this.port.readAttachment ? (attachmentId) => this.port.readAttachment!(workspaceId, attachmentId) : undefined);
      const editor = decoded ? await resolveRuntime(decoded, this.secure) as RequestDraft : null;
      return { ...entry, editor };
    });
  }
  remove(workspaceId: string, filter: { id?: string; documentId?: string } = {}) {
    return this.enqueue(async () => { await this.port.remove(workspaceId, filter); this.changed(); });
  }
  pin(workspaceId: string, id: string, pinned: boolean) {
    return this.enqueue(async () => { await this.port.pin(workspaceId, id, pinned); this.changed(); });
  }
  settings(workspaceId: string, retentionDays?: number) {
    if (retentionDays !== undefined && (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 36500))
      return Promise.reject(new Error("Retention must be between 1 and 36500 days."));
    return this.enqueue(async () => {
      const settings = await this.port.settings(workspaceId, retentionDays);
      if (retentionDays !== undefined) { await this.port.prune(workspaceId); this.changed(); }
      return settings;
    });
  }
  prune(workspaceId: string) {
    return this.enqueue(async () => { await this.port.prune(workspaceId); this.changed(); });
  }
}
