# Workspaces, documents, and navigation

This document owns the runtime workspace aggregate, document/folder hierarchy, tabs, layout state, and external-change behavior. Storage classification is in [Persistence architecture](persistence-architecture.md).

## Personal workspace and workspace identity

On first launch `createWorkspace` creates a **Personal** workspace with one pristine HTTP draft. A runtime `Workspace` contains identity, documents, folders/imported-schema/integration resources, variables/environments, cookie state, shared request configuration, dynamic cache, and UI state.

The shareable subset is `WorkspaceDefinition` plus canonical resources. Workspace name/description, workspace variables, shared headers, and shared auth definitions live in `purr.yaml`. The selected environment, tabs, layout, sidebar, drafts, cookies, caches, and responses are local state.

```text
Workspace (runtime aggregate)
  ├─ canonical definition/resources → project files
  ├─ editor/session/cache/history   → encrypted local SQLite
  └─ credential values              → SecretRef / secure vault
```

## Documents

`WorkspaceDocument` currently has four working kinds:

- `http`: HTTP request document;
- `graphql`: GraphQL request executed over HTTP;
- `schema`: workspace-level GraphQL Schema Connection with endpoint, auth and schema source.
- `extension`: a module-owned protocol/document whose versioned JSON configuration is opaque to core.

HTTP, GraphQL, and extension documents are not automatic sidebar sections. Their saved definitions share one user-controlled tree. `Schema Connections` and `Drafts` are derived UI groups, not user folders. Runtime `DocumentKind` also reserves `trace`, `benchmark`, and `integration`, but there are no corresponding working trace/benchmark editors or canonical trace/benchmark resources.

A request document has a current `request`, a saved baseline `savedRequest`, and a `saved` flag. `isDocumentDirty` compares the working request with the saved baseline. Saving updates the canonical resource and baseline; closing/discarding a dirty document does not silently overwrite the project file.

Schema Connections persist when created, including before fetch. They are shared independently of the request folder tree. The default connection is canonical workspace configuration; the last-used connection is local UI state. Workspace settings includes a GraphQL tab with the default Schema Connection selector. The same choice is available as an explicit checkbox in connection Settings. New GraphQL requests choose default, then last-used. See [GraphQL](graphql.md) for binding, auth inheritance and deletion behavior.

An extension document has a stable `extensionType`, positive `configVersion`, opaque JSON `config`, and a saved baseline. Its registered controller validates/migrates config and renders the editor. If that module is absent, Purr shows an unavailable host while preserving the canonical definition and any encrypted dirty working copy. Core rename, folder move, duplicate, discard, and delete operations remain available; core never interprets vendor fields. Extension config must not contain credentials or filesystem paths. A module stores credential references through an explicit integration credential boundary rather than hiding them in opaque config.

`api-schema` is a canonical imported-source resource retained in `Workspace.extraResources`; it is not a GraphQL `SchemaDocument` and currently has no editor. Imported requests link back to it through `RequestDefinition.origin` with a stable operation pointer and optional OpenAPI `operationId`.

## Canonical document tree

The filesystem below `documents/` is the canonical hierarchy for saved HTTP, GraphQL, and extension documents:

```text
workspace/
  purr.yaml
  documents/
    Accounts/
      .purr-folder.yaml
      get-user.yaml
      Admin/
        .purr-folder.yaml
        update-user.yaml
  schemas/
  environments/
  integrations/
  assets/
```

`WorkspacePersistence.readProject` derives request `folderId` relationships from physical directories. Each `.purr-folder.yaml` supplies stable folder identity and metadata; it does not duplicate the path as a second hierarchy. A directory without a marker can be represented by a generated folder identity when loading external content, then normalized on save.

Older `requests/` and `graphql/` roots are read for migration. New saves use the unified `documents/` tree.

## Historical execution tabs

History entries are immutable, local executions, not saved document versions. Global history opens each execution in a reusable separate tab. The response History popover replaces the current tab’s view, preserving its current working copy separately; browsing other executions or returning to current adds no tab. A compact historical-request marker and active response History control with a timestamp distinguish the historical view. Return to current in the History popover opens the source without changing it. Historical views are ephemeral and excluded from canonical projection. Separate historical tabs are excluded from persisted tab state; an in-place historical view persists the underlying current document tab so reopening the workspace restores its current buffer.

Editing updates only the ephemeral tab’s editor without switching tabs or modifying the immutable stored execution. Send converts that tab in place into the saved source’s working copy if it is clean. Dirty saved sources and existing unsaved drafts require an explicit Replace current changes / Create new draft / Cancel choice at Send; cancelling preserves the edited historical tab. Replace reuses an existing saved document or draft; Create new draft and deleted sources produce new drafts in the same tab position. The source’s saved snapshot is never changed by this operation. Send executes with the current context. History is recorded only for requests, not keystrokes.

