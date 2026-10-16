# @purr/core

## Unreleased

### Improvements

- Create reusable GraphQL Schema Connections from introspection, SDL, or introspection JSON, then explore their types and create query or mutation requests from schema fields.
- Choose a Schema Connection in a GraphQL request to use its endpoint and authentication without typing the request URL. Connections show their load status and can be shared by multiple requests.

### Fixes

- Align the icon and message in request error notices.
- Configure redirects, their maximum count, a total request timeout, TLS certificate validation, and HTTP version separately for each request.
- Control whether a request automatically sends and stores workspace cookies with independent switches.
- Find these controls in clearly separated Settings sections, with Tracing first. Saved settings travel with the project; unsaved edits stay local.

## 0.3.0

### Minor Changes

- 7fcceab: Add explicit secret availability and canonical format v2 credential/header definitions. Preserve legacy files until a confirmed workspace-wide upgrade, keep intentionally empty values distinct from removal, and protect complete literal or mixed credential expressions.
  
  Resolve required secrets for the active operation, provide redacted code without inventing missing values, and expose a local-secret inventory with omission preview and retry controls. Storage adapters now return typed availability and protected-state snapshots; encrypted transfer and OS root-key migration remain separate work.
- c2fb193: Open exported, copied or Git-backed Purr workspace folders through the standard desktop New workspace → Import flow. Preserve workspace identity and secret references for encrypted secret import, validate files before registration, and protect existing workspaces from duplicate-identity replacement.
- 50984ad: Move the macOS storage root into a scoped Keychain entry through a verified, resumable migration. Share cached key access across native storage workers, expose safe recovery messages, and scope storage by application identifier independently of debug/release build mode.
- 8ef3f64: Add desktop selected-secret transfer, configuration-only export and password-protected workspace credential recovery. Authenticate bounded packages before preview, preserve destination keys, and publish selected values through revision-checked transactional imports. Browser builds expose transfer as unsupported.
- 4a444d7: Restrict desktop WebView resources and native IPC to the trusted local main window. Stream local attachments through encrypted chunks, preserve legacy attachments with lazy conversion, and use disposable encrypted upload staging with explicit cancellation and cleanup. Downstream shells must include the core command capability manifest and inherit the CSP configuration.
- 5d661a4: Add local workspace and per-request Encrypt responses settings with public/protected snapshots, immutable secret-bearing execution details, and key-independent public storage. Preserve explicit protection through streamed and derived content and expose unavailable protected dependencies. Archive the previous pre-release dataset intact before creating the fresh mixed-storage format; existing projects may be attached explicitly.
  
  Store local request editors in a compact versioned format that restores omitted defaults and preserves inactive edits, files and secret references. Consolidate workspace encryption and secret management settings, with request encryption help available on demand.
- 8253e90: Prepare credential changes without modifying the vault, and commit them together with project and local-state changes. Failed saves preserve existing credentials; interrupted commits recover safely, and acknowledged operations can be reconciled without applying them twice.
  
  Add versioned credential reads and transactional batches to storage adapters. Imports, execution history and integration settings use the same publication boundary.
- 54863c4: Start a fresh protected storage format with independent workspace and global credential/runtime keys wrapped by a new OS-held installation key. Archive previous managed profiles under deprecated while keeping new storage in the application data root, without automatic import, bind response content to its originating workspace, and isolate unavailable scopes while retaining public project navigation.

### Patch Changes

- c2fb193: Recognize recovery key and credential backup files in either selection order, explain package and recovery failures, and use the full password field width for single-package imports. Verify credential recovery after deleting and reimporting a workspace with fresh device keys.
- 968e977: Update Rust TLS and QUIC dependencies to patched releases. Make random cryptographic inputs and bounded encrypted-file reads explicit to security analysis, and replace fixed test credentials with generated fixtures.

## 0.2.2

### Patch Changes

- a457a2a: Fix workspace layout and variable editing workflows:
  
  - Restore usable name, type, and value columns in multipart form-data bodies.
  - Bound workspace/environment menus, wrap long names, and keep creation options on screen.
  - Keep workspace positioning stable, let the environment selector fit its name up to a maximum width with Variables immediately beside it, and prevent activity-rail overlap in fullscreen.
  - Edit shared authentication profiles in place without changing their order.
  - Keep workspace deletion at the bottom of General settings.
  - Bound variable hover cards and preview only non-secret static values.
  - Disable inline variable edits while the definition editor is open.
  - Rename variable references in saved requests, working copies, schemas, and shared settings, keeping environment overrides consistent and historical executions unchanged.
  - Share template completion and definition navigation across GraphQL endpoints, authentication, and header editors.

