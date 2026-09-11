# Local workspaces

Purr creates **Personal** on first launch. Each workspace has its own documents,
environments, open/active document and workspace-cookie tabs, request-editor tabs, sidebar visibility,
layout mode, and horizontal/vertical splitter ratios.

The sidebar `+` lets you choose **HTTP** or **GraphQL**. The tab-bar `+` / `Mod+N`
creates the last-used request type (remembered per workspace); right-click the
tab-bar `+` to choose a different type. A blank, never-sent document is not
listed in **Drafts** and is removed automatically when its tab closes. Once it has
a URL, parameter, header, body, authentication, or send attempt, it becomes a
recoverable draft with an explicit discard action.

`Mod+S` names a draft and adds it to **HTTP** or **GraphQL**. GraphQL request and
schema documents share the GraphQL group. A saved request keeps an
explicit saved snapshot: editing and sending use a working copy, and closing the
tab without saving restores the snapshot. Saving again commits that working copy.
The most recent response is associated with its document in local SQLite, while
the cookie jar is local workspace state. Both survive app restart, but neither is
included in shareable request files.

Opening a clean saved request from the sidebar or command palette creates one
italic preview tab. Opening another clean request replaces that preview. Editing,
double-clicking, or dragging the preview pins it as a regular tab. Tabs can be
reordered by dragging; `Alt+Shift+Left/Right` provides the keyboard equivalent.
The resulting order and preview state are stored with the workspace.

## On-disk format (desktop)

See [Persistence architecture](persistence-architecture.md) for the canonical model,
storage contracts, migrations, security boundary and importer extension point.
The default project root is Tauri's application data directory followed by `projects/`.

```text
projects/<workspace-id>/
  purr.yaml                  # versioned workspace identity/defaults
  requests/<name>-<id>.yaml   # one saved request per file
  graphql/<name>-<id>.yaml
  environments/<name>-<id>.yaml
  schemas/<name>-<id>.yaml    # source, not introspection cache
  schemas/<id>.graphql       # explicitly pinned SDL only
local-state.sqlite3          # outside project: drafts/session/history/cookies/cache
```

Writes are serialized, revision-checked and atomic per file. Unchanged resources
are not rewritten. Saved binary attachments use content-addressed asset files.
Closing the desktop window flushes pending writes; failures keep the window open.
Malformed/external conflicting files are reported without resetting user data.
The old JSON format is read only for a checkpointed migration, then retired after
an encrypted recovery archive is verified. Browser development uses encrypted
IndexedDB as a UI preview, not the native filesystem or OS credential vault.

## Environments

Create/select environments from the title bar; `Mod+E` edits the active one.
Variables are workspace-scoped and support `{{name}}` (including nested variable
values). Only enabled variables in the selected environment are available.
Templates are resolved immediately before sending, while editor drafts retain
the original templates. Resolution applies to URL/query/header names and values,
active JSON/XML/text/form bodies, GraphQL queries/variables/operation names,
and auth credentials/OAuth configuration.
Binary attachment bytes are never interpolated. Missing/circular variables stop
the request with an explicit error. Values are inserted literally in body text;
use the appropriate quoting/escaping for the target body format.

**Secret and masking are independent.** The lock control stores a variable through
SecureStore (the encrypted local SQLite vault backed by one macOS Keychain root),
leaving only its stable reference in YAML. The eye control changes visibility only.
Plain variables are shareable. Switching an
environment clears acquired OAuth/response tokens so credentials are not reused
in another environment.

## GraphQL

GraphQL documents use the shared HTTP transport, authentication, headers,
environment resolution, cookie jar and response viewer. **Query** is a full-height
editor. Parsed operation variables appear as a resizable dock inside it, with a
typed Form mode (including enum selectors) and a raw JSON mode. The dock remains
hidden when the operation has no variables. Variables must serialize to a JSON object;
an empty value means `{}`. A selector appears only when a document contains
multiple named queries/mutations. Requests are sent as POST
with an `application/json` envelope containing `query`, `variables` and optional
`operationName`. Editor text is not replaced by the generated envelope.

The labelled schema control beside the URL opens a separate **Schema** document.
An empty schema document remains ephemeral and is not added to the sidebar; a
successful import or introspection makes it a saved GraphQL document. Load SDL
(`.graphql`, `.gql`, `.graphqls`, `.sdl`) or introspection JSON (bare or wrapped in
`data`), or use **Reload introspection**. Introspection uses the source request's
current URL, auth, headers, environment and cookies without replacing its query
or response. Failed imports/refreshes leave the previous schema intact.

The compact explorer provides searchable operation/type groups, field paths and
linked return types, enum/input/interface/union information, deprecation messages,
depth/field/list analysis, and an optional SDL/JSON pane. Query and mutation fields
can create linked request drafts. Imported SDL preserves custom directives and type
extensions. Source definitions are shareable; cached schemas, source-pane state and
selected type are local. Pin SDL explicitly to share it. Loaded schemas supply
completion, hover documentation, validation, deprecation
warnings and type navigation to every linked request.

GraphQL responses split `data`, `errors`, and `extensions` into dedicated views.
The HTTP status remains visible alongside a GraphQL error count; each error exposes
its message, path, source locations, extension code and copy action.

Query and mutation operations are supported over HTTP. Subscriptions require a
streaming transport and currently produce an explicit unsupported-operation error.
Introspection must be enabled by the server; file import remains available when
it is disabled. Refresh the schema after switching to a different endpoint or
environment; cached schema data is not silently replaced.

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
