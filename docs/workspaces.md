# Workspaces, documents, and navigation

This document owns the runtime workspace aggregate, document/folder hierarchy, tabs, layout state, and external-change behavior. Storage classification is in [Persistence architecture](persistence-architecture.md).

## Personal workspace and workspace identity

On first launch `createWorkspace` creates a **Personal** workspace with one pristine HTTP draft. A runtime `Workspace` contains identity, documents, folders/integration resources, variables/environments, cookie state, shared request configuration, dynamic cache, and UI state.

The shareable subset is `WorkspaceDefinition` plus canonical resources. Workspace name/description, workspace variables, shared headers, and shared auth definitions live in `purr.yaml`. The selected environment, tabs, layout, sidebar, drafts, cookies, caches, and responses are local state.

```text
Workspace (runtime aggregate)
  ├─ canonical definition/resources → project files
  ├─ editor/session/cache/history   → encrypted local SQLite
  └─ credential values              → SecretRef / secure vault
```

## Documents

`WorkspaceDocument` currently has three working kinds:

- `http`: HTTP request document;
- `graphql`: GraphQL request executed over HTTP;
- `schema`: GraphQL schema resource.

HTTP and GraphQL are not automatic sidebar sections. Saved HTTP/GraphQL documents share one user-controlled tree. `Schemas` and `Drafts` are derived UI groups, not user folders. Runtime `DocumentKind` also reserves `trace`, `benchmark`, and `integration`, but there are no corresponding working document editors or canonical trace/benchmark resources.

A request document has a current `request`, a saved baseline `savedRequest`, and a `saved` flag. `isDocumentDirty` compares the working request with the saved baseline. Saving updates the canonical resource and baseline; closing/discarding a dirty document does not silently overwrite the project file.

Schema documents have their own lifecycle; see [GraphQL](graphql.md).

## Canonical document tree

The filesystem below `documents/` is the canonical hierarchy for saved HTTP and GraphQL requests:

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

## Folders and sidebar operations

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

`Drafts` includes unsaved documents. A new request is local-only until Save. A meaningful unsaved draft, or a saved document with edits, is projected to the encrypted `drafts` table. For saved dirty documents, the local record includes the canonical base used to detect an external-edit conflict.

`document_session_state` preserves per-document editor state, timestamps, and the complete saved editor snapshot, including inactive body/auth modes. That allows the canonical resource to stay compact without losing local editor choices.

`useWorkspaces` serializes persistence through `WorkspacePersistence`, debounces ordinary saves by 180 ms, and flushes before destructive/closing transitions. A failed flush keeps the desktop window open and exposes the error instead of pretending the workspace was saved.

## Tabs and preview

`ui.openDocumentIds` and `activeDocumentId` are local workspace state. Selecting a clean saved document from the sidebar opens it as a preview tab. Selecting another clean saved document can replace that preview. A preview is pinned when the user explicitly pins it or when edits make it dirty. Unsaved and dirty documents always open as normal tabs.

`DocumentTabs` supports activation, close, close others/all, duplicate, and reorder. Closing affects local open state, not the canonical saved resource. Deleting/discarding is a separate model operation.

Three persistent workspace-level tabs share the tab strip but are not documents:

- Cookies;
- Request settings;
- Variables.

Their open/active flags are stored in `Workspace.ui` and cannot be placed in folders.

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

Request Settings edits workspace shared headers and auth entries. Each entry targets `all`, `http`, or `graphql`. Requests store opt-outs/excluded shared-header IDs; inheritance creates an effective request and does not mutate the stored request definition.

Precedence and managed-row behavior are in [Request lifecycle](request-lifecycle.md); credential and OAuth behavior are in [Authentication and cookies](auth.md).

## External project changes

Project files carry SHA-256 revisions. `WorkspacePersistence.watchChanges` compares the last canonical baseline, current projected working state, and external project state:

- untouched local resources can accept external updates;
- independent changes can be merged resource-by-resource;
- a changed saved request with a local draft/base mismatch fails with a conflict instead of discarding edits;
- the writer uses expected revisions to reject stale overwrites.

Current limitation: `src-tauri/src/persistence.rs` does not include the canonical `documents/` root in its watcher event filter. Startup and explicit reload scan it correctly, but ordinary external edits/moves under `documents/` may not reach the running UI. Do not claim complete live external-document reload until that filter and tests are updated.

Application/native support exists for attaching a project to an external directory, but no current UI exposes it.

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
