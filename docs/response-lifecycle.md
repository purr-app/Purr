# Response lifecycle

This document owns the path from native response bytes to frontend rendering, search, extraction, history, and error state.

## Pipeline

```text
Reqwest response in src-tauri/src/http.rs
  → WireResponse over Tauri IPC
  → executeHttp() redirect/cookie loop
  → base64 bytes decoded to Uint8Array + UTF-8 text
  → HttpResult with final URL, byte size, and HttpTimeline
  → RequestWorkbench document session
  → ResponseViewer classification and presentation
  → latest execution projected to encrypted local storage
```

`WireResponse` contains status, status text, duplicate-preserving headers, base64 body bytes, transport duration, header/download timings, HTTP version, and optional local/remote socket addresses. `executeHttp` adds final URL, decoded `text`, actual byte size, and the frontend timeline. Redirects are resolved in TypeScript, so the final `HttpResult` describes the last hop while timeline redirect entries retain hop metadata.

The UTF-8 text decode is permissive. Binary-safe operations such as image/media display, hex/base64 rendering, and download use `bodyBase64`, not a text re-encoding.

## Native response boundary

`src-tauri/src/http.rs` disables Reqwest redirects and streams up to 20 MiB into the response preview. It preserves repeated response headers including `Set-Cookie`, measures header/download/total transport time, and sanitizes transport errors so the request URL/query is not echoed into an error string.

Rust does not choose a viewer, parse JSON, calculate cookie policy, normalize redirects, extract variables, or persist history. Those remain TypeScript/application responsibilities.

## Classification and normalization

`inspectResponseBody` and related helpers in `model/response.ts` classify response bodies as:

- JSON or NDJSON/JSON Lines;
- YAML;
- CSV;
- XML;
- HTML;
- plain text;
- image, audio, or video;
- generic binary.

Content-Type is authoritative when present. Safe sniffing is intentionally narrower when it is absent: valid JSON, obvious HTML, XML-like text, then ordinary text without NUL/replacement characters; otherwise binary. YAML, CSV, and NDJSON generally require a matching content type. Invalid text under a declared JSON content type remains a JSON-classified response but has no `parsedJson` value for query tools.

`HttpResult.size` is computed from decoded response bytes. `url` is the final URL after redirects. Headers remain tuple arrays so duplicate fields survive.

## Response viewer

`components/response-viewer.tsx` owns the response tabs and their policy:

- **Response**: body renderer, format controls, query filter, context actions, and downloads.
- **Errors**: GraphQL response `errors`, shown only when present.
- **Extensions**: GraphQL response `extensions`, shown only when present.
- **Headers**: repeated response header rows.
- **Cookie**: cookies parsed from response `Set-Cookie`; values are masked until reveal.
- **Timeline**: preparation/connection-and-waiting/download segments, redirects, protocol, addresses, and safe request metadata.
- **Trace**: visible but disabled; there is no trace model or provider lookup yet.
- **Request**: the prepared display request by default, with explicit secret reveal.

The parent response state also presents status, protocol, addresses, total duration, and byte size. HTTP errors still have a normal response viewer; transport/preparation errors use the Error state.

## Rendering modes

Textual bodies support the modes applicable to their kind:

- JSON and XML can be pretty-formatted or shown raw;
- YAML, CSV, NDJSON, HTML, and text use textual code/raw presentation;
- any body can be represented as hex or base64 through response helpers where exposed by the viewer;
- images render from the original byte data URL;
- audio/video use native media controls backed by original bytes;
- HTML preview is sandboxed and receives a restrictive CSP and no-referrer policy;
- binary content receives a metadata/download presentation rather than unsafe text rendering.

`downloadResponseBody` preserves original bytes. Desktop uses the Tauri save dialog/command in `src-tauri/src/downloads.rs`; browser development uses `showSaveFilePicker` when available and otherwise an object-URL download.

## Syntax highlighting

`ResponseCodeViewer` is the single read-only code viewer. It uses CodeMirror 6 with:

- `@codemirror/lang-json` for JSON;
- `@codemirror/lang-xml` for XML;
- local `StreamLanguage` tokenizers for YAML, CSV, and NDJSON;
- plain text for formats without a configured parser.

All response code themes come from `src/shared/theme/code-editor-theme.ts`; folding uses `src/shared/theme/code-fold-gutter.ts`. Adding a response language should extend detection, viewer language selection, tests, and this list together.

## Find in response

