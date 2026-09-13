# Purr

Purr is a local-first desktop API client built with React, TypeScript, Vite and
Tauri. Saved requests are versioned project files; drafts, executions, cookies and
credentials remain local.

Start with the [architecture and current-state guide](docs/architecture.md). It is
the primary orientation document for maintainers and coding agents.

Related references:

- [Workspaces and GraphQL](docs/workspaces.md)
- [Authentication, OAuth and cookies](docs/auth.md)
- [Persistence, encryption and migration](docs/persistence-architecture.md)

## Development

```bash
yarn dev          # browser UI preview; requests and OAuth are unavailable
yarn tauri dev     # desktop development with native storage and networking
yarn test
yarn test:ui
yarn typecheck
yarn lint
yarn build
```

Native Cargo commands use `--manifest-path src-tauri/Cargo.toml`.
