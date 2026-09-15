# Persistence architecture

This document is the source of truth for canonical project files, encrypted local runtime state, the secret vault, file projection, migrations, and recovery. The central rule is that runtime `Workspace` must never be serialized directly.

## Three ownership classes

### Canonical and shareable

Canonical data defines the project. It should produce useful diffs, merge across branches, move between machines, and remain stable when a user merely opens a tab or sends a request. It is validated by `src/domain/project.ts` and encoded by `src/storage/yaml.ts`.

### Local state

Local data is machine/session/editor specific or potentially large: drafts, inactive modes, tabs, layouts, cookies, schema caches, responses, and history. Desktop stores payloads encrypted in SQLite to avoid Git noise and protect potentially sensitive runtime material.

### Secret store

Credential-bearing values never belong in project files. Canonical definitions contain stable `SecretRef`s. On macOS one Keychain root key derives separate database and secret-vault AES-GCM keys; individual values live in SQLite `secret_values`.

`Secret ≠ masked`: asterisks in UI are not a persistence boundary.

## Ownership matrix

“Secret” means the row can carry credential material, not merely that it is visually hidden.

| Data | Runtime owner | Persistence | Git friendly | Secret | Reason |
| --- | --- | --- | --- | --- | --- |
| Workspace identity/description | `Workspace` | `purr.yaml` → `WorkspaceDefinition` | Yes | No | Portable project identity |
| User folders | `Workspace.extraResources` | `documents/**/.purr-folder.yaml`; physical path is hierarchy | Yes | No | Stable identity plus human-readable tree |
| Saved HTTP request | `RequestDocument.savedRequest` | `documents/**/*.yaml` | Yes | Definitions may contain refs | Shareable API definition |
| Saved GraphQL request | `GraphqlDocument.savedRequest` | `documents/**/*.yaml` | Yes | Definitions may contain refs | Same tree and transport model as HTTP |
| Schema source definition | `SchemaDocument.schemaSource` | `schemas/*.yaml` | Yes | Registry credential may be a ref | Reproducible source metadata |
| Pinned SDL | `SchemaDocument.sdl` | `schemas/*.graphql`, referenced from schema YAML | Yes | No by design | Offline/shareable schema snapshot |
| Imported OpenAPI schema | `Workspace.extraResources` | `schemas/*.yaml` metadata + referenced `schemas/*.openapi` source | Yes | No by design | Preserves the imported source and request-origin links without treating it as GraphQL SDL |
| Unpinned schema content | `SchemaDocument.sdl` | encrypted `schema_cache` | No | Potentially | Regenerable local cache |
| Environment definition | `Environment` | `environments/*.yaml` | Yes | Values may be refs | Shareable named configuration |
| Plain workspace/environment variable | `Variable(kind=static)` | `purr.yaml` or environment YAML | Yes | No | Intentional project input |
| Sensitive variable definition | `Variable(kind=static,sensitive)` | YAML metadata + `SecretRef` | Yes | Reference only | Share identity without value |
| Sensitive variable value | transient `Variable.value` | encrypted `secret_values` | No | Yes | Never enter Git-friendly files |
| Global variable definition | `WorkspaceStore.globalVariables` | encrypted global `workspace_local_state/variables` | No | Maybe | App-local, not owned by one project |
| Dynamic variable definition | workspace `Variable` | `purr.yaml` | Yes | Definition only | Shareable dependency/extraction contract |
| Dynamic variable cache | `Workspace.dynamicVariableCache` | encrypted `workspace_local_state/dynamic-variable-cache`; sensitive values use vault refs | No | Maybe | Environment/session/TTL-specific runtime result |
| Shared headers | `Workspace.requestConfig.headers` | `purr.yaml` | Yes | Should use variables for secrets | Project-wide request definition |
| Shared auth definition | `Workspace.requestConfig.auth` | `purr.yaml` with credential refs | Yes | Reference only | Share scheme/scope without credentials |
| Request auth credentials | active `RequestAuth` | `secret_values`, referenced by request YAML | No | Yes | Credential-bearing |
| OAuth access/refresh tokens | runtime auth token | versioned encrypted `workspace_local_state/auth-runtime` with vault refs | No | Yes | Acquired, machine/session-bound |
| Request draft / dirty working copy | `RequestDocument.request` | encrypted `drafts` | No | Maybe | Unsaved local editing state |
| Inactive body/auth editor modes | `RequestDraft` | encrypted `document_session_state.editor` with secret envelopes | No | Maybe | UX state, not active definition |
| Open/preview/active tabs | `Workspace.ui` | encrypted `workspace_local_state/state` | No | No | Machine/session navigation |
| Sidebar width/order/open state | `Workspace.ui` | encrypted `workspace_local_state/state` | No | No | Local layout preference |
| Request/response layout and split ratios | `Workspace.ui` | encrypted `workspace_local_state/state` | No | No | Local layout preference |
| Active environment | `Workspace.activeEnvironmentId` | encrypted `workspace_local_state/state` | No | No | Machine/session choice |
| Latest execution | `RequestDocument.lastResponse` | encrypted `request_executions` + adopted `response_contents` chunks; legacy `response_bodies` | No | Potentially | Restore latest response without polluting Git |
| Older execution history | not hydrated in ordinary runtime | same native tables | No | Potentially | Local indexed history backend |
| Response headers | `InlineHttpResponse.headers` / `HttpExchange.response.headers` | encrypted execution payload | No | Potentially | Runtime evidence can contain tokens/cookies |
| Response body | `HttpExchange.content` reference; transitional materialized viewer value | encrypted legacy `response_bodies`; native `response_contents` + encrypted chunks | No | Potentially | Large/sensitive execution data |
| Cookie metadata | `SessionCookie` | local `cookie_metadata` index columns | No | Metadata only | Queryable local jar inventory |
| Cookie values/full record | `SessionCookieJar` | encrypted `cookie_jar` payload | No | Yes | Session credential material |
| Canonical attachment | live `File` in `RequestBody` | content-addressed `assets/<sha256>.bin` | Yes | Not assumed; user-controlled | Required to reproduce saved request |
| Attachment runtime/editor state | inactive/live body modes | encrypted draft/session record; `attachments` table reserved | No | Potentially | Preserve local editor state |
| Integration definition | `extraResources` | `integrations/*.yaml` with credential refs | Yes | References only | Canonical extension-point shape; no runtime provider yet |
| Integration credentials | no working provider runtime | intended `SecretRef`/vault | No | Yes | Must never be embedded when implemented |
| Recent items | no current first-class UI projection | reserved encrypted `recent_items` table | No | No | Local navigation extension point |

