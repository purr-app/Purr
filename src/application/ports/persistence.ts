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
export type LocalRecord = { table: LocalTable; id: string; value: unknown };
export type LocalChange = {
  table: LocalTable;
  id: string;
  value: unknown | null;
};
export type StoredWorkspace = {
  id: string;
  files: Record<string, ProjectFile>;
  local: LocalRecord[];
};
export type StorageSnapshot = {
  activeWorkspaceId: string;
  workspaces: StoredWorkspace[];
  global?: LocalRecord[];
  legacy?: unknown;
};

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

// The native implementation journals a commit spanning files and DB. Secrets
// are stored first, so a failed commit may leave unused refs but never plaintext
// credentials in project files.
export interface PersistencePort
  extends FilesystemWorkspaceStore,
    LocalStateStore {
  load(): Promise<StorageSnapshot>;
  commit(
    id: string,
    files: FileChange[],
    local: LocalChange[],
  ): Promise<Record<string, ProjectFile>>;
  setActiveWorkspace(id: string): Promise<void>;
  writeGlobal(changes: LocalChange[]): Promise<void>;
  deleteWorkspace(id: string): Promise<void>;
  finishMigration(): Promise<void>;
  readAttachment?(
    workspaceId: string,
    attachmentId: string,
  ): Promise<Uint8Array>;
  attachDirectory?(
    id: string,
    directory: string,
  ): Promise<StoredWorkspace>;
}
