# Persistence architecture

This document is the source of truth for canonical project files, public/protected local runtime state, the secret vault, file projection, migrations, and recovery. The central rule is that runtime `Workspace` must never be serialized directly.

## Three ownership classes

### Canonical and shareable

Canonical data defines the project. It should produce useful diffs, merge across branches, move between machines, and remain stable when a user merely opens a tab or sends a request. It is validated by `src/domain/project.ts` and encoded by `src/storage/yaml.ts`.

### Local state

Local data is machine/session/editor specific or potentially large: drafts, inactive modes, tabs, layouts, cookies, schema caches, responses, and history. Desktop stores explicitly classified `plaintext` or `encrypted` payloads in SQLite. Public UI/editor DTOs hold references instead of secret literals; classified runtime fragments remain protected. Local ownership alone does not imply encryption.

### Secret store

In canonical format v2, protected literal and mixed-expression values never belong in project files. Definitions contain stable `SecretRef`s or explicit pure-template credentials. Public user-classified inputs remain public; a reference to a public variable does not encrypt that variable. Legacy v1 files can still contain credential literals until their explicit upgrade succeeds. On macOS an OS-protected installation root wraps independent workspace/global credential and runtime keys; individual values live in SQLite `secret_values`. HKDF separates database, secret-value and response-content purposes within each scope.

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
| Unpinned schema content | `SchemaDocument.sdl` | local `schema_cache`, protection retains the policy captured when loaded | No | Potentially | Regenerable local cache |
| Environment definition | `Environment` | `environments/*.yaml` | Yes | Values may be refs | Shareable named configuration |
| Plain workspace/environment variable | `Variable(kind=static)` | `purr.yaml` or environment YAML | Yes | No | Intentional project input |
| Sensitive variable definition | `Variable(kind=static,sensitive)` | YAML metadata + `SecretRef` | Yes | Reference only | Share identity without value |
| Sensitive variable value | transient `Variable.value` | encrypted `secret_values` | No | Yes | Never enter Git-friendly files |
| Global variable definition | `WorkspaceStore.globalVariables` | public global `workspace_local_state/variables` DTO + protected value refs | No | Maybe | App-local, not owned by one project |
| Dynamic variable definition | workspace `Variable` | `purr.yaml` | Yes | Definition only | Shareable dependency/extraction contract |
| Dynamic variable cache | `Workspace.dynamicVariableCache` | classified `workspace_local_state/dynamic-variable-cache`; sensitive values use vault refs | No | Maybe | Environment/session/TTL-specific runtime result |
| Shared headers | `Workspace.requestConfig.headers` | `purr.yaml` | Yes | Marked values use refs/templates | Stable header identity and explicit sensitivity |
| Encrypt responses | Workspace / request document | Public local state/session records; workspace Off/On, request Inherit/Off/On | No | Policy only | Device-local, frozen at dispatch; existing content keeps its protection |
| Request transport/cookie policy | `RequestDraft.settings` and `useCookieJar` | Optional `settings` and `overrides.cookies` in saved HTTP/GraphQL YAML | Yes | No | Saved baseline only; unsaved overrides remain in local drafts |
| Trace propagation preference | Workspace request config / saved request | Optional `tracePropagation` format ID in workspace/request YAML | Yes | No | Definition only; absent means off/inherit, generated IDs never enter canonical definitions |
| Observability integration | `Workspace.extraResources` | `integrations/*.yaml`, opaque versioned config + scoped SecretRefs | Yes | Reference only | Native descriptor validates config; credential values stay in the vault |
| Trace lookup result/cache | Rust observability service / React bounded presentation | Bounded memory cache only | No | Potentially | No new persisted trace table; correlation reads exact execution metadata through its protection boundary |
| Shared auth definition | `Workspace.requestConfig.auth` | `purr.yaml` with credential refs | Yes | Reference only | Share scheme/scope without credentials |
| Request auth credentials | active `RequestAuth` | `secret_values`, referenced by request YAML | No | Yes | Credential-bearing |
| OAuth access/refresh tokens | runtime auth token | versioned public `workspace_local_state/auth-runtime` DTO with protected token refs | No | Yes | Acquired, machine/session-bound |
| Request draft / dirty working copy | `RequestDocument.request` | public sanitized `drafts` + protected runtime refs | No | Maybe | Unsaved local editing state |
| Extension-document draft / dirty working copy | `ExtensionDocument.config` | public sanitized `drafts` + protected runtime refs | No | No by contract | Preserves edits and saved baseline even when the owning module is unavailable |
| Inactive body/auth editor modes | `RequestDraft` | public sanitized `document_session_state.editor` with protected references | No | Maybe | UX state, not active definition |
| Open/preview/active tabs | `Workspace.ui` | public `workspace_local_state/state` | No | No | Machine/session navigation |
| Editor conflict base/incoming | `Workspace.editorConflicts` | encrypted version-1 `workspace_local_state/editor-conflicts` | No | References only | Review dirty editors without overwriting incoming definitions |
| Interrupted Git operation | native Git adapter | encrypted version-1 `workspace_local_state/git-operation` | No | Potentially | Original index/dirty bytes and fingerprints for guarded restart/abort |
| Pending project move | native persistence | encrypted version-1 `workspace_local_state/directory-relocation` | No | Paths only | Whole-directory publication and conditional cleanup |
| Sidebar width/order/open state | `Workspace.ui` | public `workspace_local_state/state` | No | No | Local layout preference |
| Request/response layout and split ratios | `Workspace.ui` | public `workspace_local_state/state` | No | No | Local layout preference |
| Active environment | `Workspace.activeEnvironmentId` | public `workspace_local_state/state` | No | No | Machine/session choice |
| Latest execution | `RequestDocument.lastResponse` | policy-classified `request_executions` + adopted `response_contents` chunks | No | Potentially | Restore latest response without polluting Git |
| Older execution history | metadata lists; immutable snapshot hydrated on selection | same native tables plus retained history attachments | No | Potentially | Local indexed history UI |
| Response headers | `InlineHttpResponse.headers` / `HttpExchange.response.headers` | policy-classified execution payload; cookies and exact sensitive snapshots remain protected | No | Potentially | Runtime evidence can contain tokens/cookies |
| Response body | `HttpExchange.content` reference; transitional materialized viewer value | classified `response_bodies` or native `response_contents` + chunks | No | Potentially | Large/sensitive execution data |
| Cookie metadata | `SessionCookie` | local `cookie_metadata` index columns | No | Metadata only | Queryable local jar inventory |
| Cookie values/full record | `SessionCookieJar` | encrypted `cookie_jar` payload | No | Yes | Session credential material |
| Canonical attachment | live `File` in `RequestBody` | content-addressed `assets/<sha256>.bin` | Yes | Not assumed; user-controlled | Required to reproduce saved request |
| Attachment runtime/editor state | inactive/live body modes | encrypted attachment descriptor and chunk rows referenced by draft/session records | No | Potentially | Preserve local editor state without repeating file bytes in every editor snapshot |
| Integration definition | `extraResources` | `integrations/*.yaml` with opaque JSON config and credential refs | Yes | References only | Canonical envelope and unavailable-provider management; no runtime provider yet |
| Integration credentials | explicit `credentials` map | `SecretRef` in YAML, value in vault | No | Yes | Provider-owned config is not scanned or treated as credential storage |
| Recent items | no current first-class UI projection | reserved classified `recent_items` table | No | No | Local navigation extension point |

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

