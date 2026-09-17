# Imports, exports, and integrations

This document distinguishes working import/export behavior from architectural extension points. Current code has a complete cURL request paste/copy workflow, a native OpenAPI 3.x workspace importer, and a native Jaeger trace lookup adapter. Postman, Insomnia, Bruno, Yaak, and other integration providers remain extension points.

## Current feature status

| Capability | Status |
| --- | --- |
| Paste a cURL command into a request | Working |
| Create a request from cURL in an empty/non-HTTP context | Working |
| Copy effective request as cURL/wget/HTTP | Working with explicit secret reveal |
| Duplicate a Purr document | Working inside a workspace |
| Native `ImportAdapter` contract and registry | Implemented boundary |
| Validate and persist a `NormalizedImportResult` | Implemented application path |
| New-workspace import UI | Working for file, folder, URL, and pasted text |
| OpenAPI 3.0/3.1 adapter | Working first version |
| Postman/Insomnia/Bruno/Yaak adapters | Not implemented |
| Generic project export package | Not implemented; canonical directory is the portable artifact |
| Canonical integration envelope and unavailable-provider management | Working |
| Build-time frontend extension/presentation registry | Implemented immutable composition boundary; no executable provider runtime yet |
| Extension pages/navigation and workspace document types | Working composition and unavailable-document lifecycle |
| Trace/observability providers | Native Jaeger Query API v3 adapter, propagation, response-linked hierarchy/details UI; two opt-in synthetic providers for conformance |
| Benchmark/history browser | Benchmark reserved; history storage API only |

## cURL paste/import

The cURL workflow is request-local rather than an `ImportAdapter`. `RequestComposer` intercepts a recognized command pasted into the URL input and calls `WorkspaceWorkbench`:

- active HTTP document: replace its working request fields, preserving document identity and saved baseline;
- active GraphQL/schema/non-request context: create a new HTTP draft;
- empty workspace paste action: create a new HTTP draft.

