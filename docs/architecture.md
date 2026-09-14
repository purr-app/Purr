# System architecture

This document is the overview and dependency map. Detailed lifecycle behavior belongs in the linked subsystem documents.

## Product boundary

Purr is a local-first desktop API client. React owns editing and application orchestration; TypeScript domain/application modules own canonical models, projection, request preparation, redirects, and cookie policy; Tauri/Rust owns privileged OS and transport operations.

```text
React feature UI
  ↓
runtime Workspace / RequestDraft / HttpResult
  ↓
TypeScript domain and application services
  ↓ typed adapters and Tauri commands
Rust HTTP · OAuth callback · project files · encrypted SQLite · Keychain
```

The browser adapter exists for development and tests. It is not a transparent replacement for the desktop backend: browser mode has IndexedDB/WebCrypto persistence but intentionally has no native HTTP transport, filesystem watcher, Keychain, or desktop save dialog.

## Ownership layers

### Feature and runtime layer

`src/features/workspaces/model/workspace.ts` defines the mutable runtime aggregate used by the UI. It contains canonical-looking definitions together with open documents, unsaved edits, editor state, latest responses, cookies, caches, and layout state. This type is convenient runtime state, not a file format.

`src/features/request-workbench/model/request.ts` defines `RequestDraft`; request body/auth/workspace configuration are split into neighboring model files. `HttpResult` in `services/http-client.ts` is the normalized frontend response.

### Canonical domain layer

`src/domain/project.ts` defines strict Zod schemas for `WorkspaceDefinition`, `ProjectResource`, `RequestDefinition`, `SchemaDefinition`, `EnvironmentDefinition`, folder and integration definitions, credentials, and variables. `validateProject` enforces references, uniqueness, secret ownership, auth-scope overlap, and folder acyclicity.

Canonical types describe the portable project. They do not contain React state, IPC DTOs, database columns, filesystem paths, YAML syntax, live `File` objects, response history, or plaintext secret values.

### Application layer

`src/application/project-projection.ts` is the projection boundary:

```text
runtime Workspace
  ├─ projectWorkspace() → canonical Project + project assets
  └─ projectWorkspace() → local records + SecretRef-backed values

canonical Project + local records + assets
  └─ restoreWorkspace() → runtime Workspace
```

`src/application/workspace-persistence.ts` assigns canonical resources to files, calculates revisions/change sets, serializes writes, reconciles external changes, and calls the persistence adapter. `src/application/import-project.ts` validates and commits normalized imports.

### Storage and native layers

`src/storage/contracts.ts` defines `PersistenceBackend`, `FilesystemWorkspaceStore`, `LocalStateStore`, and `SecureStore`. `yaml.ts` owns the canonical YAML codec; `native-backend.ts` is the Tauri adapter; `browser-backend.ts` is the development adapter.

Rust modules provide narrow privileged boundaries:

- `src-tauri/src/http.rs`: validated HTTP(S) transport without automatic redirects.
- `src-tauri/src/project_files.rs`: safe project scanning and revision-checked atomic file operations.
- `src-tauri/src/local_state.rs`: encrypted local records, execution metadata/history, and secret vault.
- `src-tauri/src/secure_store.rs`: Keychain root key and derived encryption keys.
- `src-tauri/src/persistence.rs`: workspace registry, commit journal, watchers, and Tauri persistence commands.
- `src-tauri/src/oauth.rs`: loopback callback for OAuth Authorization Code.
- `src-tauri/src/downloads.rs`: native response-body save.
- `src-tauri/src/lib.rs`: registered Tauri commands and managed services.

## Dependency direction and invariants

1. Feature components may depend on feature models/services, application services, domain types, storage contracts, and shared UI.
2. The canonical domain must not depend on UI, Tauri, storage implementation, or serialization details.
3. Storage adapters implement contracts; projection decides what belongs to project files, local records, and the secret vault.
4. Rust accepts final transport/file/secret operations. It does not reconstruct a `RequestDraft`, resolve template variables, apply workspace inheritance, choose auth, or serialize logical body modes.
5. Canonical definitions remain deterministic and Git-friendly. Runtime/session data and secret values must not leak into them.
6. Request building and persistence each have one canonical route. New callers should reuse `prepareWireRequest`/`executeRequest` and `projectWorkspace`/`WorkspacePersistence`, not reimplement them.
7. Stored format changes require compatibility or migration. Strict validation is useful only if older valid workspaces and local state can still open.

