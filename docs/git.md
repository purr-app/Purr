# Git integration

Git operates on saved project files in a standalone repository with `purr.yaml` at its root. Editor working copies, tabs, responses, history and credentials retain their existing local/secret owners. Git never projects the runtime workspace into a second persistence format.

The application-owned `GitPort` crosses typed native IPC. The native adapter invokes system Git with argument arrays, a bounded output channel and cancellation. HTTPS access uses the system credential helper; SSH uses the existing agent in batch mode. Remote URL credentials are rejected on input and redacted from diagnostic output. Browser adapters must report Git as unavailable.

Status uses Git's porcelain v2 NUL-delimited protocol, preserving separate index and working-tree states, paths containing spaces and rename pairs. Text previews compare actual blobs and working files; binary or oversized content receives metadata instead. Repository paths cannot escape the root, traverse symbolic links, or modify `.git` through file actions.

The canonical workspace ID remains the identity boundary. Nested projects, linked worktrees and submodules are outside this integration's supported repository layout.

## Saved changes and operations

Initialization appends missing system/editor ignore rules without replacing user rules. It does not stage or commit files automatically. Stage/unstage preserves the real index; commits validate the complete staged canonical tree, including workspace identity and referenced sidecars/assets. A staged version remains independent from subsequent working-file edits.

Pull uses fetch and merge with explicit policy: fast-forward when possible, merge when histories diverge, never rebase or force push. A target with a different workspace ID or no common ancestor is rejected before changing the worktree. Empty remotes accept the initial push. Branch switching validates the target workspace first. Dirty trees require explicit continuation; Git still refuses overwriting changes.

Before merge, switch or stash application, Purr records an encrypted recovery checkpoint of the original index, dirty files and file fingerprints. A failed or conflicted operation retains the checkpoint. Abort restores only when the entire current post-operation fingerprint still matches, so later external edits are preserved. Stash application retains its stash until successful validation or conflict completion. Git conflict editing uses expected file revisions and validates the entire resolved project before completing the merge.

## Native coordination and restart

Native Git IPC is restricted by the same trusted-main-webview guard as persistence. A per-workspace lease prevents concurrent Git mutations and canonical saves without holding SQLite during network access. Completion emits the normal full project rescan and a separate Git-status invalidation, including on failure. The watcher also invalidates status for external worktree/HEAD/index/ref changes, ignoring object/log churn.

The version-1 `workspace_local_state/git-operation` record is encrypted and owned by the native Git adapter. Normal projection preserves it. While it exists, startup restores the pre-operation canonical snapshot and local working copies in recovery mode; partially merged YAML cannot prevent the workspace opening or be overwritten by autosave. Resolve/finish/abort remain available through Git IPC.

Clone uses a temporary sibling directory, validates the complete project and workspace identity, then publishes into a new or empty destination. A duplicate registered workspace ID is rejected. The selected project is subsequently registered through the existing revision-checked open-directory pipeline.