Deleting a document, deleting a draft, closing a tab, or discarding working changes does not delete history. The workspace history list has pin, individual deletion, clear-all and retention controls (30 days by default). The response popover filters the same records by document; it is not a separate history store. Workspace deletion still deletes all local data for that workspace.

## Folders and sidebar operations

The activity rail remains visible when sidebar content is collapsed, with activities at the top. Documents opens or toggles the sidebar; Cmd+B toggles visibility without changing `ui.sidebarActivity` or the saved width. History switches the sidebar to the current workspace’s execution list. The response history icon opens a popover filtered to that source document, including its draft executions. Selecting either activity while collapsed reopens it; selecting the active activity toggles visibility. The header always reserves the activity rail’s width, including in fullscreen. Native macOS window controls occupy that same reserved area in windowed mode, so fullscreen transitions do not move the workspace or environment controls.

For macOS shells with `trafficLightPosition` configured, `macos_window_controls` scales the existing native buttons to 12 logical pixels with a 20-pixel center-to-center pitch, retaining the configured left inset and native actions. The configured y offset locates the button centers relative to the top of the content view (20 pixels for the 40-pixel Purr header). The layout is reapplied on resize and display-scale changes; other platforms and shells using an uncustomized titlebar are unaffected.

Folder canonical resources live in `Workspace.extraResources` at runtime and as `.purr-folder.yaml` on disk. Folders can nest. `validateProject` rejects missing parents and cycles.

The sidebar supports:

- create, rename, duplicate, delete, expand/collapse, and move operations;
- drag-and-drop of documents and folders into a folder or root;
- document reordering among siblings;
- Shift range selection of documents and multi-document moves;
- per-folder recursive document counts;
- search across document names/content metadata.

`folderId` determines ownership/hierarchy. `ui.sidebarItemOrder` determines local display order only. Moving a saved request changes its canonical file directory on the next persistence commit. Deleting a folder reparents its direct documents and child folders to the deleted folder’s parent; it does not delete their contents.

The vertical scope lines and indentation are presentation only. Hover/selection geometry must not change hierarchy or hit targets.

## Drafts and save semantics

`Drafts` includes unsaved documents. A new request or extension document is local-only until Save. A meaningful unsaved draft, or a saved document with edits, is projected to the encrypted `drafts` table. For saved dirty documents, the local record includes the canonical base used to detect an external-edit conflict. Extension-document working config follows the same saved-versus-working-copy rule.

`document_session_state` preserves per-document editor state, timestamps, and the complete saved editor snapshot, including inactive body/auth modes. That allows the canonical resource to stay compact without losing local editor choices.

`useWorkspaces` serializes persistence through `WorkspacePersistence`, debounces ordinary saves by 180 ms, and flushes before destructive/closing transitions. A failed flush keeps the desktop window open and exposes the error instead of pretending the workspace was saved.

## Tabs and preview

`ui.openDocumentIds` and `activeDocumentId` are local workspace state. Selecting a clean saved document from the sidebar opens it as a preview tab. Selecting another clean saved document can replace that preview. A preview is pinned when the user explicitly pins it or when edits make it dirty. Unsaved and dirty documents always open as normal tabs.

`DocumentTabs` supports activation, close, close others/all, duplicate, and reorder. Closing affects local open state, not the canonical saved resource. Deleting/discarding is a separate model operation.

Three persistent workspace-level tabs share the tab strip but are not documents:

- Cookies;
- Request settings;
- Variables.

Their open/active flags are stored in `Workspace.ui` and cannot be placed in folders. Closing the last document activates the first remaining workspace-level tab in strip order (Cookies, Variables, Workspace settings). Closing a workspace-level tab returns to the selected document, or another open workspace-level tab when no documents remain. Previously saved local state with open workspace tabs and no selection is repaired on restoration. The empty state appears only when no workspace tabs remain.

## Request/response layout

`WorkbenchView` has three modes:

- `canvas`: request and response switch focus in one canvas;
- `horizontal`: request above response;
- `vertical`: request beside response.

`Workspace.ui.view` is the source of truth. Horizontal/vertical `splitRatios` and `sidebarWidth` are persisted locally. `SplitPane` updates the active pane continuously during pointer drag; the sidebar uses its own horizontal resizer. Resizers intentionally have no permanent visual handle, but expose the corresponding resize cursor and keyboard-accessible separator semantics.

Sidebar open state and width are workspace-local. Width is constrained by the model/UI limits so resizing the sidebar and main request/response pane remains responsive.

