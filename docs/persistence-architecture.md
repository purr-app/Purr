# Project persistence and import boundary

## Ownership and modules

The existing `Workspace`/document types remain the editor's runtime view. They are
not the on-disk format. The old `workspace.json` writer has been removed, not kept
as an alternative save path.

```text
Existing Purr UI                    External format
       |                                 |
project-projection.ts               ImportAdapter
       |                                 |
       +-------- domain/project.ts <-----+
                        |
             application/WorkspacePersistence
                        |
       +----------------+------------------+
       |                |                  |
 YAML / SDL / assets   LocalStateStore    SecureStore
 filesystem            SQLite vault     one macOS Keychain root
```

| Boundary | Implementation | Owns |
| --- | --- | --- |
| Canonical model | `src/domain/project.ts` | Workspace defaults, HTTP/GraphQL definitions, schema sources/pins, environments, folders and integration configurations |
| Application service | `src/application/workspace-persistence.ts` | Saved vs working copies, reconciliation, migration checkpoints, ordered commits |
| Editor adaptation | `src/application/project-projection.ts` | Bidirectional translation between existing UI state and canonical definitions + local records |
| Project encoding | `src/storage/yaml.ts` | Strict, version-aware deterministic YAML; selected auth/body variants only |
| Filesystem | `src-tauri/src/project_files.rs` | Stable resource paths, hashes, atomic changed-file writes, traversal/symlink protection |
| Local state | `src-tauri/src/local_state.rs` | SQLite migrations, encrypted runtime records, indexed execution history/cookie metadata, response blobs, pending commit journal |
| Secrets/encryption | `src/storage/secrets.ts`, `src-tauri/src/secure_store.rs` | Stable credential refs, native vault adapter, authenticated encryption |
| Directory watching/IPC | `src/storage/native-backend.ts`, `src-tauri/src/persistence.rs` | Narrow native commands, directory registry, debounced filesystem notifications |
| Cookie adapter | `src/storage/cookie-jar-store.ts` | Cookie load/replace using the same encrypted local boundary; workspace commits batch these records with session changes |
| Import entry | `src/importing/contracts.ts`, `src/application/import-project.ts` | Detection, preview/diagnostics, normalization and ordinary persistence |

Canonical types import neither React/Tauri nor YAML/SQLite structures. Zod validates
their invariants. Named pairs are ordered arrays, preserving duplicate and disabled
headers/parameters. HTTP methods are not restricted to the current picker, so e.g.
OpenAPI TRACE can round-trip. Schema/environment/folder links use IDs.

## Project files

Default desktop locations are relative to Tauri's application data directory:

```text
projects/<workspace-id>/
  purr.yaml
  requests/<slug>-<id>.yaml
  graphql/<slug>-<id>.yaml
  environments/<slug>-<id>.yaml
  schemas/<slug>-<id>.yaml
  schemas/<id>.graphql              # only an explicit pin
  folders/<slug>-<id>.yaml
  integrations/<slug>-<id>.yaml
  assets/<sha256>.bin               # saved request attachments, original bytes

local-state.sqlite3                 # NOT inside a project
local-state.sqlite3-wal / -shm
legacy-workspaces.encrypted         # migration recovery archive, if applicable
```

`WorkspacePersistence.attachDirectory(id, directory)` validates an existing project
before registering it through the normal save path. The `id` comes from its
manifest. No directory-picker UI was added in this architecture stage. Existing
"Open workspace folder" opens the new project location.

All YAML files have `purr: 1`. Missing optional/default fields are normalized;
unknown versions, unknown fields, duplicate mapping keys, aliases and malformed
documents fail closed with errors that do not echo source contents. The manifest
contains workspace identity/description and shared headers/auth only. It never
contains active workspace/environment, tabs, cookie values or responses.

```yaml
purr: 1
workspace:
  id: backend
  name: Backend API
```

Raw JSON/XML/text bodies and GraphQL query/variables remain strings; no JSON-to-YAML
object conversion is performed. Ordinary multiline values use literal blocks.
Strings needing escapes (e.g. CRLF) use quoted scalars to preserve exact content.
Only the active auth/body configuration is shareable. Empty placeholder rows,
UI row IDs, timestamps, cached schema text and inactive editor forms are omitted.
Shared-header IDs remain because request-level exclusions refer to them.

