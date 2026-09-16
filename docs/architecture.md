# System architecture

This document is the overview and dependency map. Detailed lifecycle behavior belongs in the linked subsystem documents.

## Product boundary

Purr is a local-first desktop API client. React owns editing and application orchestration; TypeScript domain/application modules own canonical models, projection, request preparation, redirects, and cookie policy; Tauri/Rust owns privileged OS and transport operations.

```text
React feature UI
  ↓
runtime Workspace / RequestDraft / StoredHttpResponse
  ↓ ApplicationServices context
TypeScript domain and application services → application ports
  ↓ platform/browser or platform/tauri adapters
Rust HTTP · OAuth callback · project files · encrypted SQLite · Keychain
```

The browser adapter exists for development and tests. It is not a transparent replacement for the desktop backend: browser mode has IndexedDB/WebCrypto persistence but intentionally has no native HTTP transport, filesystem watcher, Keychain, or desktop save dialog.

## Ownership layers

### Feature and runtime layer

`src/features/workspaces/model/workspace.ts` defines the mutable runtime aggregate used by the UI. It contains canonical-looking definitions together with open documents, unsaved edits, editor state, latest responses, cookies, caches, and layout state. This type is convenient runtime state, not a file format.

`src/features/request-workbench/model/request.ts` defines `RequestDraft`; request body/auth/workspace configuration are split into neighboring model files. `src/domain/http.ts` owns provider-neutral request snapshots, response metadata, timelines, opaque content references, and the transitional inline response contract. The runtime workspace accepts both legacy inline responses and versioned response-reference descriptors while migration is in progress.

### Canonical domain layer

`src/domain/project.ts` defines strict Zod schemas for `WorkspaceDefinition`, `ProjectResource`, `RequestDefinition`, GraphQL `SchemaDefinition`, imported `ApiSchemaDefinition`, environment, folder and integration definitions, credentials, and variables. `validateProject` enforces references, uniqueness, secret ownership, selected-auth-profile compatibility, and folder acyclicity. Auth-profile scopes may overlap because requests can select a profile explicitly.

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

`src/application/ports/` owns the frontend contracts for HTTP transport, opaque request-file staging, response content, persistence, credentials, OAuth callbacks, import normalization, downloads, file dialogs, workspace shell actions, and application lifecycle. These contracts contain no Tauri command names or native paths. `src/app/application-services-context.tsx` exposes one typed service object at the shell; feature hooks consume that context rather than constructing platform implementations or receiving a chain of service props.

`src/app/create-purr-app.tsx` is the OSS application factory. `src/app/composition/routes.tsx` validates and freezes the current route descriptors before rendering, so a later extension registry can contribute namespaced routes without replacing `AppRouter`. Phase 3 does not expose this internal route composition as the extension API.

### Storage and native layers

`src/application/ports/persistence.ts` and `credentials.ts` define `PersistencePort`, `FilesystemWorkspaceStore`, `LocalStateStore`, and `SecureStore`. `src/storage/contracts.ts` temporarily re-exports those types for existing internal callers. `yaml.ts` owns the canonical YAML codec; `browser-backend.ts` is the IndexedDB development adapter. The native persistence implementation and every Tauri command string live in `src/platform/tauri/application-services.ts`; `storage/native-backend.ts` is a temporary compatibility re-export.

`src/app/composition/core-services.ts` is the only platform-selection point. It chooses browser or desktop adapters once, constructs `WorkspacePersistence`, and supplies the frozen service object to the app factory. Browser and desktop keep their existing capability differences.

Rust modules provide narrow privileged boundaries:

- `src-tauri/src/http/`: validated HTTP(S) transport without automatic redirects, plus opaque repeatable request-file handles for streamed binary and multipart bodies.
- `src-tauri/src/content/`: response-content chunks, lifecycle, direct save, allowlisted range-capable media protocol, bounded reads/segmented lines, cancellable search/format/query adapters, and a dedicated encryption/SQLite worker; encrypted is the only enabled protection mode.
- `src-tauri/src/importing/`: source loading, format detection, `$ref` resolution, OpenAPI normalization, and the native import-adapter registry.
- `src-tauri/src/persistence/`: encrypted local records, execution metadata/history, response-content adoption, project files, legacy migration, workspace registry, commit journal, and watchers.
- `src-tauri/src/security/`: Keychain root key and domain-separated database, credential, and response-content encryption keys.
- `src-tauri/src/commands/`: thin Tauri adapters for app, HTTP, response content, import, and persistence operations.
- `src-tauri/src/oauth.rs`: loopback callback for OAuth Authorization Code.
- `src-tauri/src/composition.rs`: registered Tauri commands, plugins, and managed services.
- `src-tauri/src/lib.rs`: minimal public run surface.

## Dependency direction and invariants

1. Feature components may depend on feature models/services, application services and ports, domain types, storage contracts, and shared UI. They must not import Tauri packages or construct platform adapters.
2. The canonical domain must not depend on UI, Tauri, storage implementation, or serialization details.
3. Storage adapters implement contracts; projection decides what belongs to project files, local records, and the secret vault.
4. Rust accepts final transport/file/secret operations. It does not reconstruct a `RequestDraft`, resolve template variables, apply workspace inheritance, choose auth, or serialize logical body modes.
5. Canonical definitions remain deterministic and Git-friendly. Runtime/session data and secret values must not leak into them.
6. Request building and persistence each have one canonical route. New callers should reuse `prepareWireRequest`/`executeRequest` and `projectWorkspace`/`WorkspacePersistence`, not reimplement them.
7. Stored format changes require compatibility or migration. Strict validation is useful only if older valid workspaces and local state can still open.
8. Response protection is resolved by the TypeScript application layer before transport. Future workspace/folder/document preferences are local-only and default to encrypted; shared project files cannot disable encryption, and response policy never applies to credentials or secrets.

ESLint and architecture tests enforce the current boundaries: domain modules cannot import React, Tauri, feature, application, storage, importing, app, or shared implementation modules; application and feature modules cannot import Tauri packages; platform adapters cannot reach feature UI or the application composition root. A source scan also fails when an `invoke()` call appears outside `src/platform/tauri`. Rules for the future `src/extension-api/` directory remain reserved so it cannot expose implementation-owned paths.

## Public package and build identity

The repository uses npm exclusively and treats `package-lock.json` as the JavaScript dependency lock. The root package reserves `@purr/core@0.1.0` while remaining private during migration. It intentionally has no package exports yet: internal source paths are unsupported, and Phase 15 introduces the reviewed `./app`, `./extension-api`, and `./styles` surfaces together with their build output and conformance checks.

The checked-in Tauri configuration is the unsigned OSS build configuration. It contains no developer or release signing identity. macOS development uses ad-hoc signing unless `PURR_DEV_SIGNING_IDENTITY` is supplied locally; official certificates, signing identities, notarization credentials, and updater keys are release-composition inputs outside the public repository.

## Major flows

### Load and save

```text
ApplicationServices.persistence.load()
  → NativePersistenceBackend.load()
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
  → PreparedHttpTransportRequest + redacted display request
      ↳ binary/file multipart: bounded staging → opaque repeatable request handles
  → TypeScript cookie/redirect policy
  → ApplicationServices.httpTransport
  → Tauri adapter → Rust start_http / cancel_http
  → bounded background encryption/SQLite pipeline
  → ready encrypted content reference + request-stage diagnostics
  → compatibility materialization or size/line-aware bounded content pages
  → response viewer + v2 exchange persistence/content adoption
```

See [Request lifecycle](request-lifecycle.md) and [Response lifecycle](response-lifecycle.md) for ordering and edge cases.

## First-class entities and current status

