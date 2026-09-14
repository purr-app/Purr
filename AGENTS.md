# Purr agent guide

## Project identity

Purr is a local-first desktop API client built with React/TypeScript and Tauri/Rust. Treat the canonical project files, encrypted local runtime state, and secret values as three different ownership classes: project YAML/assets are portable and Git-friendly; UI/session/cache/history state is local; credentials live behind `SecretRef` in `SecureStore`.

## Repository map

- `src/App.tsx` and `src/app/` own the application shell and top-level routing.
- `src/features/workspaces/` owns the runtime workspace aggregate, document tree, tabs, navigation, variables, and workspace settings.
- `src/features/request-workbench/` owns request editing, composition, execution orchestration, and response presentation.
- `src/features/graphql/` owns GraphQL request editing, schema parsing/introspection, language support, and schema exploration.
- `src/domain/` owns storage- and UI-independent canonical project schemas and validation.
- `src/application/` owns projection between runtime and canonical models, persistence orchestration, and import commits.
- `src/storage/` owns typed persistence/secret contracts, YAML codecs, and native/browser adapters.
- `src-tauri/src/` owns OS, filesystem, encrypted SQLite/Keychain, OAuth callback, download, HTTP transport, and large collection import/parsing boundaries.
- `src/shared/` owns reusable UI primitives, design tokens/theme integration, shared utilities, and shortcut configuration.
- `tests/` owns TypeScript unit/integration tests and Playwright UI tests; Rust module tests live beside `src-tauri/src/*.rs`.

## Architecture rules

- Runtime `Workspace` is not a persistence schema. Project it through `projectWorkspace`; restore it through `restoreWorkspace`.
- `src/domain/project.ts` is the canonical project model and must not depend on React, Tauri, SQLite, filesystem paths, or YAML syntax.
- Keep shareable definitions deterministic, diffable, mergeable, and Git-friendly. Do not put drafts, tabs, layout, responses, history, caches, or other local/session state in project YAML.
- A masked value is not a secret. Credential-bearing values must be represented by stable `SecretRef`s and stored through `SecureStore`, never copied into project YAML or plaintext local payloads.
- Native filesystem, network, Keychain, OAuth callback, and download operations cross typed adapters/IPC. Browser fallbacks must not silently change desktop security or transport semantics.
- Request composition has one path: workspace inheritance, variable resolution, auth/body preparation, cookie/redirect policy, then native transport. Do not create parallel request-building or storage paths.
- Preserve enabled/disabled rows, duplicates, inactive editor modes, and the saved-versus-working-copy distinction unless a product change explicitly changes their lifecycle.
- Treat canonical format and local-record shape changes as migrations. Do not make old local state prevent a workspace from opening.

## Documentation map

- System boundaries, dependency direction, repository ownership: `docs/architecture.md`.
- Request composition, path/query/header/body/auth order, cURL paste/copy: `docs/request-lifecycle.md`.
- Native response, normalization, viewers, jq/JSONPath subset, history and cancellation: `docs/response-lifecycle.md`.
- Workspaces, folders, sidebar, tabs, layouts, external changes: `docs/workspaces.md`.
- Variable scopes, dynamic resolution, caches, and secret variables: `docs/environments-and-variables.md`.
- Auth schemes, OAuth lifecycle, and the workspace cookie jar: `docs/auth.md`.
- Canonical files versus encrypted SQLite versus secret vault, migrations and recovery: `docs/persistence-architecture.md`.
- GraphQL requests, schemas, introspection, editor services, and limitations: `docs/graphql.md`.
- Import boundary, current cURL support, reserved integrations and tracing: `docs/imports-and-integrations.md`.

## Documentation maintenance

Architecture-affecting changes are incomplete until the relevant documentation is updated. Update docs when a change adds a first-class entity, changes data ownership or request/response lifecycle, adds a persistence format/table/file, adds an import/provider/integration, changes an IPC/API boundary, changes Git-friendly/local/secret classification, or introduces a major UI/runtime mode. Update roadmap/reserved claims when imports, tracing, benchmark/history, or another concept becomes working functionality. Small implementation details that do not alter these contracts do not require a docs change.

Independent research, tests/review, or disjoint implementation may be delegated to subagents when their write scopes do not overlap. The coordinating agent remains responsible for reconciling results and verifying the integrated change.

## Purr UI system guardrails

All UI work must use the Purr design system declared in `src/styles/globals.css` and exposed by `tailwind.config.ts`.

- Use only the named palette tokens: `purr`, `border`, `content`, `action`, `accent`, `syntax`, `method`, `status`, and `mac`. Reuse `accent` for a raw palette colour outside its method or status meaning; do not repurpose `method-*` colours for generic UI. Code editors use the `syntax` and `editor-*` theme tokens through `src/shared/theme/code-editor-theme.ts`.
- Do not introduce hex, RGB/RGBA, HSL colours, Tailwind arbitrary colour values, or new colour names in component files. Add an approved token first when a new semantic role is genuinely needed.
- Use `font-ui` (Space Grotesk) for application UI and `font-code` (Google Sans Code) for URLs, HTTP methods, shortcuts, headers, bodies, payloads, and other protocol/code content.
- Use the `ui-*` spacing, radius, control-height, typography, duration, and shadow tokens. Do not use arbitrary pixel values for visual geometry. Add a rem-based token in `globals.css` and expose it in Tailwind if the current scale is insufficient.
- Use `ui-focus-ring` for focusable controls. Focus colours, borders, surfaces, and interaction states must come from the theme tokens.
- Reuse components from `src/shared/components/ui` and add shared primitives there rather than duplicating control styling in feature code.
- Keep the dark Obsidian theme as the active theme until a complete, tokenized alternative theme is explicitly introduced.
