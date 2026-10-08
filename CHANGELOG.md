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