While v1 remains open, `projectWorkspace` writes pending definition edits to the sanitized `workspace_local_state/legacy-definition-draft` record as a versioned definition overlay. `restoreWorkspace` reads that DTO; it is not a serialized runtime `Workspace`. Workspace UI, cookies and dynamic caches retain their separate local owners. The overlay records the complete source-file list and revisions, including schema sidecars and assets. External changes, additions or removals prevent applying the old overlay and enter `recovery-required` with `legacy-definition-conflict` without overwriting either source. Future or malformed overlay versions remain opaque and read-only. Importing resources into an existing v1 workspace also requires its explicit upgrade before imported credentials are staged.

## Availability and required local secrets

`StoredWorkspace`/`StorageSnapshot.protectedState` distinguishes available storage from locked, unavailable, corrupt, denied or recovery-required state. S05 also returns readable `local` records plus typed `unavailableLocal` descriptors (`table`, `id`, `state`), with `globalUnavailableLocal` for global state. The descriptor's presence identifies adapters that support partial public operation. Public-only startup/save and Off request execution can continue without a key when no protected dependency is required; unreadable encrypted records remain opaque and are omitted from replacement/deletion diffs. A protected cookie jar is a dependency, not an empty jar: the user must explicitly disable send/store cookies to bypass it.

