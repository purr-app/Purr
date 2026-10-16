# Git integration

Git operates on saved project files in a standalone repository with `purr.yaml` at its root. Editor working copies, tabs, responses, history and credentials retain their existing local/secret owners. Git never projects the runtime workspace into a second persistence format.

The application-owned `GitPort` crosses typed native IPC, including status subscriptions. The native adapter invokes system Git (2.38+) with argument arrays, bounded output and cancellation. HTTPS access uses the system credential helper; SSH uses the existing agent in batch mode. Remote URL credentials are rejected on input and redacted from diagnostic output. Browser adapters must report Git as unavailable.

Status uses Git's porcelain v2 NUL-delimited protocol, preserving separate index and working-tree states, paths containing spaces and rename pairs. Text previews compare actual blobs and working files; binary or oversized content receives metadata instead. Repository paths cannot escape the root, traverse symbolic links, or modify `.git` through file actions.

The canonical workspace ID remains the identity boundary. Nested projects, linked worktrees and submodules are outside this integration's supported repository layout.

## Saved changes and operations

Initialization appends missing system/editor ignore rules without replacing user rules. It does not stage or commit files automatically. Stage/unstage preserves the real index; commits validate the complete staged canonical tree, including workspace identity and referenced sidecars/assets. A staged version remains independent from subsequent working-file edits.

Native validation combines the credential/format inventory with the JSON Schema generated from the canonical Zod schemas, plus cross-resource uniqueness, folder-cycle, variable/profile and asset checks. Regenerate `src-tauri/schemas/project.json` with `npx tsx scripts/generate-project-schema.ts --write` after schema changes; a TypeScript test rejects stale generated schemas. The JSON Schema validator has external file/HTTP resolution disabled.

Pull uses fetch and merge with explicit policy: fast-forward when possible, merge when histories diverge, never rebase or force push. A target with a different workspace ID or no common ancestor is rejected before changing the worktree. Empty remotes accept the initial push. Branch switching validates the target workspace first. Dirty trees require explicit continuation; Git still refuses overwriting changes.

Before merge, switch or stash application, Purr records an encrypted recovery checkpoint of the original index, dirty files and file fingerprints. A failed or conflicted operation retains the checkpoint. Abort restores only when the entire current post-operation fingerprint still matches, so later external edits are preserved. Stash application retains its stash until successful validation or conflict completion. Git conflict editing uses expected file revisions and validates the entire resolved project before completing the merge.

Cancellation reaps the Git process before releasing its lease and records the resulting recovery state even when the cancellation token has fired. On Unix its process group also terminates SSH/helper/hook children. Ignored files are protected during merge and switch. Unresolved external rebases and cherry-picks require completion in the external Git client.

## Native coordination and restart

Native Git IPC is restricted by the same trusted-main-webview guard as persistence. A per-workspace lease prevents concurrent Git mutations and canonical saves without holding SQLite during network access. Completion emits the normal full project rescan and a separate Git-status invalidation, including on failure. The watcher also invalidates status for external worktree/HEAD/index/ref changes, ignoring object/log churn.

The version-1 `workspace_local_state/git-operation` record is encrypted and owned by the native Git adapter. Normal projection preserves it. While it exists, startup restores the pre-operation canonical snapshot and local working copies in recovery mode; partially merged YAML cannot prevent the workspace opening or be overwritten by autosave. Resolve/finish/abort remain available through Git IPC.

Clone uses a temporary sibling directory, validates the complete project and workspace identity, then publishes into a new or empty destination. A duplicate registered workspace ID is rejected. The selected project is subsequently registered through the existing revision-checked open-directory pipeline.

## Semantic and file diffs

Diff preview offers Semantic and exact YAML views. Semantic parsing uses the canonical codecs, so omitted defaults and YAML formatting do not create false field changes. Requests expose URL/method, ordered query/path/header rows, auth, body fields, GraphQL, settings and documentation. Stable row IDs and occurrence keys retain duplicate and disabled rows, and distinguish reordering from insertion. Environments, workspace definitions, folders, schemas and opaque extension config use the same canonical boundary. Credential previews display references without reading SecureStore.

CodeMirror's merge view renders real before/after file contents with Purr's editor theme; conflict editing adds source-to-result chunk controls. Binary or oversized previews show metadata. Unknown files fall back to the text view.

## Interaction decisions

[Bruno's Git UI](https://docs.usebruno.com/git-integration/using-gui/intro) separates file review, staging, history, stashes and remotes, and supports structural diff review and conflict editing. Purr uses that visible structure with its own rail/tab layout and tokens. [Yaak's directory sync](https://yaak.app/docs/collaboration/local-directory-git-sync) watches both directions and asks for confirmation on incoming filesystem changes. Purr adopts bidirectional watching while refreshing clean editors immediately; confirmation is scoped to dirty editors whose base changed. This preserves the existing saved-versus-working-copy lifecycle without interrupting every clean pull.

| State | Pull / switch behavior |
| --- | --- |
| Pending persistence | Flush before starting Git |
| Clean saved files | Proceed after project/identity/history validation |
| Dirty compatible saved files | Warn; explicit Continue lets Git preserve them |
| Files would be overwritten | Git refuses; offer Commit, Stash or Cancel |
| Dirty editor changed by incoming files | Preserve local editor and incoming baseline; explicit review |
| Deleted active clean document | Select next surviving tab, then previous |
| Unresolved merge or pending checkpoint | Block new pull/switch; Resolve, Finish or guarded Abort |

The native shape validator uses the [jsonschema crate](https://docs.rs/jsonschema/0.56.0/jsonschema/) with external retrieval disabled. Diff and result editing use CodeMirror's merge package through Purr's existing editor theme.
