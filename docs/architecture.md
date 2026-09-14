# Purr: architecture and current-state guide

> **For maintainers and coding agents.** Read this before changing persistence,
> transport, authentication, workspace data or an interaction that crosses feature
> boundaries. This is a description of the codebase as it exists today.

Purr is a local-first desktop API client. React/TypeScript provides editing and
request orchestration inside a Tauri 2 shell. Saved definitions are strict,
reviewable project files; UI state, drafts, executions and cookies are local;
credentials remain out of project files.

Use this alongside the detailed references:

- [Persistence architecture](persistence-architecture.md)
- [Authentication, OAuth and cookies](auth.md)
- [Workspaces and GraphQL](workspaces.md)

## 1. System at a glance

```text
React UI
  App → WorkspaceWorkbench → RequestWorkbench
          │                    ├─ request/auth/body/docs editor
          │                    └─ response, pending and error viewer
          └─ documents/tabs, environments, variables, cookies, settings

Application layer
  WorkspacePersistence ↔ project projection ↔ canonical Project schemas
          │
          ├─ Browser preview: IndexedDB (encrypted local/secret records)
          └─ Desktop: Tauri IPC
                       │
Rust native layer ─────┼─ HTTP and OAuth loopback callback
                       ├─ project files, watch/reload and atomic writes
                       ├─ encrypted SQLite local state/history/cookies
                       └─ macOS Keychain root key + encrypted secret vault
```

| Runtime | Persistence | Network/OAuth | Purpose |
| --- | --- | --- | --- |
| `yarn dev` | IndexedDB preview; local/secret records use WebCrypto | Intentionally unavailable; no browser-fetch fallback | UI work only |
| `yarn tauri dev` / packaged app | Filesystem projects + encrypted SQLite + native vault | Rust native transport and callback listener | Product runtime |

Browser preview is not equivalent to production desktop storage: it has no OS
credential vault, file watching or native transport.

## 2. Repository map and dependency rules

| Area | Paths | Owns |
| --- | --- | --- |
| App shell | `src/App.tsx`, `src/app/` | Root routing/composition. |
| Workspaces | `src/features/workspaces/` | Workspace aggregate, documents, tabs, variables, environments, settings. |
| Request workbench | `src/features/request-workbench/` | Request editor, auth/body/params, cookie jar, transport preparation, response UI. |
| GraphQL | `src/features/graphql/` | Query editor, variable dock, schema cache/import/introspection, explorer. |
| Shared | `src/shared/`, `src/styles/globals.css` | UI primitives, design tokens, keyboard config, CodeMirror theme. |
| Canonical domain | `src/domain/project.ts` | Zod-backed shareable entities and cross-resource validation. |
| Application | `src/application/` | Runtime ↔ canonical projection, ordered save/reload, import persistence. |
| Storage | `src/storage/` | YAML, backend contracts, native/browser adapters, secure-store helpers. |
| Native | `src-tauri/src/` | Tauri commands, HTTP/OAuth, project filesystem, SQLite and encryption. |
| Tests | `tests/`, Rust test modules | Domain/application, UI and native-boundary verification. |

Dependency direction is intentional:

```text
components/hooks → feature models/services → application → domain + storage contracts
native/browser adapters ────────────────────────────────┘
```

`src/domain/project.ts` must not import React, Tauri, YAML or SQLite. Do not make
the UI `Workspace` object the on-disk format; it contains editor rows, `File`
objects, responses, session/layout data and inactive drafts that are local-only.

## 3. First-class entities

### Workspace

`Workspace` (`features/workspaces/model/workspace.ts`) is the runtime aggregate:

- documents and their saved/working copies;
- workspace/global/environment variables and selected environment;
- workspace shared headers/auth;
- cookie jar and dynamic-variable cache;
- open/active/preview tabs, sidebar and layout/splitter preferences.

`WorkspaceDefinition` is its shareable projection: stable identity, description,
workspace variables, shared headers and shared auth. New installs create a
`Personal` workspace with one local blank HTTP document.

### Documents

| Kind | Runtime | Saved file | Current behavior |
| --- | --- | --- | --- |
| HTTP | `HttpDocument` | `documents/<slug>-<id>.yaml` | Full HTTP request definition. |
| GraphQL request | `GraphqlDocument` | `documents/<slug>-<id>.yaml` | HTTP transport plus GraphQL query envelope. |
| Schema | `SchemaDocument` | `schemas/<slug>-<id>.yaml`; optional `<id>.graphql` | Source definition; cache stays local unless SDL is pinned. |

