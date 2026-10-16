import type { AttachmentWritePort } from "./attachments";
import type { HistoryPort } from "./history";
import type { SecretBatch } from "./credentials";

export type ProtectedState = { status: "available" } | { status: "locked" | "unavailable" | "corrupt" | "denied" | "recovery-required"; code: string };

export type ProjectFile = { content: string; revision: string };
export type FileChange = {
  path: string;
  content: string | null;
  expectedRevision: string | null;
};
export type LocalTable =
  | "workspace_local_state"
  | "drafts"
  | "document_session_state"
  | "request_executions"
  | "cookie_jar"
  | "schema_cache"
  | "recent_items"
  | "attachments";
export type LocalProtection = "plaintext" | "encrypted";
export type UnavailableLocalRecord = { table: LocalTable; id: string; state: Exclude<ProtectedState, { status: "available" }> };
export type LocalRecord = { table: LocalTable; id: string; value: unknown; protection?: LocalProtection };
export type LocalChange = {
  table: LocalTable;
  id: string;
  value: unknown | null;
  protection?: LocalProtection;
};
export type StoredWorkspace = {
  id: string;
  files: Record<string, ProjectFile>;
  local: LocalRecord[];
  unavailableLocal?: UnavailableLocalRecord[];
  /** Runtime-key capability, independent of credential keys and damaged individual records. */
  runtimeProtectedState?: ProtectedState;
  /** Absence means available for old adapters. Non-available local is opaque, not empty. */
  protectedState?: ProtectedState;
};
export type StorageSnapshot = {
  globalProtectedState?: ProtectedState;
  globalUnavailableLocal?: UnavailableLocalRecord[];
  storageNotice?: { legacyDirectory: string } | null;
  activeWorkspaceId: string;
  workspaces: StoredWorkspace[];
  global?: LocalRecord[];
  legacy?: unknown;
  protectedState?: ProtectedState;
};
export type WorkspaceDeletionResult = { committed: true; cleanupPending: boolean };

export interface FilesystemWorkspaceStore {
  loadWorkspace(id: string): Promise<StoredWorkspace>;
  saveResource(
    id: string,
    change: FileChange,
  ): Promise<Record<string, ProjectFile>>;
  deleteResource(
    id: string,
    path: string,
    expectedRevision: string,
  ): Promise<void>;
  moveResource(
    id: string,
    from: string,
    to: string,
    expectedRevision: string,
  ): Promise<void>;
  reloadResource(id: string, path: string): Promise<ProjectFile | null>;
  watchChanges(
    listener: (id: string, paths: string[]) => void,
  ): Promise<() => void>;
}

export interface LocalStateStore {
  readLocal(id: string): Promise<LocalRecord[]>;
  writeLocal(id: string, changes: LocalChange[]): Promise<void>;
}

// Preparation never writes credentials. Native publication joins secret/local
// changes in one transaction after recoverable filesystem application.
export interface PersistencePort
  extends FilesystemWorkspaceStore,
    LocalStateStore {
  history?: HistoryPort;
  attachments?: AttachmentWritePort;
  load(): Promise<StorageSnapshot>;
  commit(
    id: string,
    files: FileChange[],
    local: LocalChange[],
    secrets?: SecretBatch,
  ): Promise<Record<string, ProjectFile>>;
  setActiveWorkspace(id: string): Promise<void>;
  writeGlobal(changes: LocalChange[], secrets?: SecretBatch): Promise<void>;
  deleteWorkspace(id: string): Promise<void | WorkspaceDeletionResult>;
  finishMigration(): Promise<void>;
  readAttachment?(
    workspaceId: string,
    attachmentId: string,
  ): Promise<Uint8Array>;
  attachDirectory?(
    id: string,
    directory: string,
  ): Promise<StoredWorkspace>;
  /** Inspect canonical files without registering or changing the directory. */
  inspectDirectory?(directory: string, optional?: boolean): Promise<StoredWorkspace | null>;
  /** Register only if the complete inspected file revision set still matches. */
  openDirectory?(directory: string, expectedRevisions: Record<string, string>): Promise<StoredWorkspace>;
  directoryInfo?(id: string): Promise<{ directory: string; managed: boolean }>;
  createDirectory?(id: string, directory: string, files: FileChange[], local: LocalChange[], secrets: SecretBatch): Promise<StoredWorkspace>;
  moveDirectory?(id: string, directory: string): Promise<{ directory: string; managed: boolean }>;
  retryProtectedStorage?(): Promise<StorageSnapshot>;
}
