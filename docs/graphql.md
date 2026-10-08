# GraphQL

This document owns GraphQL request and schema behavior. GraphQL uses the normal HTTP/auth/cookie/variable pipeline; this document covers only its GraphQL-specific model, preparation, editor services, and response views.

## Requests and Schema Connections

A GraphQL request is an independent operation with query, variables, selected operation and optional `graphql.schemaId`. A Schema Connection is a workspace-level API context, represented by the existing `SchemaDocument` / canonical `SchemaDefinition(kind=schema)`. It owns name, endpoint, source, authentication, introspection-only headers, a cached schema and last successful load time. Multiple requests can share one connection.

Requests stay in the common Documents/folders tree. Connections appear in the separate Schema Connections group and persist under `schemas/`; creating a connection saves its configuration even before a successful fetch. Deleting or closing a request never changes its connection.

## GraphQL request over HTTP

`prepareGraphqlRequest` in `model/graphql.ts`:

1. requires a nonempty query and parses it with `graphql`;
2. finds the selected operation;
3. requires explicit operation selection when multiple operations are ambiguous;
4. rejects subscriptions because no streaming transport exists;
5. parses variables as a JSON object;
6. converts the draft to `POST` with JSON `{query, variables, operationName?}`.

From there GraphQL is an ordinary HTTP request: body validation/content type, workspace shared headers/auth, variables, cookie jar, redirect policy, native transport, history, and downloads all use the shared lifecycle. `RequestDefinition(kind=graphql)` persists GraphQL fields separately from the derived HTTP JSON body so the editor model remains canonical.

See [Request lifecycle](request-lifecycle.md) for the complete ordering.

## Query, variables, and operation selection

`GraphqlQueryEditor` owns query text and a variables dock. `getGraphqlOperations` discovers named operations and their source spans. The operation selector follows the cursor/selection and explicit Run actions; a stale selected name is cleared or replaced when the document changes.

Query syntax/formatting uses the GraphQL parser. Diagnostics run after a short debounce: syntax-only without a schema and schema-aware `graphql-language-service` diagnostics with one. Variables must be a JSON object at send time. The variables editor uses JSON diagnostics and schema-derived variable hints.

Template variables can appear in query text, variables JSON, operation name, endpoint, headers, auth, and active request fields. GraphQL variable JSON substitution preserves native JSON types when a string is exactly one template token.

Subscriptions can appear in an imported schema and explorer, but cannot be sent. Query and mutation are the supported operations.

## Selection and workflows

The request toolbar is ordered GQL, URL, schema icon and adjacent Schema Connection selector, then Send. It has a Schema Connection selector with an explicit No schema option, a status dot for every connection and a create action. A selected connection makes the URL read-only and supplies its live endpoint to execution and export. The endpoint is edited in the connection editor. Query/path parameter editors cannot override the bound endpoint. Missing or stale schema data does not prevent sending; an endpoint is still required.

New requests select the canonical workspace `defaultGraphqlSchemaId`, otherwise the locally remembered last-used connection, otherwise No schema. Newly created bound requests inherit connection auth. Existing auth overrides survive switching connections. Request auth can explicitly inherit from the connection, select a workspace profile, use its own scheme or choose None. Connection auth may itself inherit a workspace profile.

Request-first: enter a URL and open the schema icon or choose New Schema Connection in the selector. This creates and opens a connection tab, prefilling endpoint, auth and introspection headers from the request, and links the request. No creation dialog or automatic fetch runs. Configure private access through Settings, then Reload to introspect. Existing connections can be selected directly without fetching again. Failures leave editable connection settings available for retry.

The compact connection toolbar has an explicit bordered source input: endpoint for introspection, or a read-only imported file location (filename when the picker does not expose a path). Name, default selection, auth and introspection headers live in the Settings modal. File-backed connections keep their separate request endpoint in Settings; the file location is never used as an HTTP URL. Workspace settings → GraphQL also selects the default connection.

Schema-first: create a connection, configure auth, fetch/import, then generate query/mutation requests from root fields in the explorer. Generated requests live in Documents and inherit the connection endpoint/auth. Further requests reuse the cached schema without another fetch.