`retry_protected_storage` retries the same established keys and rehydrates the owning snapshot; it never resets or generates replacements for missing known keys. Operations that need protected values fail with typed state. Public-only storage does not itself imply that encryption keys already exist. Unknown local container/record versions and recovery-required commits remain failures, never evidence of empty state.

Restoration retains unresolved refs/field states instead of fetching every credential. Send/OAuth/introspection/resolved-code operations resolve only enabled required fields and their transitive variables. An absent value is actionable rather than silently substituted with an empty string; an intentionally stored empty value remains available, although protocol validation can still reject it.

The Local secrets summary inventories canonical definitions and current typed working copies without enumerating the vault, cookies, tokens or execution history. Manage secrets uses batched `secure_inspect` metadata (status, revision, and whether an available value is empty); plaintext crosses the UI boundary only when the user reveals one row. Missing, saved-empty and unavailable are distinct. The compact name/value rows begin a replacement with a blank value, require explicit Save, keep an entry after failed Save, reject empty replacements, and require confirmation for Remove. A corrupt/unknown baseline disables editing. Inspection refreshes on modal open; Retry / Unlock appears only when access needs repair. This status is independent of whether a variable editor has hydrated its plaintext buffer.

The manager lists known declarations and direct template references. It does not read every secret expression to discover dependencies on opening; selected export performs the deeper saved-definition dependency inspection before writing a package. Dependencies inside unavailable values remain unknown until access returns. General → Export workspace opens the native empty-directory picker directly and explains exclusions inline. Secrets and encryption contains selected encrypted credential transfer and a separate recovery menu. See [Secret transfer and recovery](secret-transfer-and-recovery.md). Global and Postman export remain unsupported; global dependencies are not bundled with workspace files.

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

`persistence/commit_coordinator.rs` validates and prepares all changes before making an explicitly classified version-2 `pending_commits` journal containing file preimages and staged mutations. Files are applied first. Local records, secret values/revisions, workspace registration, committed receipt and journal removal then publish in one SQLite transaction. Secret-only and global commits use the same path. Preparation uses a rolled-back SQLite transaction to validate local records and content/attachment adoption before touching project files.

A handled failure conditionally restores only files whose current revision still matches this operation's output. An external edit or unsafe rollback leaves an explicit recovery-required operation; it is never overwritten to simulate an abort. Startup rolls back unpublished version-2 operations without later silently publishing their credentials. Older version-1 journals retain their legacy replay behavior. The filesystem and SQLite are not one atomic visibility boundary for external tools; application access is serialized and recovery provides a coherent result.

A terminal receipt retains the full-request fingerprint and result, not staged secret values. A journal/receipt is public only for a batch with no secret mutations and explicitly public local changes; secret-bearing batches remain encrypted under the installation journal key. Encryption failure never retries as plaintext. Reusing an operation ID for a different request is rejected. Lost acknowledgements are checked through `secure_operation_status`; known native rejections are not reinterpreted as successes. Caches change only after confirmed publication and are invalidated on uncertain/failed operations. A separate active-workspace selection failure cannot turn a committed import into a failed import.

Workspace roots live in the local registry. Deleting a Purr-managed workspace deletes its managed project directory; deleting an attached external workspace unregisters it without deleting its external project files. Desktop New workspace → Import → Choose folder instead now exposes canonical directory opening. `read_project_directory` optionally detects a Purr directory or selected manifest and returns an unregistered candidate (or null for an ordinary collection source); the application decodes/validates/restores its canonical model without hydrating credentials. `open_project_directory` requires the full inspected path/revision set, rereads and validates it, checks directory/workspace uniqueness and cleanup state, and inserts the registry entry without rewriting YAML or copying files. Native SHA-256 revisions protect the validation-to-registration boundary against changed file sets. New local state and current-device keys stay private; the source workspace ID/SecretRefs remain unchanged. Reopening the same directory returns its existing workspace; a second path with that ID cannot overwrite the registry. Invalid candidates do not register. No database schema migration is added.

## External changes and conflicts

`WorkspacePersistence.watchChanges` performs a three-way comparison between loaded baseline, current projected state, and re-read external canonical files. Clean changes can be accepted and independent resources merged. Because `documents/` owns hierarchy, restoration takes a saved request’s `folderId` from its rescanned canonical path while preserving unrelated dirty editor content. Other concurrent changes to a dirty request definition still raise a conflict and preserve local edits.

