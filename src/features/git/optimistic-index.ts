import type { GitAction, GitStatus } from "../../application/ports/git";
export type IndexAction = Extract<GitAction, { type: "stage" | "unstage" }>;
/** Project queued index changes without hiding unrelated working-copy changes. */
export function optimisticIndex(status: GitStatus, action: IndexAction): GitStatus {
  const paths = new Set(action.paths);
  return { ...status, files: status.files.map((file) => {
    if (!paths.has(file.path)) return file;
    if (action.type === "stage") return { ...file, index: file.index === "?" ? "A" : file.worktree === "." ? file.index : file.worktree, worktree: "." };
    return { ...file, index: file.index === "A" ? "?" : ".", worktree: file.worktree !== "." ? file.worktree : file.index === "A" ? "?" : file.index };
  }) };
}
