# Request lifecycle

This document is the source of truth for request models, effective request construction, execution ordering, and cURL request exchange. Authentication scheme details are in [Authentication and cookies](auth.md); variable scope and dependency execution are in [Environments and variables](environments-and-variables.md).

## Request models

### Runtime document and draft

`RequestDocument` in `src/features/workspaces/model/workspace.ts` owns:

- `kind`: `http` or `graphql`;
- mutable `request: RequestDraft`;
- `savedRequest`, the last saved working snapshot;
- `saved`, timestamps, folder identity, and request-editor section;
- `lastResponse` and `sentAt`, which are runtime/local state.

`RequestDraft` in `src/features/request-workbench/model/request.ts` contains method, URL, query and path rows, header rows, all body-editor modes, all auth-editor modes, cookie-jar opt-out, request-level workspace overrides, documentation, and optional GraphQL data. It is deliberately richer than the canonical request schema so switching an editor mode does not destroy inactive input.

### Canonical saved request

`RequestDefinition` in `src/domain/project.ts` is the Git-friendly form. `requestDefinition` in `src/application/project-projection.ts` projects only the saved snapshot (`savedRequest`) when a saved document has unsaved edits; it projects the current request when saving a new or updated document. Empty editor rows, managed rows, inactive body/auth forms, responses, and UI state are excluded.

An OpenAPI-created request may also carry canonical `origin` metadata: the imported API-schema resource ID, JSON pointer to the operation, and the source `operationId` when present. This metadata is identity/navigation context; it does not create an alternative request-composition path.

The lifecycle distinctions are:

- **saved and clean**: `request` and `savedRequest` are equivalent;
- **saved with working edits**: canonical file remains `savedRequest`; the full working document is an encrypted local draft;
- **unsaved meaningful draft**: local-only until Save creates a canonical resource;
- **pristine draft**: may exist while open, but closing/discarding removes it instead of producing a project file.

## End-to-end composition

The call path is shared by HTTP and GraphQL:

```text
RequestComposer edits RequestDraft
  ↓
applyWorkspaceRequestConfig() → effective copy
  ↓
resolveDynamicVariables() → dependency requests + effective values
  ↓
executeRequest()
  ├─ resolveAuth() / OAuth acquire-or-refresh
  └─ prepareWireRequest()
       ├─ resolveRequestEnvironment()
       ├─ normalizeRequestUrlProtocol()
       ├─ applyRequestPathParamsToUrl()
       ├─ prepareGraphqlRequest()
       ├─ validate active body/auth
       ├─ query/header/body serialization
       └─ real WireRequest + redacted display request
  ↓
executeHttp() → cookie merge + redirect policy
  ↓
ApplicationServices.httpTransport → Tauri start_http / cancel_http
```

`RequestWorkbench` creates `effectiveDraft` with `applyWorkspaceRequestConfig` before resolving dynamic variables. Dependency requests are executed through the same `executeRequest` path. `prepareWireRequest` performs static interpolation for the final request and separately with masked variable values for the display request.

## URL and method

`RequestComposer` edits method and URL. `ColorizedUrlInput` presents template and path-parameter highlighting. The stored URL remains the user-authored template; it is not overwritten with resolved secret or environment values.

Before send, `normalizeRequestUrlProtocol` trims the value and supplies a scheme when none is present:

- localhost, `127.*`, and `0.*` use `http://`;
- other hosts use `https://`;
- explicit schemes and a URL beginning with a template token are left unchanged.

The normalized URL and current query/path rows are synchronized into the working draft before execution. `requireHttpUrl` validates the resolved URL as HTTP(S). Rust validates it again and rejects URL-embedded credentials.

The method is stored as an uppercase canonical string and sent unchanged, except GraphQL preparation always produces `POST`.

## Path parameters

Segments shaped as `/:name` are discovered by `getRequestPathParamsFromUrl`. They appear under **Path params** only when the URL contains such segments. Rows retain enabled state and values by parameter name as the URL changes, and enabled nonempty values replace their segments with `encodeURIComponent(value)` during preparation.

Path params are separate from query rows in `RequestDraft` and `RequestDefinition`, but both contribute to the Params tab count. The template URL and path rows remain canonical; substitution only affects the outgoing URL.

## Query parameters

The editable representation is an ordered array of `{id,key,value,enabled}` rows. Order, disabled rows, empty working row, and duplicate names are preserved in runtime. The canonical projection drops only the synthetic empty row and preserves duplicates and enabled state.

`getRequestQueryParamsFromUrl` keeps the table synchronized with the URL query. Editing the table rewrites the URL query through `URLSearchParams`; serialization therefore applies standard percent encoding and preserves repeated enabled pairs. URL variables that expand to a query string are re-read during `resolveRequestEnvironment`; generated rows are merged without replacing an existing same-name row.

An API-key auth scheme in query mode contributes one managed read-only effective row. `getRequestQueryParams` suppresses a same-name manual row in the effective view, while the stored manual row remains intact. Disabled rows are never sent.