If a save reaches the native revision preflight before the watcher has reconciled an external move or rename, the footer exposes an explicit **Reload and retry** action. It runs the same full-snapshot, three-way reconciliation first and only then retries the commit with current revisions. It never bypasses preflight or overwrites a true concurrent content conflict. A failed final save does not veto the native window close: the attempted commit remains non-destructive and the application exits without silently replacing the external file.

The Rust watcher uses `RecursiveMode::Recursive` for each registered project root. A change anywhere below `documents/` is coalesced for 180 ms and emitted as a full-workspace reload request. Full scanning is deliberate because a native rename may arrive as paired paths, separate create/delete events, a directory-only event, or a backend rescan notice. Notify overflow/rescan signals and watcher errors also force a full snapshot. Other resource roots retain path-specific reloads when the event identifies a canonical file.

## Local SQLite

Detailed native table/column reference, encryption scopes and binary BLOB layouts: [Database structure](database-structure.md).

`src-tauri/src/persistence/local_records.rs` creates schema 9 and the classified payload tables listed by `LocalTable`:

- `workspace_local_state`;
- `drafts`;
- `document_session_state`;
- `request_executions`;
- `cookie_jar`;
- `schema_cache`;
- `recent_items`;
- `attachments`.

Additional internal tables include `app_state`, `workspaces`, classified `pending_commits`, separated inline `response_bodies`, `cookie_metadata`, `secret_values`, `history_attachments`, `history_attachment_links`, the `response_contents`/`response_content_chunks` store, and `attachment_blobs`/`attachment_chunks`. SQLite runs with WAL, full synchronous behavior, foreign keys, and a busy timeout.

The schema retains the revision/receipt design introduced in migration 6: `secret_revisions` (monotonic revision tombstones), encrypted `secret_operations` receipts and encrypted `workspace_cleanup` jobs. Existing credentials begin at revision 1; absence begins at revision 0. Insert/update/delete, including history/workspace cleanup, advances revisions so a stale save cannot recreate a deleted value using an old absence check. At the storage boundary, an available empty string remains distinct from a deleted/missing value for compatibility with prior saves and imports. The variable editor creates a missing declaration when a new sensitive variable has no value and blocks clearing a saved secret through its form; Manage secrets rejects empty replacements and uses explicit Remove to preserve the declaration while making its value missing. Browser preview uses equivalent IndexedDB transactions and classified receipts; it does not compensate failed publication with a later deletion.

Workspace deletion publishes local/vault removal and an encrypted managed-directory cleanup intent atomically. Directory cleanup then quarantines unchanged files and runs independently; a filesystem failure reports committed deletion with cleanup pending, clears runtime caches and retries on startup. Only a filesystem NotFound result counts as absence; permission or I/O errors cannot acknowledge cleanup. Pending cleanup reserves its workspace ID/path and never deletes an externally recreated source directory. An unreadable cleanup intent does not block existing workspace startup/reads; it conservatively blocks new saves/attachments when reserved paths cannot be checked. Externally attached project directories remain user-owned. Browser workspace/history deletion joins metadata removal and secret tombstones in one IndexedDB transaction, including namespace membership checks against concurrent additions.

Watcher changes arriving during pending recovery are deferred to a wildcard rescan instead of discarded. Commit serialization is per application process; this is not an OS-wide filesystem lock. Journals are bounded at 256 MiB and cleanup snapshots at 100,000 entries. Terminal receipts remain durable for idempotent reconciliation; they are not a second plaintext credential store.

Native response content has an explicit `staging`, `ready`, or `adopted` state. Chunks are at most 256 KiB. Their owner content records `protection`; encrypted chunks authenticate content identity/position, while public chunks carry version 0 and an empty nonce. Readers reject contradictory or unknown formats. The content worker groups up to 8 MiB of chunks per transaction and accepts at most two transport write batches in flight, allowing encryption/SQLite work to overlap network reads without unbounded buffering. It uses WAL `synchronous=NORMAL`: response bodies are reconstructible local runtime data, while canonical/local-record commits keep `synchronous=FULL`. The content worker removes expired unowned records. Persisting a v2 execution adopts matching ready content in the same SQLite transaction; deleting that execution or workspace deletes its metadata and cascading chunks. Inline `response_bodies` retain their explicit protection; native streaming uses content references. S05 archives S04 instead of converting its response records.

