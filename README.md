# Purr

Purr is a local-first desktop API client. The UI and application layer are React/TypeScript; Tauri/Rust provides native HTTP, filesystem persistence, encrypted local state, macOS Keychain integration, OAuth callbacks, and response downloads.

Project definitions are stored as readable YAML/SDL/assets that can be committed to Git. Drafts, tabs, layouts, response history, cookies, and caches remain local. Credentials are referenced from project files and stored separately.

## Architecture documentation

- [System architecture](docs/architecture.md)
- [Request lifecycle](docs/request-lifecycle.md)
- [Response lifecycle](docs/response-lifecycle.md)
- [Workspaces and navigation](docs/workspaces.md)
- [Environments, variables, and secrets](docs/environments-and-variables.md)
- [Authentication and cookies](docs/auth.md)
- [Persistence architecture](docs/persistence-architecture.md)
- [GraphQL](docs/graphql.md)
- [Imports and integrations](docs/imports-and-integrations.md)

Coding agents should start with [AGENTS.md](AGENTS.md), then follow its documentation map for the subsystem they are changing.

## Development

```bash
npm install
npm run dev
npm test
npm run typecheck
npm run lint
npm run build
npm run tauri dev
```

`npm run dev` uses the browser persistence adapter for UI development; native HTTP and desktop security behavior require Tauri. Playwright tests run with `npm run test:ui`. Rust tests run from `src-tauri` with `cargo test`.