`trace`, `benchmark` and `integration` are reserved document/resource concepts,
not complete editors. Do not imply they are supported before adding domain,
projection and storage behavior.

Saved requests keep a `savedRequest` snapshot alongside the editable `request`.
Saving commits the working copy. Clean saved documents open as one replaceable
italic preview tab; editing, double-clicking or dragging pins it. Meaningful
unsaved requests are recoverable local drafts; pristine blank tabs are omitted.

### Request draft

`RequestDraft` includes URL/method, headers, query params, all body-mode drafts,
full auth draft, cookie/workspace opt-outs, Markdown documentation and optional
GraphQL fields. Row IDs, disabled placeholder rows, inactive editor variants,
conversion metadata and `File` objects are runtime-only. Projection turns them
into ordered canonical pairs and asset references.

### Environments and variables

Effective variables are assembled in this exact order:

```text
global → workspace → selected environment
```

Later **enabled** definitions override earlier same-name values. Duplicate names
inside one scope and workspace/environment name overlap are rejected. A reference
to a disabled variable fails explicitly instead of resolving silently.

| Variable kind | Current scope | Behavior |
| --- | --- | --- |
| `static` | global, workspace, environment | Literal or secret-store-backed value. |
| `dynamic-request` | global/workspace only | Runs a saved source request then extracts JSON through jq/JSONPath. |
| `external-secret` | reserved canonical type | Provider-neutral placeholder; no provider resolver yet. |

Templates use `{{name}}`; editor text remains templated and resolution happens only
before execution. It covers URL, enabled query/header names/values, supported text
bodies, GraphQL query/variables/operation name and auth configuration, never binary
bytes. Static variables can depend on static variables. Dynamic resolution detects
named request/variable cycles and supports `every-time`, `session` and TTL cache
policies. Cache keys include variable and source environment.

Environment variables must remain static. Sensitive dynamic-cache values are
protected before local persistence.

### Shared request configuration

Workspace settings define shared headers and auth profiles scoped to `all`, `http`
or `graphql`. Requests can disable inherited headers/auth/cookies and exclude named
shared header IDs. `applyWorkspaceRequestConfig` builds an effective request without
mutating the stored request definition.

## 4. Request lifecycle

The send sequence in `RequestWorkbench` and request services is an invariant:

```text
validate non-empty URL
  → mark document request as sending / focus response
  → resolve static and dynamic variables
  → apply workspace config and resolve auth
  → validate and serialize active body
  → build true wire request + redacted display request
  → run cookie/redirect policy and native HTTP
  → attach success/error to originating document
  → persist local session, cookie and execution state
```

Empty URLs focus the URL input and do not send. Variable, auth, body and URL errors
are Response UI states with one **Error** tab, rather than transient global notices.
An old in-flight completion is ignored after cancellation or if it no longer owns
the document/environment session.

### Request preparation in TypeScript

Frontend code currently resolves templates and constructs the outgoing request.
`prepareWireRequest`/`executeRequest` generate `Content-Type`, auth bindings and
base64 IPC body bytes. Managed auth headers, auth query parameters and body
`Content-Type` are read-only in the UI so they cannot race with manual duplicates.

Supported body modes are `none`, JSON, XML, text, form-data, URL-encoded and
binary. JSON/XML validation blocks invalid structured bodies. Multipart uses a
stable draft boundary. Attachments are content-addressed project assets at
`assets/<sha256>.bin` and preserve original bytes.

GraphQL shares HTTP auth, templates, headers and cookies. It is sent as
`POST application/json` with `query`, object `variables`, and optional
`operationName`. It does not replace the editor source with the generated envelope.
Subscriptions are deliberately unsupported: there is no streaming transport.

### Redirect/cookie policy

`services/http-client.ts` owns logical redirects, at most 10 hops:

- only HTTP(S) URLs without embedded credentials;
- matching jar cookies merge with manual cookies; manual cookie names win;
- every response hop contributes `Set-Cookie`;
- HTTPS → HTTP redirects are blocked;
- cross-origin redirects lose authorization/API-key/Cookie and other sensitive
  headers, plus configured sensitive query parameters;
- POST behavior follows the 301/302/303 conversion rules;
- a redacted display request is retained separately from the real wire request.