Cmd/Ctrl+F is intercepted only while Response, Headers, or Timeline is active. It opens a find control at the top-right with match count and previous/next navigation. Enter moves forward; Shift+Enter moves backward. Body matches use CodeMirror’s search state; Headers and Timeline use the viewer’s stable text-node highlighter. Search state is viewer-local and does not alter response content.

## jq and JSONPath extraction

The filter UI is available only when `parsedJson` exists. `queryResponseJson` in `model/response.ts` evaluates an intentionally limited, safe subset:

- jq-style paths starting with `.`, property/index access, wildcards, recursive `..key`, quoted keys, and pipe operations `length`, `keys`, or another path;
- JSONPath starting with `$`, property/index access, wildcards, recursive `..key`, and quoted bracket keys.

There is no external jq process and no complete jq or JSONPath grammar. Filters, expressions, predicates, arbitrary functions, mutations, and script evaluation are not supported. `getResponseQuerySuggestions` derives bounded suggestions from the response tree.

The result is rendered as formatted JSON or a scalar string. A JSON value context menu can copy its value/path or create a static or dynamic-request variable. Dynamic variables call this same evaluator after parsing the source response as JSON; see [Environments and variables](environments-and-variables.md).

## Timeline and redirect data

`HttpTimeline` records wall-clock start, preparation time, waiting/transport, download, total, redirects, and the prepared real/display request pair. Transport timings come from Rust; frontend preparation and multi-hop total are added in `executeHttp`.

Sensitive header/query names travel beside the display request so redirect metadata and Request/Timeline surfaces can mask credentials. Cross-origin redirect behavior and cookie capture are detailed in [Request lifecycle](request-lifecycle.md) and [Authentication and cookies](auth.md).

## Execution history

On save, `projectWorkspace` emits the current `lastResponse` as a `request_executions` local record keyed by document and start time. `WorkspacePersistence` preserves older execution records instead of deleting them when the runtime projection contains only the latest result.

Rust stores:

- encrypted execution payload/metadata in `request_executions`;
- the large encrypted body in `response_bodies`;
- indexed plaintext columns for workspace, document, start time, and status to support lookup.

Startup `read` hydrates only the newest execution for each document. `list_request_history` exposes cursor-style metadata pagination by document and `before`, with a limit clamped to 1–100. There is currently no history-browser UI and no frontend flow for hydrating an arbitrary older response. This is backend/storage support, not a complete product feature.

## GraphQL response interpretation

A GraphQL request still produces an ordinary `HttpResult`. `ResponseViewer` parses a JSON object and conditionally separates top-level `errors` and `extensions`; `data` remains visible in the Response body. HTTP status and transport failure semantics are unchanged. Purr does not convert GraphQL application errors into native transport errors.

## Pending, errors, and cancellation

`RequestSession` in `request-workbench.tsx` owns `sending`, `response`, and `error` per document. Sending shows the pending state. Validation/dynamic/auth failures and sanitized native failures populate Error without creating a response. An ordinary non-2xx HTTP response remains a response.

Every send captures an execution counter. A newer send or Escape increments it; completion from the older counter is discarded. Component unmount similarly prevents stale ownership. This is UI cancellation only: no abort signal crosses IPC, and the underlying native request can continue until it completes or hits the fixed timeout.

## Safe display invariants

- Default Request and Timeline surfaces use `displayRequest`, never the real wire request.
- Cookie and request values require an explicit reveal action.
- Downloads and binary/media rendering use original bytes.
- Error strings must not contain sensitive URLs, query values, or headers.
- A late completion must update only the document/session that owns its execution counter.

## Key files

- `src/features/request-workbench/services/http-client.ts` — response DTOs, redirect loop, byte decode, timeline, and final `HttpResult`.
- `src/features/request-workbench/model/response.ts` — content classification, formatting, cookie parsing, filenames, and query subset.
- `src/features/request-workbench/components/response-viewer.tsx` — tabs, viewers, response find, query UI, GraphQL sections, and reveal policy.
- `src/features/request-workbench/components/response-code-viewer.tsx` — CodeMirror languages, syntax theme, folding, and body search.
- `src/features/request-workbench/components/response-state-view.tsx` — empty/pending/error/response state switch.
- `src/features/request-workbench/services/download-response.ts` — browser/native download selection.
- `src/features/request-workbench/request-workbench.tsx` — per-document response/error ownership and stale-completion guard.
- `src/application/project-projection.ts` — latest-response local projection and hydration.
- `src-tauri/src/http.rs` — native response bytes, headers, timings, and errors.
- `src-tauri/src/local_state.rs` — execution persistence and history pagination.
- `src-tauri/src/downloads.rs` — native save boundary.