No schema materializes the current endpoint and inherited auth configuration into the working request. Deleting a connection does the same independently for saved and working copies of all linked requests, and clears default/last-used references. Copied credentials receive independent SecureStore ownership when persisted. History records capture the effective connection settings rather than retaining a live binding.

The cached `GraphQLSchema` supplies completion, hover, diagnostics and type navigation. A request without a schema still has syntax validation and remains executable.

## Schema sources

Canonical `SchemaDefinition.source` supports:

- `introspection`;
- `sdl-file {location?}`;
- `introspection-json {location?}`;
- `registry {provider,resource,credential?}`.

Endpoint and auth are connection-level fields, independent of source kind. Legacy source-level endpoints and `requestId` are accepted for migration only. Current working sources are introspection and user-selected SDL/introspection JSON files. Registry is a canonical extension point only; no provider implementation or UI resolves it.

`parseGraphqlSchema` accepts SDL or introspection JSON, builds a schema, and runs `validateSchema`. `normalizeSchema` prints introspection JSON as normalized SDL; for SDL it prints the imported AST to preserve applied custom directives and extensions that an introspection representation may lose. Schema-source normalization and validation run in a dedicated Web Worker. The worker uses monotonically increasing request IDs; replacing or aborting an analysis terminates its worker, and a stale result cannot install an older schema.

## Introspection flow

`SchemaExplorer` creates an introspection `RequestDraft` from connection settings, never from a linked request. Connection headers augment/override workspace headers for introspection only. Its Authentication editor supports None, Bearer, Basic, API Key, OAuth 2.0 and workspace inheritance. Credential-like headers are stored securely; other headers have an explicit secure-storage toggle. It applies workspace GraphQL shared configuration, variables, auth/OAuth runtime, and cookie jar through the normal request execution services, then requires a 2xx response and installs normalized SDL.

Inline introspection installs directly. A referenced introspection response is read through bounded `ResponseContentPort` windows, released immediately after materialization, and sent to the schema-analysis worker. This removes the old 1 MiB installation failure and keeps JSON parsing, schema construction, validation, and SDL normalization off the UI thread. It does not claim constant memory: the worker still receives the complete introspection source and returns the normalized SDL.

```text
Schema Connection endpoint / auth / introspection headers
  → getIntrospectionQuery()
  → workspace-effective GraphQL request
  → executeRequest() + cookie jar
  → inline text or bounded ResponseContentPort reads
  → worker parse/validate introspection JSON
  → worker normalize to SDL
  → SchemaDocument cache/snapshot
```

Configuration changes do not discard the last valid schema. A late result cannot replace a schema after its source, endpoint, auth or environment context changes. File import reads the selected browser `File` as text and validates before installation; Reload for a file source asks the user to select a file again. The schema can be downloaded as SDL or introspection JSON through the shared `DownloadPort`. Desktop export opens the native save dialog to choose the file name and location; cancellation writes nothing. Browser preview uses its save picker when available, otherwise browser-managed downloads. The inline-download IPC accepts an optional dialog title so schema exports are labelled correctly.

## Cache and pinning

Every connection writes a version-2 local `schema_cache` with normalized SDL, last successful load time, a canonical-definition hash and an opaque SHA-256 load-context identity. Credential values are not copied into cache metadata. Changes to source, endpoint, active auth, introspection headers, inherited configuration or environment make an existing cache Stale. OAuth token rotation does not change identity.

The selector and editor show Not fetched, Loading, Loaded, Stale or Error using a dot and an accessible text label. A successful SDL/JSON import counts as Loaded. Failed reloads preserve the last valid SDL and timestamp. There is no time-based expiry or background refresh.

Pin defaults to enabled. A valid SDL snapshot is written to a Git-friendly `.graphql` sidecar; no empty snapshot is written before the first load. With Pin disabled, SDL remains in encrypted local cache. Pinned snapshots are available on another machine without fetching, even when that machine has no local load timestamp.

Older per-request schemas migrate without changing IDs. Source request endpoint/auth/headers are copied once, after which the connection is independent. A legacy request whose URL conflicts with its connection is detached without changing its target. Missing connections are tolerated, and obsolete local records do not prevent workspace opening.

