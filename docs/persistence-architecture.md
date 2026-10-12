# Persistence architecture

This document is the source of truth for canonical project files, encrypted local runtime state, the secret vault, file projection, migrations, and recovery. The central rule is that runtime `Workspace` must never be serialized directly.

## Three ownership classes

### Canonical and shareable

Canonical data defines the project. It should produce useful diffs, merge across branches, move between machines, and remain stable when a user merely opens a tab or sends a request. It is validated by `src/domain/project.ts` and encoded by `src/storage/yaml.ts`.

### Local state

Local data is machine/session/editor specific or potentially large: drafts, inactive modes, tabs, layouts, cookies, schema caches, responses, and history. Desktop stores payloads encrypted in SQLite to avoid Git noise and protect potentially sensitive runtime material.

### Secret store

In canonical format v2, protected literal and mixed-expression values never belong in project files. Definitions contain stable `SecretRef`s or explicit pure-template credentials. Public user-classified inputs remain public; a reference to a public variable does not encrypt that variable. Legacy v1 files can still contain credential literals until their explicit upgrade succeeds. On macOS one user-only application-storage root key derives separate database and secret-vault AES-GCM keys; individual values live in SQLite `secret_values`.

`Secret ≠ masked`: asterisks in UI are not a persistence boundary.

## Ownership matrix

“Secret” means the row can carry credential material, not merely that it is visually hidden.

| Data | Runtime owner | Persistence | Git friendly | Secret | Reason |
| --- | --- | --- | --- | --- | --- |
| Workspace identity/description | `Workspace` | `purr.yaml` → `WorkspaceDefinition` | Yes | No | Portable project identity |
| User folders | `Workspace.extraResources` | `documents/**/.purr-folder.yaml`; physical path is hierarchy | Yes | No | Stable identity plus human-readable tree |
| Saved HTTP request | `RequestDocument.savedRequest` | `documents/**/*.yaml` | Yes | Definitions may contain refs | Shareable API definition |
| Saved GraphQL request | `GraphqlDocument.savedRequest` | `documents/**/*.yaml` | Yes | Definitions may contain refs | Same tree and transport model as HTTP |
| Saved extension document | `ExtensionDocument.savedConfig` | `documents/**/*.yaml` with opaque versioned JSON config | Yes | No | Module-owned portable definition; credentials and local paths are forbidden in opaque config |
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
| Shared headers | `Workspace.requestConfig.headers` | `purr.yaml` | Yes | Marked values use refs/templates | Stable header identity and explicit sensitivity |
| Request transport/cookie policy | `RequestDraft.settings` and `useCookieJar` | Optional `settings` and `overrides.cookies` in saved HTTP/GraphQL YAML | Yes | No | Saved baseline only; unsaved overrides remain in encrypted drafts |
| Trace propagation preference | Workspace request config / saved request | Optional `tracePropagation` format ID in workspace/request YAML | Yes | No | Definition only; absent means off/inherit, generated IDs never enter canonical definitions |
| Observability integration | `Workspace.extraResources` | `integrations/*.yaml`, opaque versioned config + scoped SecretRefs | Yes | Reference only | Native descriptor validates config; credential values stay in the vault |
| Trace lookup result/cache | Rust observability service / React bounded presentation | Bounded memory cache only | No | Potentially | No new persisted trace table; correlation reads the exact encrypted execution metadata |
| Shared auth definition | `Workspace.requestConfig.auth` | `purr.yaml` with credential refs | Yes | Reference only | Share scheme/scope without credentials |
| Request auth credentials | active `RequestAuth` | `secret_values`, referenced by request YAML | No | Yes | Credential-bearing |
| OAuth access/refresh tokens | runtime auth token | versioned encrypted `workspace_local_state/auth-runtime` with vault refs | No | Yes | Acquired, machine/session-bound |
| Request draft / dirty working copy | `RequestDocument.request` | encrypted `drafts` | No | Maybe | Unsaved local editing state |
| Extension-document draft / dirty working copy | `ExtensionDocument.config` | encrypted `drafts` | No | No by contract | Preserves edits and saved baseline even when the owning module is unavailable |
| Inactive body/auth editor modes | `RequestDraft` | encrypted `document_session_state.editor` with secret envelopes | No | Maybe | UX state, not active definition |
| Open/preview/active tabs | `Workspace.ui` | encrypted `workspace_local_state/state` | No | No | Machine/session navigation |
| Sidebar width/order/open state | `Workspace.ui` | encrypted `workspace_local_state/state` | No | No | Local layout preference |
| Request/response layout and split ratios | `Workspace.ui` | encrypted `workspace_local_state/state` | No | No | Local layout preference |
| Active environment | `Workspace.activeEnvironmentId` | encrypted `workspace_local_state/state` | No | No | Machine/session choice |
| Latest execution | `RequestDocument.lastResponse` | encrypted `request_executions` + adopted `response_contents` chunks; legacy `response_bodies` | No | Potentially | Restore latest response without polluting Git |
| Older execution history | metadata lists; immutable snapshot hydrated on selection | same native tables plus retained history attachments | No | Potentially | Local indexed history UI |
| Response headers | `InlineHttpResponse.headers` / `HttpExchange.response.headers` | encrypted execution payload | No | Potentially | Runtime evidence can contain tokens/cookies |
| Response body | `HttpExchange.content` reference; transitional materialized viewer value | encrypted legacy `response_bodies`; native `response_contents` + encrypted chunks | No | Potentially | Large/sensitive execution data |
| Cookie metadata | `SessionCookie` | local `cookie_metadata` index columns | No | Metadata only | Queryable local jar inventory |
| Cookie values/full record | `SessionCookieJar` | encrypted `cookie_jar` payload | No | Yes | Session credential material |
| Canonical attachment | live `File` in `RequestBody` | content-addressed `assets/<sha256>.bin` | Yes | Not assumed; user-controlled | Required to reproduce saved request |
| Attachment runtime/editor state | inactive/live body modes | encrypted `attachments` row referenced by draft/session records | No | Potentially | Preserve local editor state without repeating file bytes in every editor snapshot |
| Integration definition | `extraResources` | `integrations/*.yaml` with opaque JSON config and credential refs | Yes | References only | Canonical envelope and unavailable-provider management; no runtime provider yet |
| Integration credentials | explicit `credentials` map | `SecretRef` in YAML, value in vault | No | Yes | Provider-owned config is not scanned or treated as credential storage |
| Recent items | no current first-class UI projection | reserved encrypted `recent_items` table | No | No | Local navigation extension point |