## Headers

Manual headers use ordered `{id,name,value,enabled}` rows. Runtime and canonical forms preserve disabled rows and duplicates. Final wire headers are emitted as a tuple array so duplicate names survive IPC and native transport.

Effective headers are layered without mutating the stored request:

1. applicable workspace shared headers not shadowed by a request row;
2. request manual headers;
3. the active body mode’s managed `Content-Type`;
4. the active auth scheme’s managed `Authorization`, API-key, or `Cookie` binding.

Body-owned `Content-Type` and auth-owned names appear managed/read-only. The underlying manual rows are retained but excluded from the effective wire view while ownership applies. A request row with the same normalized name, even if disabled, is treated as an explicit shadow of a workspace header. Enabled rows are resolved and sent; disabled rows do not participate in interpolation or the wire request.

`applyWorkspaceRequestConfig` supports per-request opt-out for all shared headers and per-shared-header exclusion. Shared headers have scopes `all`, `http`, or `graphql`.

## Workspace shared authentication

Workspace auth entries also use `all`, `http`, or `graphql` scopes, and multiple profiles may target the same scope. Canonical `AuthDefinition.inherit.profileId` selects the exact profile for a request. For requests without a selection, an exact request-kind profile wins over the first applicable `all` profile. A new request defaults from `none` to `inherit` when an applicable enabled workspace auth exists.

Request auth behaves as follows:

- explicit request auth wins;
- `inherit` resolves through `AuthContext.workspaceProfiles` to the selected workspace profile;
- a request-level auth opt-out leaves inheritance unavailable;
- workspace configuration is applied to an effective copy, not written into the saved request.

Auth resolution occurs after dynamic-variable resolution and immediately before wire preparation. See [Authentication and cookies](auth.md) for scheme validation, OAuth, redaction, and cookie placement.

## Variables

Only active request fields are interpolated. `resolveRequestEnvironment` covers URL, query/path rows, headers, GraphQL query/variables/operation, active body fields, and active auth fields. Disabled rows and inactive body/auth modes cannot block a send. Binary bytes are opaque; file-field names, text values, and optional content types can be templated.

GraphQL variable JSON is traversed: a string containing only one template may become a JSON number, boolean, object, array, or null after substitution; templates embedded in larger strings remain strings. Nested static references are resolved recursively and cycles fail before network I/O.

Dynamic variables execute source requests only when referenced by the root request or by a referenced static variable. Their source request uses the same effective request pipeline. Full scope, caching, and cycle rules are in [Environments and variables](environments-and-variables.md).

## Body modes

`RequestBody` in `model/request-body.ts` stores all editor modes simultaneously and selects one with `type`.

| Mode | Runtime representation | Validation and wire serialization | Canonical representation |
| --- | --- | --- | --- |
| None | no active payload | no body or managed content type | `{type: none}` |
| JSON | text editor | strict JSON diagnostics; UTF-8 blob; `application/json` | string data |
| XML | text editor | XML parser diagnostics; UTF-8 blob; `application/xml` | string data |
| Text | text editor | UTF-8 blob; `text/plain` | string data |
| URL encoded | ordered enabled/disabled fields | `URLSearchParams`; duplicates preserved; standard form content type | field array |
| Form data | ordered text/file fields | manually assembled multipart bytes and boundary; field/file validation | fields plus asset refs |
| Binary | one live `File` | exact file bytes; file MIME or octet-stream | nullable asset ref |

Only the active mode is validated, interpolated, serialized, and saved canonically. Inactive modes and body conversion metadata are encrypted in `document_session_state` so switching back restores editor state. JSON/XML format and conversion helpers live in the same model; conversion can be refused when it would lose information.

Attachments are content-addressed with SHA-256 and written as `assets/<digest>.bin`. Canonical body fields contain asset identity, original name, and media type, never an absolute local path.

## Real and display requests

`prepareWireRequest` returns:

- `request`: resolved values suitable for transport;
- `displayRequest`: the same logical request prepared with sensitive variable/auth values masked;
- sensitive header/query name sets used by redirect and response-request display policy.

The redacted representation is the default in Request Code and Response → Request. Revealing is an explicit UI action. Do not log the real request or replace display usage with the transport object.

## Cookies and redirects

`executeHttp` merges the workspace cookie jar immediately before each native hop. Manually supplied cookie names win over jar cookies. It also captures every hop’s `Set-Cookie`, applies SameSite context, enforces a 10-hop limit, blocks HTTPS downgrade, strips credentials on cross-origin redirects, and applies browser-like method rewriting for 301/302/303.

Rust redirects are disabled so this policy remains in one TypeScript layer. See [Authentication and cookies](auth.md) for full jar ownership and matching rules.

## Frontend/native boundary

The IPC request is `WireRequest`: final URL, method, duplicate-preserving header tuples, and optional base64 body. The Rust `start_http` command:

