# Local workspaces

Purr creates **Personal** on first launch. Each workspace has its own documents,
environments, open/active document and workspace-cookie tabs, request-editor tabs, sidebar visibility,
layout mode, and horizontal/vertical splitter ratios.

`+` / `Mod+N` creates a blank HTTP document. A blank, never-sent document is not
listed in **Drafts** and is removed automatically when its tab closes. Once it has
a URL, parameter, header, body, authentication, or send attempt, it becomes a
recoverable draft with an explicit discard action.

`Mod+S` names a draft and adds it to **HTTP requests**. A saved request keeps an
explicit saved snapshot: editing and sending use a working copy, and closing the
tab without saving restores the snapshot. Saving again commits that working copy.
The most recent response is stored with its document, while the cookie jar is
stored at workspace scope, so both survive tab/workspace closure and app restart.

Opening a clean saved request from the sidebar or command palette creates one
italic preview tab. Opening another clean request replaces that preview. Editing,
double-clicking, or dragging the preview pins it as a regular tab. Tabs can be
reordered by dragging; `Alt+Shift+Left/Right` provides the keyboard equivalent.
The resulting order and preview state are stored with the workspace.

## On-disk format (desktop)

The root is Tauri's application data directory, followed by `workspaces/`.
On macOS this is normally
`~/Library/Application Support/com.ihorpolishchuk.purr/workspaces/`.

```text
workspaces/
  index.json                 # schemaVersion, activeWorkspaceId
  personal/
    workspace.json           # complete versioned workspace snapshot
  <workspace-uuid>/
    workspace.json
```

Workspace names are display values, never filesystem paths. IDs are validated by
the native bridge. Writes are serialized and use a temporary file plus atomic
rename, with file synchronization before replacement. Files are created with
owner-only permissions on Unix. Closing the desktop window flushes pending writes;
failed writes leave the window open with an error and retry action. Invalid or
unsupported workspace files are reported without replacing them with defaults.

`workspace.json` has `schemaVersion: 1`, `id`, `name`, `documents`, `environments`,
workspace cookies, `activeEnvironmentId`, and `ui`. Documents have stable IDs, a
`kind` discriminant (`http` today), names, timestamps, saved/draft status, working
and saved request data, their latest response, and editor UI state. Attached
`File` objects are encoded as tagged `__purrFile` records with
their bytes (base64), name, MIME type, and last-modified timestamp, and restored
as Files when loaded.

This schema is the persistence boundary. Future Postman/other importers should
convert source data to versioned workspace/document records, assign stable IDs,
and then use the storage service. Additional document kinds (GraphQL, schemas,
trace/benchmark setups and results, integrations) should add their own typed
payloads and editors. They must not be flattened into HTTP request drafts.
Older versions refuse unsupported document kinds rather than discarding them.
There is no importer or cloud synchronization yet.

Browser development uses localStorage with the same schema, not the desktop
filesystem. Storage errors (including browser quota failures) are visible.

## Environments

Create/select environments from the title bar; `Mod+E` edits the active one.
Variables are workspace-scoped and support `{{name}}` (including nested variable
values). Only enabled variables in the selected environment are available.
Templates are resolved immediately before sending, while editor drafts retain
the original templates. Resolution applies to URL/query/header names and values,
active JSON/XML/text/form bodies and auth credentials/OAuth configuration.
Binary attachment bytes are never interpolated. Missing/circular variables stop
the request with an explicit error. Values are inserted literally in body text;
use the appropriate quoting/escaping for the target body format.

**Local storage is not a secrets vault.** Environment values and credentials are
stored unencrypted. The eye toggle masks a value on screen only. Switching an
environment clears acquired OAuth/response tokens so credentials are not reused
in another environment. Imported secrets will need an explicit future policy.

## Shortcuts

`Mod` is Command on macOS and Control elsewhere. Shortcuts are defined centrally
in `src/shared/config/keyboard-shortcuts.ts`.

- `Mod+K` / `Mod+P`: command palette and document search
- `Mod+N`, `Mod+S`, `Mod+W`, `Mod+D`: new, save/name, close, duplicate document
- `Mod+Enter`: send active request
- `Mod+L`: focus URL
- `Mod+B`: toggle sidebar
- `Mod+E`: environment variables
- `Mod+Shift+1/2/3`: canvas / stacked / side-by-side

Commands only target the active document. Late HTTP results stay with the
originating document even if another document/workspace is selected meanwhile.
