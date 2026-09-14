# Imports, exports, and integrations

This document distinguishes working import/export behavior from architectural extension points. Current code has a complete cURL request paste/copy workflow and a generic normalized project-import boundary, but no registered OpenAPI/Postman/Yaak adapters or integration providers.

## Current feature status

| Capability | Status |
| --- | --- |
| Paste a cURL command into a request | Working |
| Create a request from cURL in an empty/non-HTTP context | Working |
| Copy effective request as cURL/wget/HTTP | Working with explicit secret reveal |
| Duplicate a Purr document | Working inside a workspace |
| Canonical `ImportAdapter` contract and registry | Implemented boundary |
| Validate and persist a `NormalizedImportResult` | Implemented application path |
| Import preview UI | Not implemented |
| OpenAPI/Postman/Other collection adapters | Not implemented |
| Generic project export package | Not implemented; canonical directory is the portable artifact |
| Integration provider runtime/UI | Not implemented |
| Trace/observability providers | Reserved only |
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

## Generic import boundary

`src/importing/contracts.ts` defines:

- `ImportSource`: primary text plus optional named bytes;
- `ImportDiagnostic`: stable warning/error codes with source/resource context;
- `ImportPreview`: adapter ID, resource counts, diagnostics, and optional environment candidates;
- `ImportOptions`: destination workspace, secret inclusion, and duplicate policy;
- `NormalizedImportResult`: canonical workspace/resources, diagnostics, and transient secret values;
- `ImportAdapter`: `canImport`, `inspect`, and `import`;
- `ImportAdapterRegistry`: adapter registration and source detection.

```text
source file(s)
  → adapter.canImport()
  → adapter.inspect()             no persistence, no secret leakage
  → user options/conflict choice  future UI
  → adapter.import()
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
- secret values are written directly to `SecureStore`, never diagnostics/preview/YAML;
- the normal persistence path performs canonical/local projection and commit.

The contract exposes duplicate policy and environment candidates, but there is no UI or concrete adapter applying rename/skip behavior today. Secret writes happen before the project commit; a later commit failure may leave an unused secure value, but must never cause plaintext fallback.

## Requirements for future collection adapters

OpenAPI, Postman, Yaak, and similar formats are roadmap items, not working features. When an adapter is implemented, this document and its tests must state:

- source versions/media types and detection;
- mapping for folders, HTTP/GraphQL requests, params, duplicate/disabled rows, bodies, and attachments;
- environment/variable mapping and precedence;
- auth/cookie mapping and secret extraction;
- scripts or unsupported-feature policy;
- collision/rename/skip semantics;
- diagnostics with source paths;
- whether imports add resources or create a workspace.

Do not advertise an adapter based only on the existence of `ImportAdapter`.

## Integration resources

`integrationDefinitionSchema` reserves a canonical resource with provider, endpoint, and credential map. `projectWorkspace` preserves these resources in `extraResources`, and `WorkspacePersistence` writes them under `integrations/`.

There is currently no integration registry, provider adapter, settings/editor UI, execution lifecycle, or credential acquisition flow. The schema is a persistence extension point only. New providers must define typed runtime ownership and use `Credential`/`SecretRef`; they must not interpret arbitrary integration YAML directly in feature components.

## Tracing and observability

Trace is currently a disabled response tab plus a reserved document discriminant. There is no trace ID extraction, trace context propagation, provider lookup, normalized trace/log model, cache, persistence, or Jaeger/Datadog/CloudWatch/Grafana/Loki integration.

When tracing becomes real, documentation must be expanded from actual code to cover:

```text
request/response
  → correlation identifier source
  → provider lookup boundary
  → normalized trace/log model
  → response Trace UI
```

Do not hardcode that future design in canonical schemas until implementation confirms ownership, credential, local-cache, and IPC boundaries.

## History and benchmark concepts

Execution history currently has encrypted native storage and metadata pagination, but no history browser or arbitrary response hydration flow; see [Response lifecycle](response-lifecycle.md#execution-history). `benchmark` exists only as a reserved document-kind discriminant. Neither should be described as a complete user-facing feature.

## Key files

- `src/features/request-workbench/model/curl-import.ts` — cURL tokenization, mapping, and sensitive-header discovery.
- `src/features/request-workbench/components/request-composer.tsx` — URL-input paste interception.
- `src/features/workspaces/workspace-workbench.tsx` — replace-active versus create-document cURL behavior and secret-variable protection.
- `src/features/request-workbench/components/request-code-dialog.tsx` — effective request, cookie merge, reveal, and clipboard UX.
- `src/features/request-workbench/model/request-code.ts` — cURL/wget/HTTP rendering and escaping.
- `src/importing/contracts.ts` — generic adapter, preview, diagnostics, and normalized result contracts.
- `src/application/import-project.ts` — validation, secret writes, and import commit.
- `src/application/workspace-persistence.ts` — additive collision handling and normal persistence path.
- `src/domain/project.ts` — canonical import targets and reserved integration shape.
- `src/features/request-workbench/components/response-viewer.tsx` — disabled Trace surface.
