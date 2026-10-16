# Git integration

Git operates on saved project files in a standalone repository with `purr.yaml` at its root. Editor working copies, tabs, responses, history and credentials retain their existing local/secret owners. Git never projects the runtime workspace into a second persistence format.

The application-owned `GitPort` crosses typed native IPC. The native adapter invokes system Git with argument arrays, a bounded output channel and cancellation. HTTPS access uses the system credential helper; SSH uses the existing agent in batch mode. Remote URL credentials are rejected on input and redacted from diagnostic output. Browser adapters must report Git as unavailable.

Status uses Git's porcelain v2 NUL-delimited protocol, preserving separate index and working-tree states, paths containing spaces and rename pairs. Text previews compare actual blobs and working files; binary or oversized content receives metadata instead. Repository paths cannot escape the root, traverse symbolic links, or modify `.git` through file actions.

The canonical workspace ID remains the identity boundary. Nested projects, linked worktrees and submodules are outside this integration's supported repository layout.