Resource paths survive renames. Externally moved resources are reindexed by ID,
including custom SDL sidecar paths. Initial paths use a readable slug plus stable
ID; folder resources currently model grouping without requiring physical nesting.
Unchanged parsed definitions retain original file bytes, including comments, and
are not rewritten by UI changes. Editing that resource rewrites deterministic YAML;
comment-preserving editing of changed resources is not implemented.

The initial load scans supported directories once. Normal notifications reload
individual files; directory-level moves trigger a rescan. Native notifications are
debounced by 180 ms. Reconciliation merges unrelated changes and rejects conflicts
with dirty working copies, duplicate IDs or invalid YAML. UI errors preserve local
edits and external bytes. There is no automatic conflict-resolution editor.

Before writing, SHA-256 revisions are compared to the read baseline. Native writes
use a same-directory temporary file, fsync and atomic rename, and check revisions
again for each file. A local encrypted journal makes multi-file/SQLite commits
restart-recoverable (not a filesystem-wide atomic transaction). Recovery accepts
already-written desired bytes but stops on a conflicting external edit. Like a
normal editor, this is optimistic coordination, not a distributed filesystem lock.

## Local SQLite state

Migration 1 creates application/workspace registries, workspace local state,
drafts, document session state, request executions, cookies, schema cache,
recent items, attachment cache and pending commits. Migration 2 adds indexed
execution metadata, separate response bodies and indexed cookie metadata.
Migration 3 adds the encrypted credential vault. Migrations are transactional,
recorded, idempotent and reject future versions.
SQLite uses WAL, `synchronous=FULL` and a busy timeout.

Each entity is updated independently. Current open/active tabs and pane state are
small workspace/session records, not repeated request definitions. Saved request
editor snapshots retain inactive body/auth forms locally; unsaved working copies
also record their base definition for external-edit conflict detection. Saving a
draft writes YAML using the same document ID. Pristine drafts still remain local.

Execution records are separate from request definitions and append over time.
Only the latest execution per document is hydrated at launch; the indexed native
`list_request_history` command returns paginated metadata. Body bytes/text are in
encrypted `response_bodies`. No execution/history viewer was added. Old v1 execution
rows remain readable; their new metadata indexes fill when those records are next
written. Bench/trace result tables are intentionally not invented before their
runtime models exist.

Schema caches contain SDL + loaded time + source signature. Source changes
invalidate cached SDL; pinned SDL is independent and wins on load. Files selected
through the existing schema UI are parsed into local cache, with their source
definition shareable. Pin explicitly to make the actual schema available on a
different device. Registry variants currently describe sources only; no registry
fetcher was implemented.

## Credentials and sensitive runtime data

`SecureStore` exposes `get/set/delete/exists`. References are stable, workspace-
scoped IDs, e.g. `purr/<workspace>/environments/<environment>/<variable-id>`.
Variable/request/resource rename or move never derives a new credential key from
its display name. Explicit refs loaded from YAML are retained. Import validation
rejects cross-workspace refs and duplicate transient credential refs.

The macOS adapter uses the `keyring` crate's `apple-native` backend for exactly one
generic-password item: service `app.purr.credentials`, account
`purr/local-storage/master-key-v1`. Its value is a random 256-bit root key encoded
as base64. No `SecAccessControl`, user-presence, biometric, or device-passcode flag
is requested. Domain/UI code never calls Keychain APIs. Windows/Linux adapters
deliberately fail closed until Credential Manager/Secret Service implementations
are provided; they are not claimed as supported secure-storage platforms here.

The root is read once when native persistence first opens and retained only through
derived Rust cipher instances for that backend process. HKDF-SHA256, salt
`purr:root-key:v1`, derives independent keys with info `purr:database:v1` and
`purr:secrets:v1`. Existing development SQLite payloads encrypted directly by the
root are re-encrypted transactionally once and marked `hkdf-sha256-v1`; the root
itself is not replaced. Missing root material with existing encrypted data fails
closed.