Do not infer that a declared local table or canonical schema means the product feature is complete. `attachments` and `recent_items` are available storage tables but are not current first-class projection flows; integrations have a canonical shape but no provider runtime/UI.

## Canonical project layout

```text
<workspace>/
  purr.yaml
  documents/
    request.yaml
    Folder/
      .purr-folder.yaml
      nested-request.yaml
  schemas/
    schema.yaml
    schema.graphql
    imported-api.yaml
    api-schema-<id>.openapi
  environments/
    staging.yaml
  integrations/
    provider.yaml
  assets/
    <sha256>.bin
```

`purr.yaml` stores format version, workspace identity, workspace variables, shared headers, and shared auth definitions. Resource YAML files carry a `purr` format marker and strict resource shape.

Shared authentication profiles have stable canonical IDs. A request using inheritance stores only the selected `profileId`; the profile owns its scheme and credential `SecretRef`s. This permits several profiles with the same HTTP/GraphQL scope without duplicating credentials into request files.

HTTP and GraphQL request resources share `documents/`. Directory hierarchy is canonical; `.purr-folder.yaml` stores stable folder identity/name/metadata. Legacy `requests/` and `graphql/` roots are readable and migrated to this tree on save.

Pinned GraphQL schemas have a YAML definition plus SDL sidecar. Imported OpenAPI schemas use an `api-schema` YAML definition plus a `.openapi` UTF-8 source sidecar. Request attachments are content-addressed binary assets. `WorkspacePersistence` preserves existing safe basenames/paths where possible and owns referenced schema sidecars until their resource is explicitly removed.

## Projection boundary

`projectWorkspace` and `restoreWorkspace` in `src/application/project-projection.ts` are the only supported runtime/persistence conversion:

```text
Workspace
  → canonical Project                (definitions only)
  → LocalRecord[]                    (session/editor/cache/history)
  → assets Record<path, base64>      (reproducible file payloads)
  → SecureStore writes/SecretRefs    (credential values)
```

Projection intentionally:

