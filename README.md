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
- [Public core, extensions, and native-engine migration plan](docs/modular-architecture-migration-plan.md)

Coding agents should start with [AGENTS.md](AGENTS.md), then follow its documentation map for the subsystem they are changing.

## Development

```bash
npm ci
npm run dev
npm test
npm run typecheck
npm run lint
npm run build
npm run tauri dev
```

`npm run dev` uses the browser persistence adapter for UI development; native HTTP and desktop security behavior require Tauri. Playwright tests run with `npm run test:ui`. Rust tests run from `src-tauri` with `cargo test`.

npm is the only supported JavaScript package manager. The repository pins it through `packageManager` and commits `package-lock.json`; dependency upgrades should be separate from architecture changes. On macOS, the development runner uses ad-hoc signing by default. Set `PURR_DEV_SIGNING_IDENTITY` in the local shell when a persistent Apple Development identity is required. Release signing and notarization credentials are supplied by release CI and never belong in repository configuration.

The root package reserves the public identity `@purr/core` at version `0.1.0` and remains unpublished while the migration is in progress. `npm run build:core` emits the supported JavaScript, declarations, CSS, worker assets, and curated `./app`, `./extension-api`, `./ui`, `./test-kit`, and `./styles` exports into `dist-core`. React and React DOM are peer dependencies so an official shell owns the single runtime instance. Consumers must not import source paths such as `src/features/*`.

`npm run check:core-package` builds the example external frontend and Rust/Tauri shell under `tests/fixtures/core-consumer`, validates package exports and the React singleton, and compiles a fake native provider/plugin through the public composition API. `npm run check:core-determinism` confirms two clean core artifact builds are byte-identical.

## Licensing

The public Purr core in this repository is licensed under the [MIT License](LICENSE). The Purr name and branding are governed separately by the [trademark policy](TRADEMARK.md). Some integrations and commercial features may be developed and distributed separately under proprietary licenses and are not covered by this repository's MIT License.