- validates HTTP(S), host, method, headers, body encoding, and URL credentials;
- sends with Reqwest using a fixed timeout and redirects disabled;
- preserves duplicate response headers;
- streams at most the configured 128 MiB response capture into encrypted native chunks through a bounded worker queue, grouping up to 8 MiB per storage transaction while retaining 256 KiB encrypted chunks;
- emits coalesced header/progress events and returns an opaque content reference plus status, protocol, addresses, and transport timings;
- observes `cancel_http` before headers and throughout download/storage, releasing partial content on failure or cancellation.

The desktop completion IPC never contains the complete response body. Responses smaller than 1 MiB retain the compatibility viewer; responses at or above 1 MiB remain opaque handles and the UI reads only bounded pages.

Rust intentionally does not understand workspace inheritance, `RequestDraft`, template variables, auth schemes, logical body modes, cookies, or redirect credential policy.

## Paste cURL

Pasting a recognized `curl`/`curl.exe` command into the URL control is intercepted by `RequestComposer`. It updates the active HTTP document; when the active item is not HTTP or the workspace is empty, `WorkspaceWorkbench` creates a new HTTP draft. The original document is not auto-saved.

`model/curl-import.ts` uses a small shell tokenizer with single/double quote, backslash, and line-continuation handling. It is not a shell interpreter: variables, command substitution, files, and shell pipelines are not evaluated.

Implemented mapping:

- URL: positional URL or `--url`;
- method: `-X/--request`, `-I/--head`, `-G/--get`, or inferred GET/POST;
- headers: `-H/--header`, `-A/--user-agent`, `-e/--referer`;
- auth: `-u/--user`, `Authorization: Basic`, token-style Authorization, `--oauth2-bearer`, and a recognized API-key header/query name;
- cookies: inline `-b/--cookie` becomes a manual Cookie header; cookie-jar files are not read;
- body: `-d/--data`, `--data-raw`, `--data-binary`, and `--data-urlencode`; fragments join with `&`; content type selects JSON, URL-encoded, or text mode;
- `-m/--max-time`, `--connect-timeout`, and `--proxy` values are consumed but not represented.

Other options are currently ignored, often silently. File upload and `@file` semantics are not implemented. Imported auth credentials enter the auth model and are secured by normal projection. Sensitive headers that do not map to auth are immediately replaced with newly created sensitive workspace variables before persistence.

## Copy as cURL / wget / HTTP

`RequestCodeDialog` receives the workspace-effective draft and calls `prepareWireRequest`; it then applies current jar cookies. Generated output therefore includes resolved static templates, shared headers/auth, managed content type, and cookies. It does not run the dynamic dependency resolver, so a dynamic placeholder not already available in its context cannot be materialized there.

The default output uses `displayRequest`; secrets and cookie values are masked. The user must explicitly Reveal before Copy can place the real values on the clipboard. `formatRequestCode` supports POSIX-style cURL quoting, wget, and an HTTP/1.1 representation. Text bodies are included; a body whose bytes do not decode safely is represented by a non-executable `<binary body: N bytes>` placeholder.

## Failure and cancellation points

Validation, missing variables, dynamic dependency failures, malformed GraphQL, auth/OAuth errors, invalid URL/body/header, redirect policy, and native transport can all fail before an `HttpResult`. `RequestWorkbench` catches them and assigns the error to the originating document session.

Each send owns an execution counter. A later send or Escape cancellation invalidates the earlier completion so stale results cannot replace current state. Cancellation currently does **not** abort the Reqwest request; it only stops the UI from accepting its eventual result.

## Key files

- `src/features/request-workbench/model/request.ts` — draft rows, URL/query/path synchronization, counts, and effective header/query views.
- `src/features/request-workbench/model/request-body.ts` — body modes, validation, conversion, content type, and serialization.
- `src/features/request-workbench/model/request-auth.ts` — auth model, inheritance, managed bindings, and validation.
- `src/features/request-workbench/model/request-workspace-config.ts` — shared config scopes, precedence, and request opt-outs.
- `src/features/workspaces/model/environment.ts` — active-field static interpolation.
- `src/features/workspaces/services/dynamic-variable-resolver.ts` — dependency execution and caching.
- `src/features/request-workbench/services/execute-request.ts` — auth and final wire/display preparation.
- `src/features/request-workbench/services/http-client.ts` — cookie, redirect, and transport-response normalization through `HttpTransportPort`.
- `src/platform/tauri/application-services.ts` — native HTTP/OAuth/download command adapters.
- `src/features/request-workbench/request-workbench.tsx` — send ownership, sessions, cancellation, and UI orchestration.
- `src/features/request-workbench/model/curl-import.ts` — supported cURL parser/mapping.
- `src/features/request-workbench/model/request-code.ts` — cURL/wget/HTTP rendering.
- `src-tauri/src/http.rs` — native transport boundary.