## 5. Response lifecycle

`HttpResult` contains the native response, decoded text, byte size, final URL and a
timeline (`prepare`, `waiting`, `download`). Response state belongs to a document,
not the currently selected tab.

| State | Contract |
| --- | --- |
| Not sent | Empty Response surface. |
| Sending | Previous result hidden; response tabs disabled; elapsed waiting UI; `Esc` cancels UI ownership. |
| Error | Only **Error** response tab with safe message. |
| Success | Response, Headers, Cookie, Timeline and Request; Trace is reserved/disabled. |

The viewer detects JSON/XML/HTML/text/image/audio/video/binary from content type and
conservative sniffing. It supports pretty/raw/hex/base64, jq/JSONPath queries and
creating static or dynamic variables from JSON paths. HTML is rendered only in a
sandboxed iframe with restrictive injected CSP. Binary formats offer a native save
dialog rather than unsafe preview. Response filenames are sanitized.

GraphQL results split `data`, `errors` and `extensions`; HTTP status stays visible.
Errors expose message, path, source locations and extension code when provided.

## 6. Persistence, file layout and synchronization

### Ownership classes

| Class | Contains | Storage | Shareable/Git-safe |
| --- | --- | --- | --- |
| Canonical project | Saved definitions, pinned SDL, attachments | YAML/SDL/assets workspace directory | Yes; author is responsible for any explicit plaintext value. |
| Encrypted local state | Drafts, tabs/layout, inactive editor forms, executions, responses, cookies, schema/dynamic caches | `local-state.sqlite3`, outside project directory | No. |
| Credential vault | Secret variables, auth secrets, OAuth tokens, sensitive dynamic cache | Encrypted SQLite `secret_values`, rooted in Keychain key | No. |

```text
<app-data>/projects/<workspace-id>/
  purr.yaml
  documents/<slug>-<id>.yaml   # HTTP and GraphQL requests
  environments/<slug>-<id>.yaml
  schemas/<slug>-<id>.yaml
  schemas/<id>.graphql          # only pinned SDL
  documents/<folder>/.purr-folder.yaml # folder marker; the directory is canonical
  integrations/<slug>-<id>.yaml
  assets/<sha256>.bin

<app-data>/local-state.sqlite3  # outside project directory
```

Canonical YAML starts with `purr: 1`, validates strictly and is deterministic.
Unknown fields/versions, aliases, duplicate mappings and malformed resources fail
closed. Raw JSON/XML/text/GraphQL source remains a scalar string, not a reshaped
YAML object. Unchanged parsed resources preserve their original bytes/comments;
changed definitions use deterministic serialization.

### Persistence bridge

Never persist `Workspace` directly. Required path:

```text
runtime Workspace
  → projectWorkspace() / projectGlobalVariables()
  → validateProject()
  → WorkspacePersistence
  → native or browser PersistenceBackend
```

`WorkspacePersistence` serializes saves, stores revisions and coordinates project
files with local records. Native writes use a same-directory temporary file, fsync
and atomic rename. An encrypted local journal replays interrupted file/SQLite
commits. This is crash recovery, not a global filesystem transaction.

Project files are watched and debounced. Purr merges non-conflicting external
changes, but refuses malformed files or a dirty working-copy conflict. Preserve
both the external bytes and local work; do not auto-overwrite to "fix" a conflict.

## 7. Security model and non-negotiable rules

### At-rest encryption

macOS stores one random 256-bit root key in its Keychain:

```text
service: app.purr.credentials
account: purr/local-storage/master-key-v1
```

Rust reads it once per persistence lifetime and derives independent database and
secret-vault keys using HKDF-SHA256. Local records and credentials use AES-256-GCM,
random 96-bit nonces and authenticated context. Missing Keychain material with
existing encrypted data fails closed; the app never creates a replacement key that
would strand existing data.

Secret refs are stable workspace-scoped IDs, e.g.
`purr/<workspace>/environments/<environment>/<variable-id>`. They use IDs rather
than display names, so rename/move does not change the secret address. Canonical
validation rejects cross-workspace references.

Windows/Linux secure-store adapters deliberately fail closed today. Do not claim
secure desktop support on those platforms until their native vaults exist.

### Rules for all contributors

1. Never put secrets in YAML, filenames, telemetry, logs, error strings, import
   previews, test snapshots or display requests.