Nothing is automatically saved. `importCurl` maps method, URL/query, headers, inline cookies, selected auth forms, and text-like bodies. Sensitive unmapped headers are replaced with newly created sensitive workspace variables before they can be projected. Exact flags and limitations are listed in [Request lifecycle](request-lifecycle.md#paste-curl).

## Copy/export request code

`RequestCodeDialog` prepares the workspace-effective request, including shared config, active body/auth, resolved static templates, and cookie jar. The dialog defaults to the redacted display request. Real credentials reach the clipboard only if the user explicitly reveals them first.

Formats are cURL, wget, and HTTP/1.1. The cURL/wget renderers use POSIX single-quote escaping. Binary request bodies are represented by an informational placeholder rather than exported as a working file reference. Dynamic dependency requests are not executed merely to open the dialog.

The canonical workspace directory remains the only current project-level export: copy/commit the Git-friendly files together with assets, and provision secret values separately.

## Native import pipeline

The New workspace row reveals **New empty** and **Import** side options only while that row is hovered or after it is clicked. The compact import modal has one file drop/picker, an explicit folder picker, and one field that accepts either a filesystem path or an HTTP(S) URL. A typed path is classified as file or directory by native filesystem metadata. The native contract also accepts in-memory text, which is used as the fallback when a browser-style dropped `File` does not expose a native path. Missing/inaccessible sources, invalid YAML/JSON, ambiguous folders, unsupported formats, remote failures, and normalization failures remain in the modal as errors; no workspace is added to runtime state.

```text
ImportWorkspaceDialog
  → import_collection IPC
  → Rust ImportSource loader (file/directory/URL/text)
  → JSON/YAML parse on a blocking worker
  → metadata-based adapter detection
  → local/remote $ref document loading and resolution
  → OpenApi3Adapter → Rust ImportModel
  → normalized canonical result (the foreign AST never reaches React)
  → validateProject() / persistImport()
  → WorkspacePersistence canonical commit + SecureStore
  → add and activate runtime Workspace
```

The project becomes visible and active only after the normal revision-checked persistence route succeeds. Parsing and normalization do not run on the WebView/UI thread. The root plus all referenced source documents share a cumulative 64 MiB and 256-document budget; remote bodies are read incrementally so a missing `Content-Length` cannot bypass the limit. URL imports accept HTTP(S), follow at most ten redirects, and remote `$ref` documents must also use HTTP(S). File imports recursively load referenced JSON/YAML files, including relative files outside the root file's immediate directory. An unresolved reference fails the import instead of producing a partial request. Directory detection requires exactly one document whose top-level `openapi` value starts with `3.`.

## OpenAPI 3.x mapping

- folders use the first operation tag; additional tags do not duplicate requests;
- without tags, the first meaningful path segment is used, skipping a leading `api` or `v<number>` segment, so `/api/users/{id}/posts` becomes one `Users` folder rather than a deep path tree;
- request names use `summary`, then `operationId`, then `METHOD path`;
- `operationId` is retained independently in `RequestDefinition.origin` together with the operation pointer and imported schema ID;
- one server creates workspace `baseUrl` plus defaults for server template variables; multiple servers create environments, each with `baseUrl`, and the first is selected locally;
- server `{variable}` placeholders become Purr `{{variable}}` templates;
- OpenAPI `{pathParam}` segments become Purr `:pathParam`; path parameters are enabled, while optional query/header parameters are retained disabled with their example/default when available;
- JSON, XML, text, URL-encoded, multipart, and binary body modes are selected from request content. JSON schemas/examples create an editable example body, and the generated structure is also appended to request documentation;
- every operation receives baseline Markdown in the request Docs tab: display name, operation ID when present, parameter location/required state, selected and available request-body content types, and response statuses/descriptions. OpenAPI descriptions, external documentation links, resolved schema descriptions, and generated body examples enrich that baseline when available;
- the original OpenAPI source is stored as a canonical `api-schema` resource with a referenced `schemas/*.openapi` sidecar.

Every supported Bearer, Basic, header/query/cookie API-key, or OAuth 2.0 authorization-code/client-credentials security scheme becomes a named workspace shared-auth profile. Each imported request persists the stable profile ID selected by its effective operation/global `security` declaration; an explicit empty security declaration becomes a request auth opt-out. Credential placeholders are direct `SecretRef` fields on the profile, with empty values initialized in `SecureStore`; the importer does not invent credential variables or write plaintext values to YAML. OAuth endpoint `{variable}` placeholders become Purr `{{variable}}` templates. OpenID Connect currently imports as bearer-token auth with a warning because discovery is not implemented. Unsupported HTTP schemes, OAuth flows, combined auth beyond the first supported scheme, and mutual TLS produce diagnostics rather than invented transport behavior.

Schema-driven body completion is not implemented yet. The imported example body and `origin` link preserve enough canonical information for a future completion service without storing the OpenAPI AST inside each request. The first version maps root-level `servers`; path-item and operation-level server overrides are not yet projected. External reference documents participate in normalization, while the canonical `api-schema` resource currently retains the selected root source rather than a bundled copy of every dependency.

## Generic normalized boundary

`src/importing/contracts.ts` defines the IPC/application shapes:

- `ImportSource`: discriminated inferred path, explicit file/directory, URL, or text source;
- `ImportDiagnostic`: stable warning/error codes with source/resource context;
- `ImportPreview`: adapter ID, resource counts, diagnostics, and optional environment candidates;
- `ImportOptions`: destination workspace, secret inclusion, and duplicate policy;
- `NormalizedImportResult`: the canonical handoff from native normalization to application persistence.

The concrete `ImportAdapter` trait and registry live in `src-tauri/src/importing.rs`, so future large collection parsers normalize to the same Rust `ImportModel` before producing Purr canonical resources.

```text
ImportSource
  → native adapter.can_import()
  → adapter.normalize() → ImportModel
  → NormalizedImportResult
  → validateProject()
  → persistImport()
  → WorkspacePersistence
```

Adapters must normalize into the existing canonical model. They do not get to write YAML, SQLite, filesystem assets, or secret values directly.

## Import persistence and collisions

`persistImport` rejects results with error diagnostics, validates the project, and calls `WorkspacePersistence.prepareImport`. Import is additive:

- an existing workspace definition/defaults cannot be silently replaced;
- unrelated existing resources remain;
- duplicate resource IDs are rejected before commit;
- every transient secret ref must be unique and scoped to the destination workspace;
- secret values are written directly to `SecureStore`, never diagnostics/preview/YAML, and are removed again if any later secret write or the canonical project commit fails;
- the normal persistence path performs canonical/local projection and commit.

The TypeScript contract still exposes duplicate policy and preview/environment-candidate shapes for a future preview step; the current new-workspace flow imports directly after validation.

## Requirements for future collection adapters

Postman, Insomnia, Bruno, Yaak, and similar formats are roadmap items, not working features. When another adapter is implemented, this document and its tests must state:

- source versions/media types and detection;
- mapping for folders, HTTP/GraphQL requests, params, duplicate/disabled rows, bodies, and attachments;
- environment/variable mapping and precedence;
- auth/cookie mapping and secret extraction;
- scripts or unsupported-feature policy;
- collision/rename/skip semantics;
- diagnostics with source paths;
- whether imports add resources or create a workspace.

Do not advertise an adapter based only on its registration; it needs mapping, persistence, and end-to-end tests.

## Integration resources

`integrationDefinitionSchema` defines a provider-neutral canonical envelope with a stable provider ID, enable state, positive config version, opaque JSON config, and an explicit credential map. `projectWorkspace` preserves these resources in `extraResources`, and `WorkspacePersistence` writes them under `integrations/`.

Legacy resources with a top-level `endpoint` migrate it to `config.endpoint` when loaded. Canonical saves omit the legacy field. The YAML codec preserves `config` recursively rather than applying core compaction rules inside provider-owned JSON, so unknown private fields, empty arrays, and provider values that resemble core defaults survive save/reload unchanged. Core validates `SecretRef` ownership only through the explicit credential map; JSON inside `config` is data and is never interpreted as a credential.

Workspace settings list every configured integration once, with its native capability labels, and obtain execution availability through `ObservabilityPort`. Frontend presentation registration alone cannot make a provider executable. Unavailable definitions remain enableable/deletable and survive canonical round trips. Registered settings components can edit their own config; the host submits it to native `observability_validate_config` before the normal project save. Integration identity cannot change through the editor. The host supplies scoped credential access limited to the instance's declared slots. Auth editor state is transient and values are stored in SecureStore, never project YAML.

The build-time frontend extension registry accepts integration presentation metadata/settings through the public extension API and rejects duplicate presentation IDs before rendering. It does not accept executable trace/log providers, correlation extractors, credential resolvers, or provider caches. The Rust registry separates one `IntegrationDescriptor` (versioned config and credential slots) from capability-specific provider registrations. A provider can gain a second capability without creating another integration instance or adding optional methods to a monolithic provider trait. Logs execution is not implemented yet. Provider credentials use `SecretRef`; plaintext resolution, HTTP/vendor parsing, correlation, normalization, caching, pagination, and cancellation belong to Rust. Core viewer components must not interpret arbitrary integration YAML or branch on provider IDs.

## Build-time extension modules

`createPurrApp({ modules })` is the only supported frontend composition seam. Each module declares an extension API version and stable module ID, then registers named contributions. Page routes are always `/extensions/<module-id>/<route-segment>`. Registry arrays and lookup views freeze after composition; duplicate module/provider/page/document IDs, route collisions, late registration, and unsupported API versions fail startup before a partial application renders.

The curated entry points are `@purr/core/app`, `@purr/core/extension-api`, `@purr/core/ui`, `@purr/core/test-kit`, and `@purr/core/styles`. They resolve to the compiled `dist-core` artifact; source paths are not a compatibility contract. React and React DOM remain external peer dependencies. A module may own its React page, editor, services, and adapters, but it cannot import core workspaces, storage implementations, router internals, or feature components. The conformance fixture under `tests/fixtures/extensions/` demonstrates zero-module, unavailable-module, restore, and conflict behavior. `tests/fixtures/core-consumer/` additionally builds a complete external frontend from only the published surfaces, including the CSS and GraphQL worker asset.

The matching native composition seam is `purr_core::core_builder()`. The consuming binary supplies its own Tauri context and may add typed Tauri plugins, `IntegrationDescriptor`s, capability-specific `TraceProvider`s, `CorrelationExtractor`s, and `TracePropagator`s. These provider traits and normalized domain values are re-exported from `purr_core::native_extension_api`. `ProviderContext` contains validated opaque config plus a scoped credential reader limited to the descriptor's declared keys; extensions cannot construct that reader or access the underlying secret store. Raw persistence, SQLite, content storage, core command registration, and credential mutation are not public APIs.

The final shell owns its Tauri configuration, capabilities, icon and plugin permissions. It must directly depend on the public Tauri plugins used by core (`tauri-plugin-dialog` and `tauri-plugin-opener`) so their ACL manifests are visible while generating the shell context. The core consumer fixture compiles a separate plugin crate and fake provider to enforce this exact path. See [Phase 15 verification](testing/phase-15-core-consumer.md).

## Tracing and observability

The response Trace tab renders bounded normalized native results through `ObservabilityPort`. The public build registers Jaeger by default in both Rust and frontend composition. `VITE_PURR_JAEGER=disabled` removes its frontend module; Cargo `--no-default-features` removes its native adapter independently. These flags do not remove propagation or the generic viewer. An explicit `observability-fixtures` Cargo feature additionally registers `test.trace-alpha` and `test.trace-beta`; they return deterministic synthetic spans and require a synthetic scoped credential. They make no network calls and are not production integrations.

The current flow is:

```text
request/response
  → observability_trace IPC using workspace/integration/document/start timestamp
  → Rust loads exact encrypted execution metadata and canonical integration
  → Rust correlation extraction, scoped credential resolution and provider lookup
  → Rust bounded cache, provider result validation, ancestor-preserving search and pagination
  → bounded normalized TracePage v2 (spans, hierarchical rows, correlation provenance)
  → one incremental hierarchy, selection and separate span inspector
```

Provider-specific trace DTOs never cross into React. Credentials are accessible only through the host-scoped secure-store capability for editing and shared request composition; they never enter normalized trace pages. Canonical integration YAML stores `SecretRef` values and opaque provider config; the Rust provider validates/migrates that config and resolves only its declared credential keys. The frontend renders normalized bounded results and UI state only.

The core extractor supports W3C version-00 `traceparent`, B3 single/multi-header trace IDs and manual input. Response headers take precedence over request headers; only the first valid reference is used per lookup. Extractors can request a native body prefix of at most 64 KiB; standard header extraction does not read body bytes. The exact saved execution lookup is scoped by workspace/document/start timestamp and does not hydrate bodies. The native service retries the normal save debounce for up to one second, then reports a missing-save state. It independently records `injectedTraceId` (context actually sent, including an explicit user header), `lookupReference` (ID/source/format), and `resolvedTraceId` (provider result). A valid resolved ID may differ from the lookup ID. UI groups equal IDs and labels differing roles explicitly.

Limits: 50,000 spans / 16 MiB per normalized trace, 25 spans per IPC page, up to 256 attributes per span (4 KiB strings, 128 scalar array elements), 32 memory-cache entries within a 64 MiB serialized budget and a 60-second TTL, four concurrent operations, 15-second timeout. Cache keys bind workspace, integration, provider/config and current credential fingerprints; credentials are re-resolved before cache hits. Search checks normalized span ID, service, operation, status, attribute keys and scalar/array values in Rust, retaining each match's ancestors. Missing parents become roots; duplicate IDs and cycles are rejected before caching. Cursors bind the exact normalized trace snapshot as well as query/config/credentials, so a changed trace cannot silently corrupt incremental loading.

The viewer is execution-centric. The request selects its provider; there is no provider switcher or manual trace ID override in the response UI. Lazy pages enrich a virtualized waterfall and preserve selection/folding. Native global timing bounds keep its scale stable while more pages arrive. Span details open only on selection, with timing, identity and attribute sections using response code typography. Changing the document, execution, integration or query silently cancels stale work. Explicit Cancel has its own UI state. Opening Trace starts a debounced lookup; normal response display never waits for it. There is no persisted trace cache, provider-wide trace discovery, log API, event/link inspector or background auto-refresh yet.

### Jaeger adapter

The native adapter uses the documented [Jaeger Query HTTP API v3](https://www.jaegertracing.io/docs/2.20/architecture/apis/) at `/api/v3/traces/{traceId}`, matching its [official streaming response schema](https://github.com/jaegertracing/jaeger-idl/blob/main/swagger/api_v3/query_service.openapi.yaml). It does not depend on the internal Jaeger UI `/api/traces` endpoint. Use a query server that exposes v3. Config v1 contains an HTTP(S) `endpoint` (optional base path) and `auth: none | bearer | request`; missing auth migrates to `none`. Embedded URL credentials, query/fragment secrets and unknown config fields are rejected. Bearer tokens resolve natively from the instance's `apiToken` SecretRef only when bearer auth is selected. Redirects are refused to prevent credential forwarding.

The reusable HTTP client has a 12-second request timeout and a 32 MiB wire-body cap even without Content-Length. Bounded OTLP JSON/NDJSON parsing runs on a blocking worker. Resource `service.name`, parent IDs, operation, microsecond timings, status and bounded primitive/array attributes map to the normalized domain; complex attributes, span events and links are not displayed in this slice. Hex/base64 ID encodings are accepted. HTTP 404/empty traces produce a not-found state; auth/transport/parse errors produce safe provider-neutral codes, never raw vendor error bodies. No automatic retries are made; Load trace retries the lookup (successful traces remain cached for up to 60 seconds).

See [Phase 14 verification](testing/phase-14-jaeger.md) for the loopback synthetic service/query server, settings, propagation, provenance, hierarchy, cancellation and provider-free build checks.

See [Phase 13 manual verification](testing/phase-13-observability.md) for the opt-in build, synthetic fixture generator, secure-store provisioning, cancellation and restart scenarios.

## History and benchmark concepts

Execution history currently has encrypted native storage and metadata pagination, but no history browser or arbitrary response hydration flow; see [Response lifecycle](response-lifecycle.md#execution-history). `benchmark` exists only as a reserved document-kind discriminant. Neither should be described as a complete user-facing feature.

## Key files

- `src/features/request-workbench/model/curl-import.ts` — cURL tokenization, mapping, and sensitive-header discovery.
- `src/features/request-workbench/components/request-composer.tsx` — URL-input paste interception.
- `src/features/workspaces/workspace-workbench.tsx` — replace-active versus create-document cURL behavior and secret-variable protection.
- `src/features/request-workbench/components/request-code-dialog.tsx` — effective request, cookie merge, reveal, and clipboard UX.
- `src/features/request-workbench/model/request-code.ts` — cURL/wget/HTTP rendering and escaping.
- `src/importing/contracts.ts` — import source, future preview/options, diagnostics, and normalized-result IPC contracts.
- `src/application/import-workspace.ts` — native IPC call and persistence handoff.
- `src/application/import-project.ts` — validation, secret writes, and import commit.
- `src/features/workspaces/components/import-workspace-dialog.tsx` — source selection, progress, and modal error state.
- `src-tauri/src/importing.rs` — native loaders, OpenAPI adapter, `$ref` resolver, intermediate model, and canonical normalization.
- `src/application/workspace-persistence.ts` — additive collision handling and normal persistence path.
- `src/domain/project.ts` — canonical import targets and the provider-neutral integration envelope.
- `src/features/observability/trace-panel.tsx` — bounded Trace UI through the observability port.
- `src-tauri/src/observability/service.rs` — native provider selection, credentials, correlation, cache and pagination.
- `src-tauri/src/persistence/observability.rs` — read-only canonical integration and saved execution projection.

### Integration catalog and connection editor

Workspace Integrations opens a modal catalog. Frontend presentation contributions
can supply `icon` (a bundled asset URL), `description`, and `capabilities` alongside
`label` and `Settings`; the native registry still determines execution availability.
An optional `traceUrl(config, traceId)` contribution supplies the provider browser
link. The host resolves config variables without composing auth and accepts only
HTTP(S) URLs without embedded credentials. `WorkspaceShellPort.openExternalUrl`
uses the desktop system opener (an isolated new tab in browser previews). Jaeger
retains the endpoint base path and appends `/trace/:traceId`.
Private modules can import `IntegrationConnectionSettings` from `@purr/core/ui`
and declare the `auth` credential slot to reuse the name/endpoint, request AuthEditor,
variable controls and propagation editor. No catalog switch statement is needed.
The Jaeger artwork is sourced from the [Jaeger UI project](https://github.com/jaegertracing/jaeger-ui/blob/main/packages/jaeger-ui/src/img/jaeger-logo.svg).

The host scopes both credential reads and writes to declared slots for the current
workspace and integration. The shared editor stores the entire auth configuration,
including inactive modes and OAuth tokens, in SecureStore; project files contain
only its SecretRef. Legacy Jaeger `apiToken` credentials remain readable. Endpoint
variables remain portable templates. Trace lookup uses the existing request
composition and OAuth helpers to prepare a memory-only connection (resolved endpoint
and auth headers) passed across typed IPC. Native validation, credential scoping,
redirect policy and provider transport remain authoritative; resolved connection
values also isolate trace cache entries. Browser builds cannot execute providers.

Optional `integration.tracing` holds propagation and enabled/disabled custom request
and response header rows; absent fields preserve older integration definitions.
