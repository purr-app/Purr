import { Channel, invoke } from "@tauri-apps/api/core";
import { GitError, type GitPort, type GitOptions, type GitErrorCode } from "../../application/ports/git";

async function call<T>(command: string, args: Record<string, unknown>, options?: GitOptions): Promise<T> {
  options?.signal?.throwIfAborted();
  const operationId = crypto.randomUUID();
  const cancel = () => { void invoke("git_cancel", { operationId }).catch(() => {}); };
  options?.signal?.addEventListener("abort", cancel, { once: true });
  const supportsChannel = typeof (window as unknown as { __TAURI_INTERNALS__?: { transformCallback?: unknown } }).__TAURI_INTERNALS__?.transformCallback === "function";
  const channel = supportsChannel && options?.onProgress ? new Channel<string>(options.onProgress) : undefined;
  try { return await invoke<T>(command, { ...args, operationId, ...(channel ? { onEvent: channel } : {}) }); }
  catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && "message" in cause) throw new GitError(String(cause.code) as GitErrorCode, String(cause.message));
    throw new GitError("git", cause instanceof Error ? cause.message : String(cause));
  } finally { options?.signal?.removeEventListener("abort", cancel); }
}
const query = <T>(workspaceId: string, query: Record<string, unknown>, options?: GitOptions) => call<T>("git_workspace", { workspaceId, query }, options);
export const tauriGit: GitPort = {
  status: (id) => query(id, { type: "status" }),
  execute: (id, action, options) => query(id, { type: "execute", action }, options),
  diff: (id, request) => query(id, { type: "diff", request }),
  history: (id, before = 0, path) => query(id, { type: "history", skip: before, path }),
  commitFiles: (id, commit) => query(id, { type: "commitFiles", commit }),
  stashes: (id) => query(id, { type: "stashes" }),
  conflicts: (id) => query(id, { type: "conflicts" }),
  clone: (url, directory, options) => call("git_clone", { url, directory }, options),
};
