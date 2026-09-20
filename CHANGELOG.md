# @purr/core

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