## 0.2.1

### Patch Changes

- 59a1b86: Fix a macOS window resize crash caused by over-releasing the native WebView while laying out the window controls.

## 0.2.0

### Minor Changes

- af070ea: Add a workspace activity rail that stays visible when the document sidebar is collapsed. Toggle the sidebar through the active activity or Cmd+B, preserve resizing, and add placeholders for workspace and request history. Use smaller, more closely spaced native macOS window controls and remove their header inset in fullscreen.
- a850345: Make dynamic variables easier to debug with dependency chains, clear cycle and extraction errors, and source request execution history. Preserve HTTP error responses for extraction and inspection, and record manual variable executions without duplicating cache hits. Fix variable details leaking between workspaces, clipped editor tooltips, and cancellation after navigating between requests.
  
  Highlight variable references throughout request editors and show auth templates without revealing literal credentials. Recommend encrypted variables for credentials. Export dynamic request chains as Bash scripts using curl and jq; disable formats that cannot represent a chain.
- 575012c: Add an application menu with support links and update controls, replace the status footer with queued notifications, and allow private extensions to contribute menu links, page actions, and dialogs.
  
  Use brand blue for general primary actions and compact, aligned notifications with rounded download progress; keep HTTP Send green.
  
  Reduce Variables and Workspace settings spacing, and select a remaining workspace tab when the last document closes. Repair previously unselected open tabs when restoring local state.
  
  Keep the pending-response elapsed time synchronized with Send across rerenders, layout changes, and tab navigation.
- 2dfa79c: Add per-request redirect limits, timeout, TLS certificate validation, HTTP version, and independent cookie sending/storage settings. Group Settings into clear sections with Tracing first, and preserve saved settings across workspaces and project files.
- 702f05f: Add reusable workspace GraphQL Schema Connections with endpoints, authentication, introspection headers, cached schemas and load status. Support multiple connections, workspace defaults and automatic reuse by new requests, while keeping requests organized in folders and runnable without a schema. Migrate existing schemas and securely store connection credentials.
  
  Add a schema selector beside the request URL, with status indicators and a dimmed, read-only endpoint when connected. Open new connections in their own tabs, create operations from the explorer, and manage connection details in a consistent settings dialog. Improve toolbar visibility, remove tab checkmarks and let desktop users choose where to save exported SDL or introspection JSON.
- 68ac803: Add workspace and document request history with immutable execution tabs, safe working-copy restoration, current-context replay, pinning and configurable retention. Preserve draft and deleted-document executions with their response bodies and upload attachments independently of document autosave.

### Patch Changes

- 024a4c3: Align the icon and message in request error notices.
- 3310411: Simplify dynamic cURL export into commands that can be pasted into Bash or zsh: readable selectors and named dependency values, without script boilerplate or temporary files.

## 0.1.2

### Fixes

- Make Jaeger available as Purr’s first built-in integration in installed distribution builds.
- Load the empty-workspace Purr icon from the packaged core instead of an unavailable root URL.
- Remove About Purr from the workspace menu, use the blue brand action for update checks, and give About and release notes an opaque application surface.
- Avoid a Keychain password prompt on every unsigned app update by keeping the local encryption key in user-only application storage. Existing Keychain-backed installations migrate once.

## 0.1.1

### Improvements

- See the running version in the footer, with an arrow when an update is available.
- Official builds check for updates in the background at startup. You can also check manually from About Purr.
- Read what’s new, choose Download or Later, and follow download progress without leaving your workspace.
- Restart when you’re ready. Downloads never restart Purr automatically, and your workspace is saved before installation.
- Reopen release notes from About. After an update, the notes appear in a new tab.
- Updates and errors use new dismissible notifications that match the app’s theme and respect reduced-motion preferences.

### For developers

- Add optional updater and product release metadata to the public app API, a reusable Notification component, and exported base Tauri configuration for distribution builds. Source builds remain independent of any official update service.