2. Treat passwords, API keys, bearer/OAuth tokens, cookie values and sensitive
   variable/cache values as credentials. Persist them with `Credential`/`SecretRef`
   and `SecureStore`.
3. `sensitive` storage and reveal/hide UI are independent. Masking is not security.
4. Keep a redacted display request apart from true wire data.
5. Importers must send transient secret values directly to `SecureStore`; normalized
   project data and diagnostics carry refs only.
6. Validate every native path/value again in Rust. Project file paths are allowlisted,
   traversal/symlinks rejected and revisions checked before writes.
7. Do not introduce browser `fetch` fallback; desktop traffic must use native policy.

### Important current limitations

- Request/auth/template construction occurs in JS before `send_http`; secret values
  can transiently exist in frontend memory to be edited/revealed/sent. At-rest
  encryption does not protect against a compromised process or deliberate reveal.
- Tauri CSP is currently `null` in `src-tauri/tauri.conf.json`. CSP hardening is
  required before remote webview/content features are added.
- No backup/key-recovery UI, secret/asset garbage collection, directory chooser or
  conflict-resolution UI exists yet.
- Manual plaintext headers/bodies are allowed and cannot be automatically classified
  as secrets. Prefer secret variable references.

## 8. Rust boundary and IPC

Rust should own OS, filesystem and byte-level networking; it should not become a
parallel UI/domain model.

| Native command family | Rust module | Frontend boundary | Notes |
| --- | --- | --- | --- |
| HTTP | `http.rs` | `nativeTransport` | Validates method/headers/URL, 60 s timeout, no automatic redirects, 20 MiB preview cap. |
| OAuth | `oauth.rs` | auth runtime/client | Opens browser; IPv4 loopback callback validates origin/path/state, 3-minute timeout. |
| Persistence | `persistence.rs`, `project_files.rs`, `local_state.rs` | `NativePersistenceBackend` | Load/commit/watch/reload/delete/attach projects and local state/history. |
| Vault | `secure_store.rs`, `local_state.rs` | `NativeSecureStore` | `secure_get/set/delete/exists`; root key never crosses IPC. |
| Download | `downloads.rs` | `download-response.ts` | Native picker with sanitized names/extensions and original bytes. |

When adding IPC: make a narrow typed frontend adapter; validate all untrusted
inputs in Rust; return sanitized errors; add Rust and frontend/UI tests; keep Tauri
capabilities least-privilege.

## 9. UI rules

`AGENTS.md`, `src/styles/globals.css` and `tailwind.config.ts` are binding:

- use named Purr color/spacing/radius/typography/motion/shadow tokens only;
- use shared primitives under `src/shared/components/ui`;
- `font-ui` for UI, `font-code` for URLs/methods/headers/payloads/shortcuts;
- use `ui-focus-ring` for focusable controls;
- keep the Obsidian theme until a complete tokenized alternative is introduced.

URL colorization is an overlay over a real accessible input. Preserve native input
editing/selection. It splits protocol, host/base, path and query; literal `graphql`
gets GraphQL accent without recoloring its surrounding URL segment.

Request docs are stored as Markdown. Preview is default; editing is explicit via a
floating control and ends with fixed Save/Cancel actions.

## 10. Testing and safe extension checklist

```bash
yarn test
yarn test:ui
yarn typecheck
yarn lint
yarn build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

Use TypeScript tests for pure domain/request/projection rules, Playwright for visible
flows/shortcuts/layout, and Rust tests for native filesystem/HTTP/crypto invariants.
Tauri mocks are UI contracts, not proof of native security.

For any new persisted entity or credential-bearing field:

1. Add canonical Zod schema and invariant in `domain/project.ts`.
2. Extend YAML and bidirectional projection.
3. Choose canonical-project vs encrypted-local vs vault ownership explicitly; add a
   local SQLite migration when its shape changes.
4. For secrets, use stable `SecretRef`, `storeCredential`, `protectRuntime` and
   redaction audits; verify YAML only has the reference.
5. Add round-trip/migration tests, then visible UI tests.

Current deliberate roadmap boundaries: full Postman/OpenAPI importers and UI, cloud
sync/Git/provider integrations, Windows/Linux vaults, GraphQL subscriptions,
trace/benchmark runtime models, history/recovery UX and moving all request
construction from JS to Rust. Extend the canonical model and this document before
inventing a parallel persistence path across one of these boundaries.