- saves the baseline rather than dirty edits into canonical resources;
- removes synthetic empty editor rows and managed read-only rows;
- saves only the active body/auth canonical mode;
- protects credentials in dirty/inactive runtime objects before local serialization;
- separates latest response body for native local storage;
- associates a dirty draft with its canonical base for conflict detection.

`WorkspacePersistence` then maps canonical resource IDs to paths, serializes YAML, computes file/local diffs, and queues commits. Callers must not use `JSON.stringify(workspace)` or write individual files/DB rows as an alternative save path.

## Native filesystem safety and commit model

`src-tauri/src/persistence/project_files.rs` accepts only managed relative paths, rejects traversal and symlink escapes, and calculates SHA-256 revisions. Writes use same-directory temporary files, flush/sync, and atomic persist/rename. Deletes target individual resolved files; empty directories can remain.

Each `FileChange` includes `expectedRevision`. A mismatch aborts rather than overwriting an external edit. `src-tauri/src/persistence/runtime.rs` journals a cross-file/local commit in encrypted `pending_commits`, applies it, and clears the journal. Startup replays recoverable pending commits.

Workspace roots live in the local registry. Deleting a Purr-managed workspace deletes its managed project directory; deleting an attached external workspace unregisters it without deleting its external project files. Attach-directory support exists below the UI boundary only.

## External changes and conflicts

`WorkspacePersistence.watchChanges` performs a three-way comparison between loaded baseline, current projected state, and re-read external canonical files. Clean changes can be accepted and independent resources merged. Because `documents/` owns hierarchy, restoration takes a saved request’s `folderId` from its rescanned canonical path while preserving unrelated dirty editor content. Other concurrent changes to a dirty request definition still raise a conflict and preserve local edits.

If a save reaches the native revision preflight before the watcher has reconciled an external move or rename, the footer exposes an explicit **Reload and retry** action. It runs the same full-snapshot, three-way reconciliation first and only then retries the commit with current revisions. It never bypasses preflight or overwrites a true concurrent content conflict. A failed final save does not veto the native window close: the attempted commit remains non-destructive and the application exits without silently replacing the external file.

The Rust watcher uses `RecursiveMode::Recursive` for each registered project root. A change anywhere below `documents/` is coalesced for 180 ms and emitted as a full-workspace reload request. Full scanning is deliberate because a native rename may arrive as paired paths, separate create/delete events, a directory-only event, or a backend rescan notice. Notify overflow/rescan signals and watcher errors also force a full snapshot. Other resource roots retain path-specific reloads when the event identifies a canonical file.

## Local SQLite

`src-tauri/src/persistence/local_records.rs` creates schema migrations and the encrypted payload tables listed by `LocalTable`:

- `workspace_local_state`;
- `drafts`;
- `document_session_state`;
- `request_executions`;
- `cookie_jar`;
- `schema_cache`;
- `recent_items`;
- `attachments`.

Additional internal tables include `app_state`, `workspaces`, encrypted `pending_commits`, separated legacy `response_bodies`, `cookie_metadata`, `secret_values`, and the Phase 5 `response_contents`/`response_content_chunks` store. SQLite runs with WAL, full synchronous behavior, foreign keys, and a busy timeout.

Native response content has an explicit `staging`, `ready`, or `adopted` state. Chunks are at most 256 KiB and independently encrypted with AAD bound to their content identity and position. The content worker removes expired unowned records. Persisting a v2 execution adopts matching ready content in the same SQLite transaction; deleting that execution or workspace deletes its metadata and cascading chunks. Legacy inline `response_bodies` remain readable and are not deleted by the schema migration.

Native HTTP now creates staging content after receiving headers and appends through a bounded worker queue. Completion IPC returns only metadata and the opaque reference. Cancellation, read failure, size-limit failure, or compatibility-materialization failure releases the unadopted content; successful execution persistence adopts it.

General local-record payloads are AES-GCM encrypted with context/AAD bound to workspace/table/record identity. Execution document/time/status and cookie metadata columns remain plaintext indexes; execution bodies, full execution payloads, cookie values, drafts, and session state are encrypted.

Ordinary `read` returns only the newest execution per document. `history` queries indexed metadata with a before cursor and 1–100 limit. `WorkspacePersistence` retains older native execution rows even though the runtime projection contains only latest responses.

## Secure store