## Navigation and shortcuts

`src/shared/config/keyboard-shortcuts.ts` is the binding source of truth. Important application bindings include:

- Cmd/Ctrl+K command palette;
- Cmd/Ctrl+P recent/document palette;
- Cmd/Ctrl+N new request;
- Cmd/Ctrl+S save;
- Cmd/Ctrl+W close tab;
- Cmd/Ctrl+Enter send;
- Cmd/Ctrl+L focus URL;
- Cmd/Ctrl+B toggle sidebar;
- Cmd/Ctrl+E variables;
- Cmd/Ctrl+Shift+1/2/3 canvas/horizontal/vertical.

The command palette combines actions with saved and draft documents and supports keyboard navigation. Sidebar search is the document-tree search. Response Cmd/Ctrl+F belongs to the active response surface and is documented in [Response lifecycle](response-lifecycle.md).

## Environment navigation

The header selects the active environment and opens environment editing. The Variables workspace tab can inspect the effective namespace and jump to global/workspace/environment definitions. Environment selection is local, unlocks the selected environment’s secret values on demand, and clears document OAuth runtime tokens to avoid reusing a token across contexts.

Full scope and persistence rules are in [Environments and variables](environments-and-variables.md).

## Shared request configuration

Request Settings edits workspace shared headers and any number of shared auth profiles. Each entry targets `all`, `http`, or `graphql`; overlapping auth scopes are intentional because requests select a profile by stable ID from Auth → Inherit. Requests store the selected auth profile, opt-outs, and excluded shared-header IDs. Inheritance creates an effective request and does not mutate the stored request definition.

Precedence and managed-row behavior are in [Request lifecycle](request-lifecycle.md); credential and OAuth behavior are in [Authentication and cookies](auth.md).

## External project changes

Project files carry SHA-256 revisions. `WorkspacePersistence.watchChanges` compares the last canonical baseline, current projected working state, and external project state:

- untouched local resources can accept external updates;
- independent changes can be merged resource-by-resource;
- `folderId` for saved requests is taken from the rescanned canonical path even when the request has unrelated dirty editor content;
- a changed saved request with a local draft/base mismatch fails with a conflict instead of discarding edits;
- the writer uses expected revisions to reject stale overwrites.

`src-tauri/src/persistence/runtime.rs` watches every registered project root with `RecursiveMode::Recursive`. Any event inside `documents/` produces a debounced full snapshot reload. This intentionally favors correctness over path-level optimization: directory create/move/rename/delete events and Git’s atomic file replacement patterns vary by platform, while the scanned filesystem tree is canonical. Notify overflow/rescan signals and watcher errors also request a full snapshot. `WorkspacePersistence` then performs the same revision and three-way conflict checks before replacing the runtime tree.

The explicit **Reload and retry** save action closes the race where a save observes an external filesystem revision before the debounced watcher reload runs. It rescans and reconciles first, then retries with the refreshed baseline; genuine concurrent content edits remain conflicts. Revision conflicts do not block the macOS window close because the failed preflight has not overwritten canonical files.

Desktop **New workspace → Import → Choose folder instead** opens an exported Purr folder, a copied project directory or a Git checkout containing `purr.yaml`. Purr validates the complete canonical model before registration, then native code rechecks the exact file revisions. Opening preserves workspace/resource IDs and SecretRefs and leaves canonical bytes unchanged. The folder remains external: future saved edits update it in place, and deleting the workspace from Purr leaves the external directory on disk. Local tabs/drafts/history/cookies are initialized on this installation; credential values are provisioned separately through Import secrets. Opening the same registered folder selects its existing workspace. A second directory with the same workspace ID is rejected; use another device/profile for a transfer test, rather than remapping IDs and breaking secret packages. Native Purr folder opening requires the desktop app.

## Key files

- `src/features/workspaces/model/workspace.ts` — runtime aggregate, document lifecycle, tabs, ordering, folders, effective variables, and validation.
- `src/features/workspaces/workspace-workbench.tsx` — shell composition, document/folder operations, layouts, shortcuts, and feature tabs.
- `src/features/workspaces/components/workspace-sidebar.tsx` — common document tree, folders, selection, moves, search, and sidebar resize surface.
- `src/features/workspaces/components/document-tabs.tsx` — document and workspace-level tab interaction.
- `src/features/workspaces/components/workspace-header.tsx` — workspace/environment/navigation controls.
- `src/features/workspaces/components/command-palette.tsx` — action/document search and keyboard navigation.
- `src/features/workspaces/hooks/use-workspaces.ts` — loading, autosave, flush, retry, and close protection.
- `src/shared/components/ui/split-pane.tsx` — request/response resize behavior.
- `src/shared/components/ui/collapsible.tsx` — sidebar open/close layout primitive.
- `src/shared/config/keyboard-shortcuts.ts` — default bindings.
- `src/application/workspace-persistence.ts` — physical document tree and external reconciliation.
- `src-tauri/src/project_files.rs` — safe file operations and revisions.
- `src-tauri/src/persistence.rs` — registry, watcher, and commit orchestration.

