/** Git works exclusively on saved project files; editor drafts never cross this port. */
export type GitFile = { path: string; oldPath?: string; index: string; worktree: string; conflicted: boolean };
export type GitBranch = { name: string; remote: boolean; current: boolean; upstream?: string };
export type GitRemote = { name: string; url: string };
export type GitStatus = {
  directory: string; initialized: boolean; version: string; branch: string | null; head: string | null;
  upstream: string | null; ahead: number; behind: number; files: GitFile[]; branches: GitBranch[];
  remotes: GitRemote[]; operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
  lastFetched: number | null; recovery?: boolean;
};
export type GitDiffRequest = { path: string; oldPath?: string; scope: "working" | "staged" | "commit"; commit?: string };
export type GitDiff = { path: string; before: string; after: string; beforeExists?: boolean; afterExists?: boolean; beforeBytes: number; afterBytes: number; binary: boolean; truncated: boolean };
export type GitCommit = { id: string; shortId: string; message: string; author: string; timestamp: number };
export type GitStash = { id: string; message: string };
export type GitConflict = { path: string; base: string | null; local: string | null; incoming: string | null; binary: boolean; revision: string };
export type GitAction =
  | { type: "init" }
  | { type: "stage" | "unstage"; paths: string[] }
  | { type: "discard"; paths: string[] }
  | { type: "commit"; message: string; author?: { name: string; email: string } }
  | { type: "createBranch"; name: string }
  | { type: "switchBranch"; name: string; allowDirty?: boolean }
  | { type: "setRemote"; name: string; url: string }
  | { type: "removeRemote"; name: string }
  | { type: "fetch" | "pull" | "push"; remote?: string; branch?: string; allowDirty?: boolean }
  | { type: "stash"; message: string }
  | { type: "applyStash" | "dropStash"; id: string }
  | { type: "resolveConflict"; path: string; content: string | null; side?: "local" | "incoming"; revision: string }
  | { type: "finishMerge"; message: string }
  | { type: "abortMerge" };
export type GitOptions = { signal?: AbortSignal; onProgress?: (message: string) => void };
export interface GitPort {
  subscribe(workspaceId: string, onChange: () => void): Promise<() => void>;
  status(workspaceId: string): Promise<GitStatus>;
  execute(workspaceId: string, action: GitAction, options?: GitOptions): Promise<GitStatus>;
  diff(workspaceId: string, request: GitDiffRequest): Promise<GitDiff>;
  history(workspaceId: string, before?: number, path?: string): Promise<GitCommit[]>;
  commitFiles(workspaceId: string, commit: string): Promise<GitFile[]>;
  stashes(workspaceId: string): Promise<GitStash[]>;
  conflicts(workspaceId: string): Promise<GitConflict[]>;
  /** Empty directory selects the native managed Purr projects directory. */
  clone(url: string, directory: string, options?: GitOptions): Promise<string>;
}
export type GitErrorCode = "unavailable" | "busy" | "cancelled" | "authentication" | "dirty" | "conflict" | "identity" | "unrelated" | "invalid-project" | "stale" | "author" | "rejected" | "unsupported" | "git";
export class GitError extends Error {
  constructor(readonly code: GitErrorCode, message: string) { super(message); this.name = "GitError"; }
}