Do not infer that a declared local table or canonical schema means the product feature is complete. `recent_items` is available storage but is not a current first-class projection flow; integrations have a canonical envelope and unavailable-provider management UI but no provider runtime or provider settings editor.

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

## Format v2 and explicit upgrade

Readers accept canonical `purr: 1` and `purr: 2`; writers default to v2. A decoder returns source-version/migration metadata beside the normalized model. V1 normalization is pure: legacy literal credentials remain available to the migration planner without writing the vault. Unsupported future markers and mixed-version workspaces are rejected without rewriting their files.

V2 credentials are `secret {ref}`, `template {value}` or, only for public fields, `plain {value}`. A protected credential is a template only when the shared parser finds exactly one nonempty reference with whitespace outside it; the original expression is preserved. Additional references, nested/malformed braces, or literal segments require protection of the whole expression. Bearer, Basic password, API-key value, OAuth client secret and declared integration credentials cannot be public literals in v2. Public auth configuration such as username/client ID remains public.

Request, shared and introspection headers have `{id, name, enabled, sensitive, value: Credential}`. Existing IDs survive conversion; rows without IDs receive `legacy-header-<originalIndex>` once during legacy normalization, scoped by their owning resource. Later reordering/renaming never changes the persisted ID or ref. Duplicate names and disabled rows remain distinct. Explicit sensitivity persists; exact Cookie/Set-Cookie roles are protected, while arbitrary Authorization or custom API-key names are not classified by a save-time heuristic. Provider-owned opaque config and schema/assets remain outside generic secret detection.

Opening v1, changing layout, automatic flush and application close do not authorize an upgrade. The first explicit Save confirms the workspace-wide compatibility change. Its S01 commit upgrades all owned canonical YAML markers together, including untouched resources, plus their required secret/local changes. Failed or uncertain publication does not clear the migration flag or publish new caches. Saved and dirty copies retain separate ownership. Local-only persistence may continue when its protected baseline is readable; it cannot replace v1 files with normalized defaults. Upgrade repairs current definitions, not existing Git history or external copies.

While v1 remains open, `projectWorkspace` writes pending definition edits to the encrypted `workspace_local_state/legacy-definition-draft` record as a versioned definition overlay. `restoreWorkspace` reads that DTO; it is not a serialized runtime `Workspace`. Workspace UI, cookies and dynamic caches retain their separate local owners. The overlay records the complete source-file list and revisions, including schema sidecars and assets. External changes, additions or removals prevent applying the old overlay and enter `recovery-required` with `legacy-definition-conflict` without overwriting either source. Future or malformed overlay versions remain opaque and read-only. Importing resources into an existing v1 workspace also requires its explicit upgrade before imported credentials are staged.