### State while switching tabs

Open document tabs own an in-memory `TabStateStore` scope. Workspace settings
retain their section and unfinished editors; response viewers retain the selected
view and find state across document switches. Closing a tab (including closing
other/all tabs or replacing a preview) releases its scope. This state is never
written to project files or local records. `TabStateStore.remember` defaults to
`true` and is the policy switch for a future user preference; turning it off uses
ordinary component-local state. New panels can use `useTabState` without retaining
mounted editors, timers or network requests in background tabs.

## Application menu and notifications

The bottom rail More button opens documentation, changelog, feedback, issue reporting, GitHub, homepage, extension actions, and version/update controls. There is no status footer or About tab. Release notes still open once after a version change.

Application notifications appear at bottom right, with at most three visible and remaining messages queued. Informational/success toasts expire after five seconds, paused while hovered or focused. Warnings, errors, and update progress persist until dismissed or resolved. Save failures offer a retry and disappear after a successful save; blocking workspace-load errors and field validation remain inline. Development builds include isolated UI previews in More; production builds exclude them.

## Secrets and encryption: transfer

Desktop **Secrets and encryption** shows compact rows for response encryption, local-secret management, selected export/import, and recovery. Manage secrets opens a searchable table with a disabled name field, masked value field, one-row reveal and confirmed Remove. Editing a value requires explicit Save; an empty replacement is rejected. A new sensitive variable with no value creates a missing declaration, while older saved empty values remain distinct from missing. Sensitive variable values are display-only in the list and edited in the full form. Availability does not depend on editor hydration. Recovery opens its own menu for key, credential backup and restore. **General → Export workspace** opens the native empty-folder picker directly; its inline description explains excluded data. Save credential owners before selected export: unsaved drafts and inactive editor values are excluded. Copy the workspace first, use New workspace → Import → Choose folder instead on the other device, then import selected values by choosing the encrypted file before entering its password. Existing local values default to Keep; missing declared values default to Import. Unknown references require updated public configuration. Recovery requires both a password-protected recovery key and matching credential backup, and is separate from normal device transfer. [Details and limits](secret-transfer-and-recovery.md).

### Git and editor recovery

A changed canonical request with a dirty local working copy now creates an encrypted, version-1 editor conflict instead of rejecting the entire workspace reload. The incoming definition becomes the saved baseline while the local editor remains unsaved. The old base and incoming definition contain portable references only. Deleting a dirty request produces a recoverable local draft; autosave cannot recreate its removed YAML. Clean external changes retain tab identity and clear the current response/context cache. In-flight execution callbacks from an older external revision cannot replace the new editor session.

File-changing native Git operations use the persistence queue and suspend ordinary autosave until the resulting full snapshot has been reconciled. Stage/unstage uses the same queue with optimistic rows, without a full project reload or a workspace interaction lock. Git recovery records remain native-owned and are preserved by regular projection.

The Source control rail opens a dedicated work area with its own overview, independent of document tabs. Returning to Documents preserves the active document and open tabs; Git never renders the document empty state. Legacy Git-tab flags are ignored. It shows the current branch, actual staged/unstaged files, a commit form and links to commits, stashes and remotes. Diff review defaults to canonical semantic fields with an exact YAML alternative. Pull/switch first flush pending local persistence and offer Commit, Stash, Cancel or safe continuation for dirty saved files. Stash-and-pull reapplies after a successful pull; stash-and-switch leaves the stash available for manual application. Unresolved Git conflicts block new pull/switch operations and open a Base/Local/Incoming-to-Result editor. See [Git integration](git.md).

Incoming changes refresh clean active editors without changing their tab identity. A deleted clean document selects the next surviving tab, then the previous one. Dirty editors keep a reviewable Base/Local/Incoming conflict; deleted or differently typed resources become recoverable local drafts, with a fresh ID when necessary. Accept incoming, keep local edits, or keep a separate draft are explicit choices. Late request completions from before an external revision cannot overwrite the updated editor/session.

New workspace displays a read-only native project directory with an equally sized folder picker and an optional Initialize Git checkbox. Browser preview keeps ordinary local creation. If Git initialization fails after creation, the workspace remains available and initialization can be retried from Git.