Native HTTP now creates staging content after receiving headers and appends through a bounded worker queue. Completion IPC returns only metadata, line-count/maximum-line hints, and the opaque reference. Cancellation, read failure, size-limit failure, or small-response compatibility-materialization failure releases the unadopted content; successful execution persistence adopts it. Responses at or above 1 MiB, plus smaller responses with pathological lines, remain references in runtime and are restored into the bounded viewer without a full-body WebView read. Large native format/query results are stored as temporary `ready` content with the actual source protection and released when the presentation changes or unmounts; they never reduce protection or create a filesystem cache.

`ResponseStoragePolicy` controls ordinary response content now. Local workspace On/Off and request Inherit/On/Off preferences never enter YAML; new or newly attached public projects default Off. Effective policy is captured before dispatch, including workspace identity. Dynamic-source requests use their own document override; introspection inherits its workspace; known OAuth token acquisition forces encryption and preflights protected storage. Changing a preference does not rewrite existing entries. Derived format/query/preview results inherit actual source protection.

Ordinary public responses can contain arbitrary server-returned tokens/PII; Purr does not scan response bodies. Cookie/Set-Cookie, auth values, marked inputs and secret-template results remain protected independently. Before a response enters public local/history storage, `response-snapshot.ts` masks classified whole fields and writes an immutable exact snapshot behind a runtime `SecretRef`. Missing/unavailable snapshot details retain a typed marker and public view. A failed attempt to protect unexpected response fields never writes their raw values; the ordinary public body can remain separately available. Resolved body/URL/header sensitivity comes from the existing composition path, not text guessing.

General records use an explicit `LocalRecord.protection` discriminator; omission retains encrypted compatibility for unreviewed adapters. Public records contain sanitized JSON, protected records AES-GCM with workspace/table/record AAD. Execution document/time/status and cookie metadata are public indexes. Response On encrypts response payload and metadata except necessary indexes; Off stores ordinary data publicly after sensitive snapshot extraction.

Local HTTP/GraphQL editor payloads use a versioned sparse DTO (`__purrRequest: 1`) in drafts, clean document sessions and immutable history. The codec omits only defaults fixed by that format version, expands them before secret resolution, and runs after secret protection when writing. Meaningful inactive body/auth modes, disabled/duplicate rows, file references and per-request inheritance overrides remain lossless. Unused generated multipart boundaries are regenerated; configured bodies keep their boundaries. Full legacy editor DTOs remain readable, and existing history is not rewritten. Dirty documents keep their editor only in the draft; `savedRequest` remains the discard baseline. Clean sessions bind to canonical definitions via `definitionHash`, schema sessions via `authDefinitionHash`, instead of duplicating canonical content. Version-2 schema caches no longer duplicate canonical source metadata.

Draft and inactive-editor request files retain immutable content-and-metadata attachment IDs and `__purrFileRef` references. Schema 9 adds encrypted 256 KiB `attachment_chunks` and encrypted metadata in `attachment_blobs`; live/history attachment rows now contain encrypted version-2 descriptors. Chunk authentication binds workspace, storage identity, index and total size. The native binary attachment port (`attachment_begin`, `attachment_append`, `attachment_finish`, `attachment_abort`) limits each append to one chunk and verifies the final SHA-256 identity. The stage is not readable until the normal owner/history transaction adopts it. A failed commit keeps prior owners intact; pending commit recovery protects its stages from abort/startup cleanup. Completed unadopted stages are aborted by the caller, and window destruction/startup clean remaining stages. Plaintext attachment bytes never enter the journal.

Native readers pin a read-only SQLite snapshot before releasing the persistence mutation lock. Attachment/history garbage collection cannot invalidate an active snapshot; each replay opens a fresh bounded reader. Removing the whole workspace may revoke its runtime key and fail an in-flight read safely. Metadata-only workspace restoration creates lazy Files. Explicit canonical asset saves may materialize bytes; request execution streams chunks directly to HTTP. Schema 8 upgrades in place to schema 9 without rearchiving or changing keys. Legacy monolithic payloads migrate lazily on first explicit read/send, preserving IDs; their one-time authenticated conversion can require whole-record memory. Corrupt old records remain untouched and do not block opening public definitions. Legacy inline `__purrFile` remains readable; browser storage is unchanged.

Ordinary `read` prunes expired entries and returns only the latest successful execution per document. `RequestHistory` appends executions separately from document autosave; hosts with a `HistoryPort` never write or delete execution rows through normal workspace projection. This prevents rapid sends from being coalesced and deleted history from being resurrected by `lastResponse`.