| Entity | Runtime owner | Canonical model | Status |
| --- | --- | --- | --- |
| Workspace | `Workspace` | `WorkspaceDefinition` | Working |
| HTTP request | `RequestDocument` + `RequestDraft` | `RequestDefinition(kind=http)` | Working |
| GraphQL request | `GraphqlDocument` | `RequestDefinition(kind=graphql)` | Working over HTTP |
| Schema resource | `SchemaDocument` | `SchemaDefinition` | Working for introspection/file sources |
| Imported API schema | `Workspace.extraResources` | `ApiSchemaDefinition` | OpenAPI 3.x source snapshot working; no schema editor yet |
| Folder | `extraResources` | folder `ProjectResource` | Working, nested filesystem hierarchy |
| Environment | `Environment` | `EnvironmentDefinition` | Working |
| Variable | `Variable` | `VariableDefinition` | Static and dynamic-request working; external-secret reserved |
| Cookie jar | `SessionCookieJar` | none | Working, workspace-local only |
| Integration | `extraResources` | provider-neutral integration `ProjectResource` | Canonical envelope and unavailable-provider settings UI working; no provider registry/runtime |
| Trace / benchmark | discriminants only | none | Reserved, not working features |

## Current architectural limitations

- Native responses at or above 1 MiB, or with a line at or above 64 KiB, use virtualized logical-line previews, with long line middles explicitly hidden and subsequent rows loaded on scroll. JSON up to 10 MiB opens in native Pretty using the regular code typography; the full-body IPC threshold stays unchanged. Native search, Pretty, jq/JSONPath, and GraphQL field extraction return bounded values or another encrypted content handle. Direct handle download and range-capable image/audio/video preview avoid body IPC; full-body clipboard copy remains unavailable for opaque large content.
- GraphQL introspection responses may cross the inline boundary: schema installation reads a native content reference in bounded windows, releases it, and normalizes the complete source in a cancellable Web Worker. The UI still builds one `GraphQLSchema` from normalized SDL for CodeMirror and `graphql-language-service`; current measurements do not justify a second Rust schema model.
- Most encrypted local-record payloads do not carry their own application-level shape version. Only workspace auth runtime has explicit shape recovery. Incompatible draft/session payload changes can prevent workspace restoration; changes to these shapes need a migration or tolerant decoder.
- Execution history has an indexed native pagination API, but no history-browser UI.
- The jq/JSONPath evaluator is an intentional subset, not either language’s complete implementation.
- Attached external project directories have application/native support but no current UI.
- Registry schema sources, external secret providers, non-OpenAPI collection adapters, integration provider runtimes, tracing, benchmarks, and subscriptions are not implemented end-to-end.

## Documentation ownership

- [Workspaces](workspaces.md): runtime aggregate, filesystem tree, tabs/layout/navigation.
- [Request lifecycle](request-lifecycle.md): effective request composition and cURL request exchange.
- [Response lifecycle](response-lifecycle.md): native DTO through rendering/history/errors.
- [Environments and variables](environments-and-variables.md): scope, interpolation, dynamic dependencies, secrets.
- [Authentication](auth.md): auth schemes, OAuth, and cookie jar.
- [Persistence](persistence-architecture.md): exact file/local/vault classification and recovery.
- [GraphQL](graphql.md): request and schema lifecycles.
- [Imports and integrations](imports-and-integrations.md): normalized import boundary and reserved concepts.
- [Modular architecture migration plan](modular-architecture-migration-plan.md): target public/private composition, extension contracts, and the incremental native content-engine migration.

## Key files

- `src/App.tsx` — creates the OSS product through `createPurrApp`.
- `src/app/create-purr-app.tsx` — installs services, theme, and the shared router.
- `src/app/composition/core-services.ts` — selects and assembles browser/desktop adapters.
- `src/app/app-router.tsx` — renders validated immutable route descriptors.
- `src/features/workspaces/workspace-workbench.tsx` — top-level workspace orchestration and feature composition.
- `src/features/workspaces/hooks/use-workspaces.ts` — load, autosave, flush, and failure handling.
- `src/domain/project.ts` — canonical schemas and cross-resource validation.
- `src/application/project-projection.ts` — runtime/canonical/local/secret projection.
- `src/application/workspace-persistence.ts` — file layout, revisions, commits, and external reconciliation.
- `src/application/ports/` — frontend platform contracts and local table names.
- `src/platform/tauri/application-services.ts` — Tauri commands and desktop adapters.
- `src-tauri/src/lib.rs` — complete native command registration map.