## Availability and required local secrets

`StoredWorkspace`/`StorageSnapshot.protectedState` distinguishes available storage from locked, unavailable, corrupt, denied or recovery-required state. Canonical-only fallback is read-only for protected writes: an empty placeholder `local` array is not authoritative, and drafts, history, cookies and caches are preserved. `retry_protected_storage` reopens storage and rehydrates the owning snapshot; it is not a reset or key replacement. Independent plaintext runtime operation is a later storage-policy phase, not a guarantee of degraded mode.

Restoration retains unresolved refs/field states instead of fetching every credential. Send/OAuth/introspection/resolved-code operations resolve only enabled required fields and their transitive variables. An absent value is actionable rather than silently substituted with an empty string; an intentionally stored empty value remains available, although protocol validation can still reject it.

Required local secrets inventories canonical definitions and current typed working copies, including transitive environment/global dependencies. It does not enumerate the vault, cookies, tokens or execution history. Status inspection discards returned values; available expression text is used transiently to discover further dependencies. Unreadable expressions may conceal additional dependencies until restored. Set value starts blank, accepts empty, and Remove local value is explicit; unknown/corrupt baselines disable editing.

Its configuration sharing preview counts public credential/header/static-variable fields, omitted secret refs and missing/unavailable declarations. It preserves declarations conceptually and warns about v1 literals; it creates no configuration archive. Workspace/environment/global/Postman configuration export is not implemented. Selective encrypted transfer and key recovery remain S06, with global dependencies excluded from workspace files by default.

## Projection boundary

`projectWorkspace` and `restoreWorkspace` in `src/application/project-projection.ts` are the only supported runtime/persistence conversion:

```text
Workspace
  → canonical Project                (definitions only)
  → LocalRecord[]                    (session/editor/cache/history)
      → attachments/<digest>         (encrypted local working-copy bytes)
  → assets Record<path, base64>      (reproducible file payloads)
  → prepared SecretBatch/SecretRefs (credential values; publication is separate)
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

Each `FileChange` includes `expectedRevision`. A mismatch aborts rather than overwriting an external edit. Projection prepares canonical/local/asset changes and a transient `SecretBatch`; it never updates the active vault. Mutations carry the expected monotonic credential revision and an operation ID.

`persistence/commit_coordinator.rs` validates and prepares all changes before making an encrypted version-2 `pending_commits` journal containing file preimages and staged mutations. Files are applied first. Local records, secret values/revisions, workspace registration, committed receipt and journal removal then publish in one SQLite transaction. Secret-only and global commits use the same path. Preparation uses a rolled-back SQLite transaction to validate local records and content/attachment adoption before touching project files.

A handled failure conditionally restores only files whose current revision still matches this operation's output. An external edit or unsafe rollback leaves an explicit recovery-required operation; it is never overwritten to simulate an abort. Startup rolls back unpublished version-2 operations without later silently publishing their credentials. Older version-1 journals retain their legacy replay behavior. The filesystem and SQLite are not one atomic visibility boundary for external tools; application access is serialized and recovery provides a coherent result.

An encrypted terminal receipt retains the full-request fingerprint and result, not staged secret values. Reusing an operation ID for a different request is rejected. Lost acknowledgements are checked through `secure_operation_status`; known native rejections are not reinterpreted as successes. Caches change only after confirmed publication and are invalidated on uncertain/failed operations. A separate active-workspace selection failure cannot turn a committed import into a failed import.

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

Additional internal tables include `app_state`, `workspaces`, encrypted `pending_commits`, separated legacy `response_bodies`, `cookie_metadata`, `secret_values`, `history_attachments`, `history_attachment_links`, and the Phase 5 `response_contents`/`response_content_chunks` store. SQLite runs with WAL, full synchronous behavior, foreign keys, and a busy timeout.

SQLite migration 6 adds `secret_revisions` (monotonic revision tombstones), encrypted `secret_operations` receipts and encrypted `workspace_cleanup` jobs. Existing credentials begin at revision 1; absence begins at revision 0. Insert/update/delete, including history/workspace cleanup, advances revisions so a stale save cannot recreate a deleted value using an old absence check. Set-to-empty and delete are distinct throughout the editor contract: clearing a credential stores an available empty string; Remove local value explicitly creates a missing value while preserving its declaration. Browser preview uses equivalent IndexedDB transactions and encrypted receipts; it does not compensate failed publication with a later deletion.

Workspace deletion publishes local/vault removal and an encrypted managed-directory cleanup intent atomically. Directory cleanup then quarantines unchanged files and runs independently; a filesystem failure reports committed deletion with cleanup pending, clears runtime caches and retries on startup. Only a filesystem NotFound result counts as absence; permission or I/O errors cannot acknowledge cleanup. Pending cleanup reserves its workspace ID/path and never deletes an externally recreated source directory. An unreadable cleanup intent does not block existing workspace startup/reads; it conservatively blocks new saves/attachments when reserved paths cannot be checked. Externally attached project directories remain user-owned. Browser workspace/history deletion joins metadata removal and secret tombstones in one IndexedDB transaction, including namespace membership checks against concurrent additions.

Watcher changes arriving during pending recovery are deferred to a wildcard rescan instead of discarded. Commit serialization is per application process; this is not an OS-wide filesystem lock. Journals are bounded at 256 MiB and cleanup snapshots at 100,000 entries. Terminal receipts remain durable for idempotent reconciliation; they are not a second plaintext credential store.

Native response content has an explicit `staging`, `ready`, or `adopted` state. Chunks are at most 256 KiB and independently encrypted with AAD bound to their content identity and position. The content worker groups up to 8 MiB of chunks per transaction and accepts at most two transport write batches in flight, allowing encryption/SQLite work to overlap network reads without unbounded buffering. It uses WAL `synchronous=NORMAL`: response bodies are reconstructible local runtime data, while canonical/local-record commits keep `synchronous=FULL`. The content worker removes expired unowned records. Persisting a v2 execution adopts matching ready content in the same SQLite transaction; deleting that execution or workspace deletes its metadata and cascading chunks. Legacy inline `response_bodies` remain readable and are not deleted by the schema migration.

Native HTTP now creates staging content after receiving headers and appends through a bounded worker queue. Completion IPC returns only metadata, line-count/maximum-line hints, and the opaque reference. Cancellation, read failure, size-limit failure, or small-response compatibility-materialization failure releases the unadopted content; successful execution persistence adopts it. Responses at or above 1 MiB, plus smaller responses with pathological lines, remain references in runtime and are restored into the bounded viewer without a full-body WebView read. Large native format/query results are stored as temporary encrypted `ready` content and released when the presentation changes or unmounts; they do not add a plaintext table or filesystem cache.

`ResponseStoragePolicy` is the future switch for encrypted versus plaintext response content. The current adapter always resolves to encrypted and Rust rejects plaintext, so this contract does not weaken current storage. Future preferences use document-over-folder-over-workspace precedence, live only in local settings keyed by stable IDs, and never affect `SecureStore`, credentials, OAuth tokens, cookies, or other sensitive local records. Enabling plaintext later requires an explicit chunk-format/schema migration and mixed-mode cleanup tests; it is not implemented by Phase 7.

General local-record payloads are AES-GCM encrypted with context/AAD bound to workspace/table/record identity. Execution document/time/status and cookie metadata columns remain plaintext indexes; execution bodies, full execution payloads, cookie values, drafts, and session state are encrypted.

Draft and inactive-editor request files are stored once in an immutable, content-and-metadata-addressed `attachments` record. Draft/session JSON contains only `__purrFileRef`; unchanged attachment IDs bypass repeated large JSON comparisons and writes. The first encoding yields between bounded chunks so autosave does not monopolize the WebView event loop. Native workspace reads replace the encrypted record's base64 field with a small metadata descriptor, so workspace restoration creates a lazy `File` without sending or decoding its bytes in the WebView. Explicit canonical save may read those bytes through raw IPC; native request execution instead decrypts the attachment in Rust and stages it directly into a short-lived transport handle. Legacy inline `__purrFile` records remain readable. Canonical saved attachments still use the Git-portable `assets/` projection.

Ordinary `read` prunes expired entries and returns only the latest successful execution per document. `RequestHistory` appends executions separately from document autosave; hosts with a `HistoryPort` never write or delete execution rows through normal workspace projection. This prevents rapid sends from being coalesced and deleted history from being resurrected by `lastResponse`.

SQLite migration 5 adds a pin flag, an encrypted summary, a workspace/time/ID index, retained history attachments and execution-to-attachment links. The schema change is transactional. Native `request_history` provides immutable append, metadata search/cursor pagination, selected-entry reads, metadata-only existence checks, pinning, manual deletion, retention settings, pruning and attachment reads. History attachment payloads reuse the attachment encryption context and are deduplicated separately from live document ownership. Upload replay can stage a retained native attachment directly, without loading file bytes into React.

Dynamic-variable source requests use the same execution history and source document identity. Optional `dynamicExecution` metadata records the execution group, root/parent document IDs, variable ID/name, selected environment and extraction expression/result. It never contains the extracted variable value. The metadata is encrypted with the existing execution payload and summary, so this additive v1 extension needs no new SQLite columns; records without it remain ordinary executions. Extraction failure does not turn a received HTTP response into a transport error or discard its body. `RequestHistory.append` resolves with the execution ID only after storage adoption finishes, before the resolver releases temporary response references. Cache hits and requests blocked before dispatch do not create execution records. Pinning, retention and manual deletion apply equally to dependency executions.

Retention defaults to 30 days and is stored locally per workspace. Pinned executions are exempt from expiry. Manual deletion and expiry clean owned response content, unreferenced history attachments and execution credential namespaces. Deleting a document/draft does not delete its history; deleting its workspace does. Historical editor views are excluded from workspace projection. The browser preview uses an encrypted per-entry store and metadata index with equivalent retention and immutable append rules.

## Secure store

`SecureStore` supplies CRUD convenience methods plus versioned `read`, typed `resolve`, transactional `commit`, and `operationStatus`. Native adapters map these to `secure_read`, `secure_resolve`, `secure_commit` and `secure_operation_status`; legacy CRUD commands remain supported and route mutations through the same primitive. Resolution distinguishes `available(value, revision)`, `missing(revision)`, `locked`, `unavailable`, `corrupt` and `denied`. Failure codes are stable and safe; adapters do not infer presence from empty text or parse platform error messages. Editor changes carry keep/set/delete intent, so an unreadable or unresolved value is never an inferred overwrite/delete.

`SecretPreparationStore` overlays private staged values on read-only source snapshots. `projectWorkspace` and global projection return mutations separately from persisted project/local/assets. External reconciliation and previews use the overlay without publishing. `storeCredential` operates on this preparation context during projection. Imports hydrate against staged values, then publish through the owning commit. Integration editors retain staged credentials until validated Save; Cancel leaves the vault unchanged. OAuth integration refresh uses the pre-request credential revision so it cannot overwrite a concurrent configuration edit. History append atomically adopts its execution content and immutable credential snapshot. The UI distinguishes an ordinary rejected save from Save needs recovery; Check and retry rechecks storage before preparing another publication.

On macOS `PlatformRootKeyStore` stores one 32-byte root in the application data directory with user-only `0600` permissions. HKDF derives separate database, credential-vault, and response-content keys. The native storage worker reads the root when it starts and retains only its derived ciphers. Versions before 0.1.2 used Keychain service `app.purr.credentials`; if a file key is absent, Purr reads that legacy entry once and writes the user-only file. This migration can require one final macOS authorization for an existing unsigned installation. If encrypted data exists and neither key is available, protected access fails closed and no replacement key is generated. Where the canonical workspace registry/files remain readable, the application can show their definitions in degraded mode. This classification/availability work does not move the installation root into an OS-only store; that change is S03.

Other native platforms currently fail closed because no root-key adapter is configured.

## Schema and data migrations

There are distinct migration responsibilities:

- YAML `projectFormatVersion` and tolerant development-shape rewrites in `storage/yaml.ts`;
- legacy monolithic workspace migration into project files/local records in `WorkspacePersistence.load`;
- legacy request root migration into `documents/`;
- SQLite schema migrations in `persistence/local_records.rs`;
- encrypted envelope/key migration in native secure/local modules;
- runtime record payload migration before strict restoration.

The last category is currently incomplete. Workspace auth runtime has an explicit `version: 1` parser. Only the two known pre-canonical shapes (the auth-entry array and the unversioned definitions/entries object) migrate to an empty v1 runtime record. Future versions, malformed v1 records and unknown object fields remain unchanged and make that workspace read-only. Request execution restore validates both legacy inline responses and `protocolVersion: 2` opaque-content descriptors; malformed execution records are skipped so they cannot block the workspace. Drafts, document session state, workspace UI state, dynamic cache, cookie records, and schema cache do not all have equivalent application-level shape versions. A schema-incompatible value in one of those records can still reject local restoration. The workspace falls back to canonical-only navigation with a nonavailable protected state; original local records remain opaque and autosave of substitute defaults is suppressed. Any change to these record shapes must add tolerant decoding/migration and a regression fixture; deleting user state is not an acceptable automatic migration.

## Failure and recovery rules

- Invalid canonical YAML/project data is rejected without modifying source files.
- Missing attachment assets reject load rather than fabricate request data.
- External/dirty conflicts preserve both sources and stop the merge.
- Missing root key with existing encrypted data fails closed for protected access; readable canonical definitions can remain navigable without authorizing local-state replacement.
- Failed preparation or terminally aborted publication preserves the previous active vault. Unknown outcomes are reported as recovery-required until reconciled; never fall back to plaintext or erase committed values as compensation.
- Autosave/flush failures stay visible. A failed revision-checked final save does not block native window close and does not overwrite the external file.
- Recovery must be explicit and minimal; do not silently discard drafts, cookies, history, or credentials.

## Imports and persistence

`persistImport` validates a normalized canonical project before committing it. Import is additive, rejects duplicate resource IDs and invalid/cross-workspace secret refs, stages transient values in a private overlay, then publishes canonical/local/credential changes through the normal commit. No importer may bypass projection/storage safety or invent a parallel file layout. Full status is in [Imports and integrations](imports-and-integrations.md).

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
- `src-tauri/src/security/mod.rs` — local root-key migration and cryptographic key derivation.
- `src-tauri/src/persistence.rs` — registry, journals, Tauri commands, and watcher.

Integration tracing settings and request `{ enabled, integrationId? }` bindings are
optional canonical fields. Missing fields retain legacy propagation behavior; new
requests start with tracing disabled. Generated header templates are an effective
runtime projection, and generated IDs remain in encrypted execution metadata.
The shared integration AuthEditor keeps its full configuration and OAuth token in
a declared `auth` SecureStore slot, referenced by canonical integration credentials;
legacy `apiToken` slots remain readable. Open-tab UI state is an in-memory scope
released on tab close and does not add project fields or local database records.

## Postman import ownership

Postman adapters normalize natively into existing canonical resources. The source JSON, scripts, and response examples are not stored. Collection import creates a workspace; environment import adds a resource through the same prepared, revision-checked commit, preserving current drafts and UI/session state. Per-import IDs prevent collisions. Secret values remain transient until the owning commit publishes; no write-then-delete compensation is used. Workspace/environment name overlap is valid and uses environment precedence without a canonical format migration.

## GraphQL connection format transition

The existing `kind: schema` resource and `schemas/` paths now represent workspace-level Schema Connections. Canonical fields add `endpoint`, `auth` and ordered `introspectionHeaders` with credential-aware values. Source-level endpoint/request IDs remain readable for migration and are omitted from new writes. `defaultGraphqlSchemaId` is canonical workspace configuration; `ui.lastGraphqlSchemaId` is local state. Request auth inheritance can explicitly name `source: schema` alongside the existing `graphql.schemaId` binding.

`projectWorkspace` / `restoreWorkspace` own conversion. Legacy source-request settings are copied once, keeping IDs and pinned SDL; conflicting request targets are detached. Saved configuration does not require a successful fetch. Connection auth/editor runtime is protected in `document_session_state`, guarded by its canonical auth definition; drafts are protected before local serialization. Header credentials and OAuth token values live behind SecureStore references.

`schema_cache` version 2 retains SDL and load time together with configuration/context hashes. An external configuration change marks cached SDL stale rather than deleting the last valid schema. Pin still produces a portable SDL sidecar and is enabled by default. No new SQLite table or native transport IPC is required.

### Request settings compatibility

HTTP/GraphQL resources accept an optional, strictly validated `settings` object for redirects, timeout, TLS verification, protocol preference, and cookie capture. This is an additive format-1 change: old YAML and local records may omit every new field. Defaults remain follow redirects, 10 hops, 60 seconds, TLS verification, and automatic protocol negotiation. Cookie capture inherits the old `overrides.cookies`/`useCookieJar` value when `storeCookies` is absent, so old jar opt-outs remain both send-off and store-off.

`projectWorkspace` writes settings from the saved request baseline; working-copy changes stay in encrypted local records. `restoreWorkspace` preserves both. Local decoding salvages valid settings fields independently and ignores invalid fields before applying defaults; a corrupt timeout or protocol field cannot prevent an otherwise valid workspace from opening. Canonical YAML remains strict and rejects invalid ranges or unknown settings. No SQLite table or secret ownership changes are involved.