Credential values live in SQLite `secret_values`, keyed by `SecretRef`, with
separate ciphertext, random 96-bit nonce, crypto version, and timestamps. AES-256-
GCM authenticates `purr:secret:v1|<SecretRef>` as AAD, preventing a row from being
moved under another reference. `set`, `get`, `exists`, and `delete` touch SQLite and
the in-memory derived cipher only; they do not access Keychain. Root and derived
key byte buffers use `Zeroizing` while being constructed.

Release bundles use the configured Apple Development identity. `yarn tauri dev`
also injects `scripts/tauri-dev-runner.sh`, which signs each newly built executable
with the stable bundle identifier and development identity before running it. This
replaces Cargo's changing ad-hoc `cdhash` requirement with a stable designated
requirement. An existing root item created by the old ad-hoc executable can require
one macOS **Always Allow** approval for the signed identity; normal subsequent
starts do not intentionally request authentication. Set `PURR_DEV_SIGNING_IDENTITY`
when a different local development certificate should be used.

Environment Secret is a semantic flag independent of reveal/hide. Plain values
go to YAML. Secret definitions store only `{kind: secret, ref: ...}`; values go to
SecureStore. Inactive environment secrets are loaded on selection/edit, and blank
unresolved fields cannot overwrite stored values. Active request/auth values are
resolved for the existing editor and execution flow. A frontend memory cache avoids
repeated vault IPC during frequent UI saves; the vault itself never performs per-
secret Keychain reads.

Basic passwords, API keys, OAuth client secrets, acquired access/refresh tokens,
response-derived bearer tokens and inactive auth credentials use the same secure
boundary. Bearer tokens can explicitly be stored plain; templated auth values
normally remain shareable `{{variable}}` strings. Acquired tokens never enter YAML.
Workspace auth runtime has one versioned local shape containing only definition
hashes and SecureStore references for acquired tokens. An earlier or malformed dev
cache is discarded and persisted as an empty canonical record; saved auth definitions
and their credentials remain untouched. Normal reads do not carry a second auth
model. References outside the current workspace are rejected.

Cookie metadata is indexed in SQLite, not represented as environment variables.
Cookie values and all other local payloads (including response headers/bodies and
sent request snapshots, which may contain credentials) are encrypted with the
database-derived RustCrypto AES-256-GCM key. Every record has a random nonce and
workspace/table/ID authenticated data. The root key is inaccessible through
frontend credential IPC. Missing keys or authentication failures stop loading
rather than create a new key over old data.

The current compatibility API still has a narrow `secure_get(SecretRef)` command,
so a credential can exist transiently in React/JS when the editor resolves or
explicitly reveals it; current HTTP/OAuth request construction also occurs in the
frontend before `send_http`. There is no bulk-secret IPC. Moving auth resolution and
request construction fully behind Rust is conscious remaining work, not claimed by
this storage change. Values are not logged or included in persistence errors. This
is at-rest protection, not protection against a compromised desktop process,
debugger, or deliberately copied reveal. Manual plaintext body/header values are
not automatically detected as secrets; use environment secret references for
those. There is no telemetry/devtools persistence added here.

Old development per-secret Keychain items are deliberately not read or deleted by
normal startup: doing so would reproduce one prompt per item. Their YAML refs remain
valid, but affected values must be entered once so they are written into the new
SQLite vault. The obsolete items may then be removed from Keychain Access manually.

The browser UI preview has a separate IndexedDB implementation with WebCrypto
AES-GCM and a nonextractable browser key. It is not equivalent to the OS vault,
not the desktop production backend, and does not claim directory watching. The
old browser localStorage key is only read for migration, then archived encrypted
in IndexedDB and removed.

## Legacy migration sequence

1. Read the existing `workspaces/index.json` and per-workspace `workspace.json`
   using the read-only legacy adapter. Invalid/unsupported data aborts; no reset.
2. Normalize with the existing workspace validator (including earlier shared-auth
   defaults), then split canonical definitions, local state and secret values.
3. Store credentials, commit project files and encrypted local records. Record an
   encrypted per-workspace source fingerprint for restart/idempotence checks.
