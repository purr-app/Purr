# GraphQL

This document owns GraphQL request and schema behavior. GraphQL uses the normal HTTP/auth/cookie/variable pipeline; this document covers only its GraphQL-specific model, preparation, editor services, and response views.

## Two distinct resources

Purr keeps GraphQL requests and schemas separate:

- a `GraphqlDocument` is a request definition with endpoint, headers/auth/body infrastructure plus query, variables, selected operation, and optional `schemaId`;
- a `SchemaDocument` is a schema source/cache/snapshot and explorer state, not an executable request.

Both are workspace documents in runtime. GraphQL requests live with HTTP requests in the common `documents/` folder tree; schemas appear in the derived Schemas group and persist under `schemas/`.

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

## Schema linking

A GraphQL request can identify a schema by `graphql.schemaId`. `WorkspaceWorkbench` also resolves a schema whose `sourceRequestId` is that request and retains endpoint-based fallback for older links. Opening Schema from a request creates/reuses a `SchemaDocument` and writes the selected schema ID back to the request.

The parsed `GraphQLSchema` is passed to the query editor for completion, hover, diagnostics, and navigation. Clicking a type reference can open the schema document focused on that type.

## Schema sources

Canonical `SchemaDefinition.source` supports:

- `introspection {endpoint, requestId?}`;
- `sdl-file {location?, endpoint?}`;
- `introspection-json {location?, endpoint?}`;
- `registry {provider,resource,credential?}`.

Current working sources are introspection and user-selected SDL/introspection JSON files. Registry is a canonical extension point only; no provider implementation or UI resolves it.

`parseGraphqlSchema` accepts SDL or introspection JSON, builds a schema, and runs `validateSchema`. `normalizeSchema` prints introspection JSON as normalized SDL; for SDL it prints the imported AST to preserve applied custom directives and extensions that an introspection representation may lose.

## Introspection flow

`SchemaExplorer` creates an introspection `RequestDraft`, usually from the linked request. It applies workspace GraphQL shared configuration, variables, auth/OAuth runtime, and cookie jar through the normal request execution services, then requires a 2xx response and installs normalized SDL.

Schema installation currently requires the inline compatibility response. A larger introspection result stays native and fails with an explicit size message; Phase 10 owns moving schema construction/analysis off the WebView rather than reintroducing a full IPC body copy.

```text
linked GraphQL request / schema endpoint
  → getIntrospectionQuery()
  → workspace-effective GraphQL request
  → executeRequest() + cookie jar
  → parse/validate introspection JSON
  → normalize to SDL
  → SchemaDocument cache/snapshot
```

Changing an unpinned schema endpoint clears stale SDL/cache state. File import reads the selected browser `File` as text and validates before installation. The schema can be downloaded as SDL or introspection JSON.

## Cache and pinning

Every schema document writes local `schema_cache` containing SDL, load time, and source identity. The cache is reused only when its recorded source equals the current canonical source.

When `pin` is true, projection also writes the SDL to a Git-friendly `.graphql` sidecar and the schema YAML references it. That snapshot wins on restore and remains available offline/across machines. When unpinned, canonical YAML keeps source metadata but SDL remains only in encrypted local cache and can be regenerated.

Pinning is about portability, not whether the schema document itself is saved.

## Explorer and language service

`SchemaExplorer` provides:

- type registry grouped by operation roots, objects, inputs, enums, interfaces, unions, and scalars;
- type/field search;
- field arguments, return types, descriptions, deprecations, possible types, and simple schema metrics;
- SDL/introspection JSON source view and download;
- request generation for query/mutation root fields.

`GraphqlCodeEditor` uses CodeMirror, GraphQL language support, and `graphql-language-service` for completion and hover. It adds schema type navigation, operation run widgets, “fill fields” completion behavior, variable JSON completion, validation, and the shared Purr code theme. This is local client-side language intelligence; there is no language server process.

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

There is no separate GraphQL credential, cookie, or transport subsystem.

## Unsupported/reserved behavior

- subscriptions/streaming transports are rejected;
- registry schema providers are not implemented;
- Federation behavior is not implemented;
- schemas are not automatically refreshed in the background;
- importing a schema does not create a generic project import adapter;
- Trace and benchmark concepts are unrelated reserved features, not GraphQL views.

## Key files

- `src/features/graphql/model/graphql.ts` — GraphQL HTTP preparation and schema parse/normalize.
- `src/features/graphql/components/graphql-query-editor.tsx` — query, variables dock, operation selection, formatting, and diagnostics.
- `src/features/graphql/components/graphql-code-editor.tsx` — CodeMirror GraphQL/JSON language intelligence, hover, completion, navigation, and run widgets.
- `src/features/graphql/components/graphql-variables-dock.tsx` — variables JSON editor and schema-derived hints.
- `src/features/graphql/components/schema-explorer.tsx` — source selection, introspection, cache installation, explorer, generated requests, and download.
- `src/features/workspaces/workspace-workbench.tsx` — request/schema linking and active schema selection.
- `src/features/request-workbench/services/execute-request.ts` — shared GraphQL/auth/body/wire preparation.
- `src/features/request-workbench/components/response-viewer.tsx` — GraphQL Errors/Extensions views.
- `src/domain/project.ts` — canonical GraphQL request and schema source schemas.
- `src/application/project-projection.ts` — request/schema projection, pinning, and cache hydration.
