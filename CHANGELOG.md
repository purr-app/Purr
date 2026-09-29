# @purr/core

## 0.2.0

### Minor Changes

- af070ea: Add a workspace activity rail that stays visible when the document sidebar is collapsed. Toggle the sidebar through the active activity or Cmd+B, preserve resizing, and add placeholders for workspace and request history. Use smaller, more closely spaced native macOS window controls and remove their header inset in fullscreen.
- a850345: Make dynamic variables easier to debug with dependency chains, clear cycle and extraction errors, and source request execution history. Preserve HTTP error responses for extraction and inspection, and record manual variable executions without duplicating cache hits. Fix variable details leaking between workspaces, clipped editor tooltips, and cancellation after navigating between requests.
  
  Highlight variable references throughout request editors and show auth templates without revealing literal credentials. Recommend encrypted variables for credentials. Export dynamic request chains as Bash scripts using curl and jq; disable formats that cannot represent a chain.
- 68ac803: Add workspace and document request history with immutable execution tabs, safe working-copy restoration, current-context replay, pinning and configurable retention. Preserve draft and deleted-document executions with their response bodies and upload attachments independently of document autosave.

### Patch Changes

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