The schema retains the pin flag, summary, workspace/time/ID index, retained history attachments and execution-to-attachment links introduced in migration 5. Summary follows entry protection in schema 8. Native `request_history` provides immutable append, metadata search/cursor pagination, selected-entry reads, metadata-only existence checks, pinning, manual deletion, retention settings, pruning and attachment reads. History attachment payloads reuse the attachment encryption context and are deduplicated separately from live document ownership. Upload replay opens retained attachment chunks directly, without plaintext staging or loading file bytes into React.

Dynamic-variable source requests use the same execution history and source document identity. Optional `dynamicExecution` metadata records the execution group, root/parent document IDs, variable ID/name, selected environment and extraction expression/result. It never contains the extracted variable value. The metadata follows the execution payload/summary protection and contains no resolved variable values; records without it remain ordinary executions. Extraction failure does not turn a received HTTP response into a transport error or discard its body. `RequestHistory.append` resolves with the execution ID only after storage adoption finishes, before the resolver releases temporary response references. Cache hits and requests blocked before dispatch do not create execution records. Pinning, retention and manual deletion apply equally to dependency executions.

Retention defaults to 30 days and is stored locally per workspace. Pinned executions are exempt from expiry. Manual deletion and expiry clean owned response content, unreferenced history attachments and execution credential namespaces. Deleting a document/draft does not delete its history; deleting its workspace does. Historical editor views are excluded from workspace projection. Browser preview uses a fresh `purr-preview-v4` database with equivalent retention and immutable append. Explicit version-1 public/encrypted wrappers separate values. History index/settings are public; On index summaries are minimal/redacted, with separate encrypted summary records so healthy search/list can load details without bodies. Unavailable summaries remain visibly redacted. Old v3 storage is untouched.

## Secure store

`SecureStore` supplies CRUD convenience methods plus versioned `read`, typed `resolve`, transactional `commit`, and `operationStatus`. Native adapters map these to `secure_read`, `secure_resolve`, `secure_commit` and `secure_operation_status`; legacy CRUD commands remain supported and route mutations through the same primitive. Resolution distinguishes `available(value, revision)`, `missing(revision)`, `locked`, `unavailable`, `corrupt` and `denied`. Failure codes are stable and safe; adapters do not infer presence from empty text or parse platform error messages. Editor changes carry keep/set/delete intent, so an unreadable or unresolved value is never an inferred overwrite/delete.

`SecretPreparationStore` overlays private staged values on read-only source snapshots. `projectWorkspace` and global projection return mutations separately from persisted project/local/assets. External reconciliation and previews use the overlay without publishing. `storeCredential` operates on this preparation context during projection. Imports hydrate against staged values, then publish through the owning commit. Integration editors retain staged credentials until validated Save; Cancel leaves the vault unchanged. OAuth integration refresh uses the pre-request credential revision so it cannot overwrite a concurrent configuration edit. History append atomically adopts its execution content and immutable credential snapshot. The UI distinguishes an ordinary rejected save from Save needs recovery; Check and retry rechecks storage before preparing another publication.

S05 starts a fresh native store directly in `<app-data>/`. The app identifier selects this directory (`com.ihorpolishchuk.purr` in this repository, `com.usepurr.purr` in production); debug/release compilation does not affect selection. Before initialization, previous managed projects/workspaces, both SQLite databases and sidecars, root metadata/key files, old layout manifests and archives move together into `deprecated/<unique-id>/`. Previous `development/`, `release/` and experimental `storage-v2/` datasets are preserved there too; external attached project folders and unrelated webview files are not moved. OS entries remain unchanged. This is archival relocation, with no automatic import, rekey or key retirement. A first-run notice identifies the deprecated directory. Explicitly attached canonical projects remain supported; old unscoped SecretRefs resolve missing until credentials are entered again through the owning editor. Browser preview similarly starts a separate `purr-preview-v4` IndexedDB.

`storage-layout-transition.json` records the source entries and unique archive destination before moving anything. Renames and directory syncs are resumable; conflicting source/destination entries stop initialization without overwriting either. Process and filesystem locks serialize preparation, and existing native profile locks block relocation while an old process is running. Successful completion publishes `storage-layout-v2.json`; subsequent launches keep the active root in place. These manifests contain paths/names only, no keys. The archived catalogue retains its original paths and is a preserved previous dataset, not a directly usable new profile; public project folders can be explicitly attached.