## Major flows

### Load and save

```text
NativePersistenceBackend.load()
  → Rust scans registered project directories + reads local SQLite
  → WorkspacePersistence.readProject()
  → validateProject()
  → restoreWorkspace()
  → WorkspaceWorkbench

Workspace update
  → useWorkspaces 180 ms debounce / explicit flush
  → projectWorkspace()
  → WorkspacePersistence change set
  → NativePersistenceBackend.commit()
  → journaled project-file + encrypted-local-state commit
```

### Execute

```text
Request editor
  → workspace-effective RequestDraft
  → dynamic dependency requests and variables
  → static interpolation + GraphQL/auth/body preparation
  → WireRequest + redacted display request
  → TypeScript cookie/redirect policy
  → Rust send_http
  → WireResponse
  → HttpResult
  → response viewer + latest execution persistence
```

See [Request lifecycle](request-lifecycle.md) and [Response lifecycle](response-lifecycle.md) for ordering and edge cases.

## First-class entities and current status

| Entity | Runtime owner | Canonical model | Status |
| --- | --- | --- | --- |
| Workspace | `Workspace` | `WorkspaceDefinition` | Working |
| HTTP request | `RequestDocument` + `RequestDraft` | `RequestDefinition(kind=http)` | Working |
| GraphQL request | `GraphqlDocument` | `RequestDefinition(kind=graphql)` | Working over HTTP |
| Schema resource | `SchemaDocument` | `SchemaDefinition` | Working for introspection/file sources |
| Folder | `extraResources` | folder `ProjectResource` | Working, nested filesystem hierarchy |
| Environment | `Environment` | `EnvironmentDefinition` | Working |
| Variable | `Variable` | `VariableDefinition` | Static and dynamic-request working; external-secret reserved |
| Cookie jar | `SessionCookieJar` | none | Working, workspace-local only |
| Integration | `extraResources` | integration `ProjectResource` | Storage shape only; no provider runtime/UI |
| Trace / benchmark | discriminants only | none | Reserved, not working features |

## Current architectural limitations

- UI cancellation invalidates ownership of a pending completion but does not abort the native HTTP request.
- Most encrypted local-record payloads do not carry their own application-level shape version. Only workspace auth runtime has explicit shape recovery. Incompatible draft/session payload changes can prevent workspace restoration; changes to these shapes need a migration or tolerant decoder.
- Execution history has an indexed native pagination API, but no history-browser UI.
- The jq/JSONPath evaluator is an intentional subset, not either language’s complete implementation.
- Attached external project directories have application/native support but no current UI.
- Registry schema sources, external secret providers, generic imports, integrations, tracing, benchmarks, and subscriptions are not implemented end-to-end.

## Documentation ownership

- [Workspaces](workspaces.md): runtime aggregate, filesystem tree, tabs/layout/navigation.
- [Request lifecycle](request-lifecycle.md): effective request composition and cURL request exchange.
- [Response lifecycle](response-lifecycle.md): native DTO through rendering/history/errors.
- [Environments and variables](environments-and-variables.md): scope, interpolation, dynamic dependencies, secrets.
- [Authentication](auth.md): auth schemes, OAuth, and cookie jar.
- [Persistence](persistence-architecture.md): exact file/local/vault classification and recovery.
- [GraphQL](graphql.md): request and schema lifecycles.
- [Imports and integrations](imports-and-integrations.md): normalized import boundary and reserved concepts.

## Key files

- `src/App.tsx` — mounts the product shell.
- `src/app/app-router.tsx` — chooses the application route.
- `src/features/workspaces/workspace-workbench.tsx` — top-level workspace orchestration and feature composition.
- `src/features/workspaces/hooks/use-workspaces.ts` — load, autosave, flush, and failure handling.
- `src/domain/project.ts` — canonical schemas and cross-resource validation.
- `src/application/project-projection.ts` — runtime/canonical/local/secret projection.
- `src/application/workspace-persistence.ts` — file layout, revisions, commits, and external reconciliation.
- `src/storage/contracts.ts` — adapter interfaces and local table names.
- `src-tauri/src/lib.rs` — complete native command registration map.
