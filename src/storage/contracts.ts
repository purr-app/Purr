export type { SecureStore } from "../application/ports/credentials";
export type {
  FileChange,
  FilesystemWorkspaceStore,
  LocalChange,
  LocalRecord,
  LocalStateStore,
  LocalTable,
  PersistencePort,
  ProjectFile,
  StorageSnapshot,
  StoredWorkspace,
} from "../application/ports/persistence";

// Transitional internal name retained while storage callers migrate to the
// application-owned port. It is the same contract, not a parallel interface.
export type { PersistencePort as PersistenceBackend } from "../application/ports/persistence";