4. Restore active workspace locally. Only after all workspace commits succeed,
   create and verify an authenticated `legacy-workspaces.encrypted` archive outside
   the project. Changed originals or a bad archive prevent retirement.
5. Remove only archived `workspace.json` files and the old index; keep directories
   and unrelated files. Mark migration complete in SQLite. Restart after partial
   retirement accepts only unchanged surviving originals covered by the archive.

The archive preserves the old logical workspace snapshot, including credentials,
under the local master key. Tests decrypt and verify it. Retain the SQLite files,
archive and Keychain master key together for recovery; copying a DB without its
key is insufficient. A backup/key-export/recovery UI is not implemented. This
migration cannot erase plaintext from existing Git history, filesystem snapshots
or old external backups.

Secret writes precede project commits because Keychain and SQLite cannot share a
transaction. A failed commit may leave unused refs or an updated credential value;
it never places that value in YAML as fallback. Automatic credential/asset garbage
collection is intentionally deferred to avoid deleting references still used by
drafts, histories or recovery archives.

## Next import stage

Implement `ImportAdapter.canImport/inspect/import` and register it. Adapters receive
input, return canonical resources plus structured preview counts/diagnostics, and
never receive a filesystem/DB handle. `persistImport` validates the normalized
model and credentials, then delegates to `WorkspacePersistence`. Existing-workspace
imports are additive and reject ID collisions before writes; existing defaults are
preserved. Adapter options decide name duplication/unsupported-feature policies.
No feature-complete format adapter or import UI exists yet.

Postman/OpenAPI implementations can now map operations to request definitions,
servers to environment candidates, parameters to ordered headers/params,
request-body examples to raw bodies, security schemes to selected auth variants,
and collection groups to folders. GraphQL sources remain Purr resources, not an
external-format extension hidden inside HTTP requests. OpenCollection remains an
adapter boundary; no dependency on its schema exists in core.

Conscious remaining work for that stage:

- Actual Postman v2.1/OpenAPI 3.x parsing, previews, duplicate/reference remapping,
  unsupported-feature warnings and source-format fixtures; then Yaak/OpenCollection.
- Import attachment ingestion and external file-reference policy (normal editor
  attachment persistence already works). Normalized import currently carries
  definitions/credentials, not an external filesystem reader.
- Directory chooser/reload/conflict-resolution UX, full history UI/retention,
  project backup/recovery controls, secret/key lifecycle and optional cache GC.
- Windows/Linux vault adapters before desktop support on those platforms.
- Rich OpenAPI schema/example metadata, alternative security requirements and
  unsupported auth schemes need explicit domain extensions when implemented;
  they must yield warnings rather than silently flattening to supported auth.
- Bench/observability provider behavior, cloud sync, Git client and registry fetchers
  are outside this stage. Current integration/source definitions are storage models,
  not working provider integrations.

## Verification

`npm test`, `npm run test:ui`, `npm run typecheck`, `npm run lint`, `npm run build`,
`cargo test`, `cargo check`, `cargo clippy --all-targets -- -D warnings` and
`cargo fmt --check` (Rust commands use `--manifest-path src-tauri/Cargo.toml`).

Persistence tests cover YAML determinism/round-trips, exact raw JSON and multiline
GraphQL, disabled/repeated fields, secrets/inactive auth/OAuth tokens, lazy environment
resolution, saved-vs-draft state, attachments, schema source/cache/pin separation,
external moves/conflicts/parse failures, additive imports and interrupted migration.
Native tests exercise real temporary files, SQLite upgrades/rollback/history,
authenticated encryption and archive recovery, interrupted commits and symlink
rejection. A macOS test creates and deletes a disposable Keychain credential through
the actual abstraction. Browser native IPC mocks are test-only, not proof of native
storage security; a separate browser preview test checks encrypted IndexedDB storage.

Library references: [yaml](https://eemeli.org/yaml/),
[rusqlite](https://docs.rs/rusqlite/0.37.0/rusqlite/),
[keyring apple-native](https://docs.rs/keyring/3.6.3/keyring/),
[RustCrypto AES-GCM](https://docs.rs/aes-gcm/0.10.3/aes_gcm/).