## Explorer and language service

`SchemaExplorer` provides:

- type registry grouped by operation roots, objects, inputs, enums, interfaces, unions, and scalars;
- type/field search;
- field arguments, return types, descriptions, deprecations, possible types, and simple schema metrics;
- SDL/introspection JSON source view and download;
- request generation for query/mutation root fields.

`GraphqlCodeEditor` uses CodeMirror, GraphQL language support, and `graphql-language-service` for completion and hover. It adds schema type navigation, operation run widgets, “fill fields” completion behavior, variable JSON completion, validation, and the shared Purr code theme. This is local client-side language intelligence; there is no language server process. The normalized SDL is still parsed once on the UI side into the `GraphQLSchema` object required by these libraries. Phase 10 measurements put the 1,200-type normalized-SDL parse at about 18 ms in the non-CI Node baseline, and desktop baseline testing found no editor responsiveness failure, so moving completion/hover/diagnostics across worker messages or adding a Rust schema service is not currently justified.

Successful analysis records `purr.graphql.schema.worker-round-trip` in the window Performance Timeline. UI-side schema construction records `purr.graphql.schema.parse`. These entries support local profiling and have no absolute CI timing assertion.

Federation-specific composition, subgraph navigation, or registry features are not implemented.

## Response semantics

The transport returns a normal `HttpResult`. For JSON object responses, `ResponseViewer` conditionally adds:

- Errors for top-level `errors`;
- Extensions for top-level `extensions`.

Top-level `data` remains part of the Response body. A GraphQL `errors` array does not turn a 2xx response into a native error. Non-JSON or invalid GraphQL responses fall back to ordinary content detection/display.

For referenced large responses, the bounded viewer offers Data, Errors, and Extensions extraction controls backed by native jq path queries. Results remain bounded values or temporary encrypted content references; the full GraphQL response is not reconstructed in JavaScript.

## Inheritance

GraphQL shares:

- global/workspace/environment variable resolution;
- workspace headers/auth entries scoped to `all` or `graphql`;
- request-level opt-outs and header exclusions;
- the workspace cookie jar and redirect policy;
- cURL/code export after GraphQL has been prepared as HTTP JSON.

Connection endpoint/auth resolution participates in the existing request composition path, including Send, dynamic-variable dependencies and code/cURL export. There is no separate GraphQL vault, cookie jar or transport subsystem.

## Unsupported/reserved behavior

- subscriptions/streaming transports are rejected;
- registry schema providers are not implemented;
- Federation behavior is not implemented;
- schemas are not automatically refreshed in the background;
- importing a schema does not create a generic project import adapter;
- Trace and benchmark concepts are unrelated reserved features, not GraphQL views.

## Key files

- `src/features/graphql/model/graphql.ts` — GraphQL HTTP preparation and schema parse/normalize.
- `src/features/graphql/services/schema-analysis.ts` — cancellable worker client and analysis timings.
- `src/features/graphql/workers/graphql-schema.worker.ts` — schema-source parse/validate/normalization worker.
- `src/features/graphql/components/graphql-query-editor.tsx` — query, variables dock, operation selection, formatting, and diagnostics.
- `src/features/graphql/components/graphql-code-editor.tsx` — CodeMirror GraphQL/JSON language intelligence, hover, completion, navigation, and run widgets.
- `src/features/graphql/components/graphql-variables-dock.tsx` — variables JSON editor and schema-derived hints.
- `src/features/graphql/components/schema-explorer.tsx` — source selection, introspection, cache installation, explorer, generated requests, and download.
- `src/features/workspaces/workspace-workbench.tsx` — request/schema linking and active schema selection.
- `src/features/request-workbench/services/execute-request.ts` — shared GraphQL/auth/body/wire preparation.
- `src/features/request-workbench/components/response-viewer.tsx` — GraphQL Errors/Extensions views.
- `src/domain/project.ts` — canonical GraphQL request and schema source schemas.
- `src/application/project-projection.ts` — request/schema projection, pinning, and cache hydration.