`SecureStore` is a typed frontend contract. `NativeSecureStore` maps it to `secure_get/set/delete/exists`. `storeCredential` writes a value and returns either a plain credential (only when explicitly allowed) or a secret ref.

On macOS `PlatformRootKeyStore` stores one 32-byte root in Keychain service `app.purr.credentials`. HKDF derives separate database, credential-vault, and response-content keys. Each native storage worker reads the root when it starts and retains only its derived cipher. If encrypted data exists and the Keychain item is missing, startup fails closed and does not generate a replacement key that would make old data unreadable.

Other native platforms currently fail closed because no root-key adapter is configured.

## Schema and data migrations

There are distinct migration responsibilities:

- YAML `projectFormatVersion` and tolerant development-shape rewrites in `storage/yaml.ts`;
- legacy monolithic workspace migration into project files/local records in `WorkspacePersistence.load`;
- legacy request root migration into `documents/`;
- SQLite schema migrations in `persistence/local_records.rs`;
- encrypted envelope/key migration in native secure/local modules;
- runtime record payload migration before strict restoration.

The last category is currently incomplete. Workspace auth runtime has an explicit `version: 1` parser and resets invalid runtime tokens safely. Request execution restore validates both legacy inline responses and `protocolVersion: 2` opaque-content descriptors; malformed execution records are skipped so they cannot block the workspace. Drafts, document session state, workspace UI state, dynamic cache, cookie records, and schema cache do not all have equivalent application-level shape versions. A schema-incompatible value in one of those records can still make `restoreWorkspace`/`validateWorkspace` reject the whole workspace. Any change to these record shapes must add tolerant decoding/migration and a regression fixture; deleting user state is not an acceptable automatic migration.

## Failure and recovery rules

- Invalid canonical YAML/project data is rejected without modifying source files.
- Missing attachment assets reject load rather than fabricate request data.
- External/dirty conflicts preserve both sources and stop the merge.
- Missing Keychain root with existing encrypted data fails closed.
- Failed secure writes may leave an unused secret ref/value, but code must never fall back to plaintext project/local storage.
- Autosave/flush failures stay visible. A failed revision-checked final save does not block native window close and does not overwrite the external file.
- Recovery must be explicit and minimal; do not silently discard drafts, cookies, history, or credentials.

## Imports and persistence

`persistImport` validates a normalized canonical project before committing it. Import is additive, rejects duplicate resource IDs and invalid/cross-workspace secret refs, writes transient secret values to `SecureStore`, then uses the normal `WorkspacePersistence` save path. No importer may bypass projection/storage safety or invent a parallel file layout. Full status is in [Imports and integrations](imports-and-integrations.md).

## Invariants for changes

- Canonical model changes update Zod schemas, YAML codec/migration, fixtures/tests, and docs together.
- New local tables or payload shapes update `LocalTable`, Rust migration/read/write logic, projection, compatibility handling, tests, and this matrix.
- New secret-bearing fields require explicit `SecretRef` projection and redaction before any project/local write.
- A project move/rename follows resource identity and revisions; do not derive identity only from filename.
- Runtime `Workspace` remains an aggregate, never a schema shortcut.

## Key files

- `src/domain/project.ts` — canonical schemas and cross-resource invariants.
- `src/application/project-projection.ts` — canonical/local/asset/secret classification and restoration.
- `src/application/workspace-persistence.ts` — paths, revisions, diffing, commit queue, migration, and external merge.
- `src/application/import-project.ts` — normalized import validation and additive commit.
- `src/storage/contracts.ts` — persistence/local/secure interfaces and table names.
- `src/storage/yaml.ts` — deterministic YAML serialization and compatible decoding.
- `src/storage/secrets.ts` — credential refs and protected runtime traversal.
- `src/application/ports/{persistence,credentials}.ts` — storage and secret contracts.
- `src/platform/tauri/application-services.ts` — Tauri storage and secure adapters; `src/storage/native-backend.ts` temporarily re-exports their class names.
- `src/storage/browser-backend.ts` — browser development persistence.
- `src-tauri/src/project_files.rs` — safe project path/file operations.
- `src-tauri/src/local_state.rs` — SQLite schema, encryption, history, cookie indexes, and vault.
- `src-tauri/src/secure_store.rs` — Keychain root and cryptographic key derivation.
- `src-tauri/src/persistence.rs` — registry, journals, Tauri commands, and watcher.