One native `KeyManager` acquires a fresh independent installation root from macOS User Keychain, with app identity, profile `application-v3` and a persistent random vault ID. Create-only publication and readback precede dependent writes; initialization failures are cached until explicit Retry. `root-key-metadata-v1.json` records identity/keycheck and scope-registry establishment, never root bytes. The process-lifetime advisory lock remains. The new entry is never derived from, populated by or recovered from a formerly plaintext S03 root; copied `root-key-v1` files are preserved only in deprecated storage, never used by the active profile. Missing established keys/registry metadata never authorize replacement keys.

`scope-keys.sqlite3` is a separate private key registry, allowing key preparation without nested locks on the main transaction database. It stores authenticated vault/key/scope/generation identities, wrapped random 256-bit scope keys and encrypted keychecks. Workspace credential and runtime keys are independent; global credentials and global runtime have their own keys. An installation journal key is derived using a dedicated HKDF domain from the fresh root and is never part of workspace recovery. The registry retains scope identities after ordinary record deletion. Provisioning occurs for new workspace identity only; reads and updates of existing scopes fail closed when keys are unavailable.

Ownership is explicit: saved auth, sensitive headers/static variables, integration configuration and registry credentials use credential scopes. Drafts, inactive modes, working copies, OAuth tokens, dynamic caches, cookies, history, attachments and encrypted responses use runtime scopes. Protected commit journals, operation receipts and cleanup intents use the installation journal scope; reviewed public-only operations have explicit plaintext variants. Integration auth stores active configuration separately from its runtime editor/token snapshot; refreshed tokens cannot enter the saved credential scope. Secret mutations carry `SecretProtectionScope` and refs use `purr/<workspace|global>/<credentials|runtime>/...`. Native validation checks scope/owner/reference agreement before publication; runtime copies get independent refs. Canonical definitions reject explicit runtime refs.

The main database uses schema 8 and `mixed-scoped-v3`. The layout marker is `storage-layout-v3.json` and interrupted moves use `storage-layout-transition-v3.json`; fresh key identity is `application-v3`. There is no schema7-to-8 or runtime-record import: previous data stays archived, and existing public YAML may be attached explicitly with missing secrets restored manually. Scoped AES-256-GCM envelopes authenticate version, algorithm, vault, scope, purpose, key ID, generation and record AAD. HKDF separates database, secret and response-content purposes within each scope. The same credential key cannot decrypt workspace runtime, globals, journals or another workspace. Cipher/key buffers use supported zeroization and shared caches; OS key access does not scale with rows or chunks.

Response content receives workspace identity before its first chunk. HTTP checks runtime-key availability before encrypted dispatch; public dispatch does not open a runtime key solely for ordinary response content. Derived format/query content inherits the original workspace and protection. Adoption rejects unknown content, unowned content and another workspace's content. Chunk AAD binds workspace/content/position/length, while storage remains bounded. Native transfer exports saved credential values or credential recovery material only; it never exports runtime or installation keys.

`retry_protected_storage` retries failed initialization and reloads persistence while preserving live successful cipher handles. Workspace key/data failures preserve encrypted rows while allowing independent public operations. Global failures are reported separately; unavailable global records cannot be overwritten by defaults. Empty placeholders are never authoritative replacements for unavailable local state. Locking Keychain does not revoke already cached ciphers. Initial consent, locked stores, revoked trust and unsigned rebuilds may require OS interaction; signed restart/update trust remains a distribution acceptance gate.

Other native platforms currently fail closed because no root-key adapter is configured.

## Schema and data migrations

There are distinct migration responsibilities:

- YAML `projectFormatVersion` and tolerant development-shape rewrites in `storage/yaml.ts`;
- legacy monolithic conversion remains available to compatible explicit adapters, but the fresh native store and browser preview do not auto-load old stores;
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
runtime projection, and generated IDs remain in policy-classified execution metadata.
The shared integration AuthEditor stores saved active credentials in the canonical
`auth` SecureStore slot. Inactive fields and OAuth tokens are stored separately
in its runtime `oauth-token` slot; credential transfer excludes that runtime slot.
Legacy `apiToken` slots remain readable. Open-tab UI state is an in-memory scope
released on tab close and does not add project fields or local database records.

## Postman import ownership

Postman adapters normalize natively into existing canonical resources. The source JSON, scripts, and response examples are not stored. Collection import creates a workspace; environment import adds a resource through the same prepared, revision-checked commit, preserving current drafts and UI/session state. Per-import IDs prevent collisions. Secret values remain transient until the owning commit publishes; no write-then-delete compensation is used. Workspace/environment name overlap is valid and uses environment precedence without a canonical format migration.

