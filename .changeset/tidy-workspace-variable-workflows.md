---
"@purr/core": patch
---

Fix workspace layout and variable editing workflows:

- Restore usable name, type, and value columns in multipart form-data bodies.
- Bound workspace/environment menus, wrap long names, and keep creation options on screen.
- Keep toolbar selectors independent of name length and prevent activity-rail overlap in fullscreen.
- Edit shared authentication profiles in place without changing their order.
- Keep workspace deletion at the bottom of General settings.
- Bound variable hover cards and preview only non-secret static values.
- Disable inline variable edits while the definition editor is open.
- Rename variable references in saved requests, working copies, schemas, and shared settings, keeping environment overrides consistent and historical executions unchanged.
- Share template completion and definition navigation across GraphQL endpoints, authentication, and header editors.