## GraphQL connection format transition

The existing `kind: schema` resource and `schemas/` paths now represent workspace-level Schema Connections. Canonical fields add `endpoint`, `auth` and ordered `introspectionHeaders` with credential-aware values. Source-level endpoint/request IDs remain readable for migration and are omitted from new writes. `defaultGraphqlSchemaId` is canonical workspace configuration; `ui.lastGraphqlSchemaId` is local state. Request auth inheritance can explicitly name `source: schema` alongside the existing `graphql.schemaId` binding.

`projectWorkspace` / `restoreWorkspace` own conversion. Legacy source-request settings are copied once, keeping IDs and pinned SDL; conflicting request targets are detached. Saved configuration does not require a successful fetch. Connection auth/editor runtime is protected in `document_session_state`, guarded by its canonical auth definition; drafts are protected before local serialization. Header credentials and OAuth token values live behind SecureStore references.

`schema_cache` version 2 retains SDL and load time together with configuration/context hashes. An external configuration change marks cached SDL stale rather than deleting the last valid schema. Pin still produces a portable SDL sidecar and is enabled by default. No new SQLite table or native transport IPC is required.

### Request settings compatibility

HTTP/GraphQL resources accept an optional, strictly validated `settings` object for redirects, timeout, TLS verification, protocol preference, and cookie capture. This is an additive format-1 change: old YAML and local records may omit every new field. Defaults remain follow redirects, 10 hops, 60 seconds, TLS verification, and automatic protocol negotiation. Cookie capture inherits the old `overrides.cookies`/`useCookieJar` value when `storeCookies` is absent, so old jar opt-outs remain both send-off and store-off.

`projectWorkspace` writes settings from the saved request baseline; working-copy changes stay in classified local records. `restoreWorkspace` preserves both. Local decoding salvages valid settings fields independently and ignores invalid fields before applying defaults; a corrupt timeout or protocol field cannot prevent an otherwise valid workspace from opening. Canonical YAML remains strict and rejects invalid ranges or unknown settings. No SQLite table or secret ownership changes are involved.

## Native secret transfer boundary

`SecretTransferPort` is composed beside persistence; `secret_transfer` performs bounded native file dialogs, encryption, metadata-only inventory/preview and transactional import. Browser adapters explicitly report unsupported. A preview is a short-lived window/workspace-bound native capability, not a frontend payload of values. Commit validates both canonical revisions and destination secret revisions through the existing coordinator. `WorkspacePersistence.runSecretTransfer` serializes import with saves/history and invalidates cached reads even after a lost reply; imported refs clear only unchanged editor buffers, preserving pending edits.

S06 adds no SQLite table, schema upgrade, root-key change or legacy workspace migration. Receipts, CAS revisions, secret rows and scoped keys keep their existing ownership. Recovery reads a versioned detached ciphertext bundle, not arbitrary SQLite snapshots. Source keys exist transiently and never replace active destination keys. See [format, limits and recovery procedure](secret-transfer-and-recovery.md).

### Choosing a new project directory

New workspace creates a canonical project directly in the selected new/empty directory through `project_directory`. The native adapter validates its v2 files and uses the existing revision-checked commit coordinator for files, encrypted editor state, credentials and registry publication. Its default comes from the native profile's `projects/<workspace-id>` directory. The UI never assembles a platform-specific app-data path. Custom directories cannot overlap another workspace or private application storage. Creation never imports or replaces a nonempty directory.

### Moving an existing project

Workspace settings moves the entire project directory, including `.git`, hidden files, empty directories, symlinks and binary assets. The encrypted version-1 `workspace_local_state/directory-relocation` record owns the source, target, staging path and content fingerprints. File copying runs outside the SQLite lock under a per-workspace mutation lease. Publication switches the registry and watcher only after the copy and unchanged source have been verified; original files are removed only while their fingerprints still match. Explicit destinations remain user-owned.

Startup resumes already-verifiable publication/cleanup. An interrupted or externally changed copy stays recoverable through Resume move or Cancel pending move. Cancelling before registry publication keeps the original active and preserves temporary copies. A published project can retry cleanup or choose Keep both directories to end recovery without deletion. Replaced root symlinks are rejected and externally changed originals are retained. Canonical saves and Git mutations cannot bypass a pending relocation.
