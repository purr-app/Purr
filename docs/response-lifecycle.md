# Response lifecycle

This document owns the path from native response bytes to frontend rendering, search, extraction, history, and error state.

## Pipeline

```text
Reqwest response in src-tauri/src/http/transport.rs
  → bounded background encryption/SQLite pipeline
  → encrypted staging chunks in response_contents become ready
  → metadata + ResponseContentRef over completion IPC
  → executeHttp() redirect/cookie loop
  → intermediate redirect handles released
  → <1 MiB: bounded reads into the inline compatibility view
  → ≥1 MiB: domain HttpExchange retained without body materialization
  → RequestWorkbench document session
  → CodeMirror small-body viewer or bounded large-body page viewer
  → v2 exchange projected to local storage and content adopted atomically
```

Desktop transport completion contains status, status text, duplicate-preserving headers, an opaque content reference, network duration, header/download timings, processing diagnostics, HTTP version, and optional local/remote socket addresses. It never contains a complete `bodyBase64`. `executeHttp` adds final URL and the frontend timeline. Responses smaller than 1 MiB are materialized through one bounded native read into the domain-owned `InlineHttpResponse` compatibility shape. Responses at or above 1 MiB remain `HttpExchange` values in the session and are never converted to full-body text or base64. Keeping the exact boundary bounded avoids a pathological CodeMirror layout when a 1 MiB textual body consists of one extremely long line. An inline response's `sourceExchange` is projected back to a body-free v2 exchange before persistence.

`src/domain/http.ts` defines the stable `HttpExchange` shape: a request snapshot, response metadata, opaque `ResponseContentRef`, and timeline. The descriptor carries `protocolVersion: 2`; its content ID never exposes a filesystem path or database key. New desktop HTTP responses use this ownership model. Legacy/browser test adapters can still return inline completion while the migration remains incremental.

The UTF-8 text decode is permissive. Binary-safe operations such as image/media display, hex/base64 rendering, and download use `bodyBase64`, not a text re-encoding.

## Native response boundary

`src-tauri/src/http/transport.rs` disables Reqwest redirects and streams up to 128 MiB through a bounded queue into encrypted response chunks. Encryption and SQLite jobs run on the response-content worker and overlap network reads; at most two 8 MiB write batches are in flight before bounded backpressure pauses the network task. The WebView thread never encrypts or writes response bytes. Completion still requires a readable `ready` reference so Purr cannot display a response that silently fails to become persistable; later workspace/history adoption is asynchronous and is not part of request completion. The transport holds no complete response body and emits coalesced header/progress/completion events. It preserves repeated response headers including `Set-Cookie` and sanitizes transport errors so the request URL/query is not echoed into an error string.

`src-tauri/src/content/` owns the encrypted response-content engine. It stores bounded chunks with a response-specific derived key and AAD bound to content ID, chunk index, byte offset, length, and crypto version. Content remains unreadable while `staging`, becomes readable when `ready`, and is adopted atomically when its execution record is persisted. Bounded inspect, byte-range, and line-page operations cross the `ResponseContentPort`. Cancellation or capture failure releases staging content before returning.

Rust does not choose a viewer, parse JSON, calculate cookie policy, normalize redirects, extract variables, or persist history. Those remain TypeScript/application responsibilities.

The transport accepts a resolved response-storage policy. The current product always sends `encrypted`; `plaintext` is reserved and fails closed until its store format, migration, cleanup, and UI are implemented. Future workspace/folder/document preferences are resolved in TypeScript before transport, so Rust receives one effective policy rather than workspace-tree knowledge. These preferences are local security settings and must not be loaded from shared project YAML. Credential and secret storage is always encrypted regardless of response policy.

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

`InlineHttpResponse.size` is computed from decoded response bytes. `url` is the final URL after redirects. Headers remain tuple arrays so duplicate fields survive.

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

Responses at or above 1 MiB use `LargeResponseViewer`. It holds one 192 KiB text/hex/base64 page, exposes first/previous/position/next/last navigation, and scans search text through temporary 4 MiB bounded text windows while retaining only match offsets/snippets. It does not create a CodeMirror document or a complete JavaScript string. Full-body copy is disabled with an explicit message. Native search/format/query and handle-based download remain assigned to Phases 8–9.

The current Phase 7 viewer selection still uses total byte size. A textual response just below 1 MiB can therefore enter CodeMirror and reproduce the same layout stall when almost the entire body is one logical line. Phase 8 replaces this heuristic with native maximum-line-length hints and a segmented `readLines` contract. Its React viewer will virtualize logical rows, keep only visible rows plus bounded overscan in the DOM, split a giant line into independently pageable segments, and disable soft wrapping and full-document syntax highlighting for large-response mode. The existing native `readLines` operation is not yet sufficient: it returns `string[]` and rejects a line longer than its configured byte window.

Inline JSON responses at or above 256 KiB keep the existing Pretty/query/context-action model but shorten individual string values over 16 KiB in the default CodeMirror preview. Raw and Copy still use the complete body. This avoids constructing a megabyte-wide CodeMirror line for fixtures and real responses with large scalar fields.

Large GraphQL bodies retain status, headers, request, cookie, and timeline tabs, but structured Data/Errors/Extensions extraction is unavailable at or above 1 MiB until the native bounded query work in Phase 8. Dynamic-variable source responses and GraphQL introspection fail with a clear size message instead of materializing an oversized body in the WebView.

## Rendering modes

Textual bodies support the modes applicable to their kind:

- JSON and XML can be pretty-formatted or shown raw;
- YAML, CSV, NDJSON, HTML, and text use textual code/raw presentation;
- any body can be represented as hex or base64 through response helpers where exposed by the viewer;
- images render from the original byte data URL;
- audio/video use native media controls backed by original bytes;
- HTML preview is sandboxed and receives a restrictive CSP and no-referrer policy;
- binary content receives a metadata/download presentation rather than unsafe text rendering.

`downloadResponseBody` preserves original bytes. Desktop inline responses use the Tauri save dialog/command in `src-tauri/src/commands/response.rs`; browser development uses `showSaveFilePicker` when available and otherwise an object-URL download. Saving a native content reference directly is deferred until Phase 9.

## Syntax highlighting

`ResponseCodeViewer` is the read-only code viewer for inline responses smaller than 1 MiB. It uses CodeMirror 6 with:

- `@codemirror/lang-json` for JSON;
- `@codemirror/lang-xml` for XML;
- local `StreamLanguage` tokenizers for YAML, CSV, and NDJSON;
- plain text for formats without a configured parser.

All response code themes come from `src/shared/theme/code-editor-theme.ts`; folding uses `src/shared/theme/code-fold-gutter.ts`. Adding a response language should extend detection, viewer language selection, tests, and this list together.

## Find in response

Cmd/Ctrl+F is intercepted only while Response, Headers, or Timeline is active. It opens a find control at the top-right with match count and previous/next navigation. Enter moves forward; Shift+Enter moves backward. Inline body matches use CodeMirror’s search state. Large-body matches are found by a temporary bounded TypeScript scanner over 4 MiB native text windows and navigation loads only the aligned 192 KiB page containing the selected match; Phase 8 moves that scan behind the native content port. Headers and Timeline use the viewer’s stable text-node highlighter. Search state is viewer-local and does not alter response content.

## jq and JSONPath extraction

The filter UI is available only when `parsedJson` exists. `queryResponseJson` in `model/response.ts` evaluates an intentionally limited, safe subset:

- jq-style paths starting with `.`, property/index access, wildcards, recursive `..key`, quoted keys, and pipe operations `length`, `keys`, or another path;
- JSONPath starting with `$`, property/index access, wildcards, recursive `..key`, and quoted bracket keys.

There is no external jq process and no complete jq or JSONPath grammar. Filters, expressions, predicates, arbitrary functions, mutations, and script evaluation are not supported. `getResponseQuerySuggestions` derives bounded suggestions from the response tree.

The result is rendered as formatted JSON or a scalar string. A JSON value context menu can copy its value/path or create a static or dynamic-request variable. Dynamic variables call this same evaluator after parsing the source response as JSON; see [Environments and variables](environments-and-variables.md).

## Timeline and redirect data

`HttpTimeline` records wall-clock start, preparation time, waiting/transport, download, total, redirects, and the prepared real/display request pair. The response summary reports network duration. Timeline exposes an easy-to-read diagnostic table for native setup, network, encryption, SQLite writes, bounded storage backpressure, Tauri IPC, bounded read/decrypt/decode, and response-ready time. Encryption and SQLite can overlap the network, so diagnostic rows are not summed as a sequential waterfall. These measurements are observational and must not become millisecond CI thresholds.

Sensitive header/query names travel beside the display request so redirect metadata and Request/Timeline surfaces can mask credentials. Cross-origin redirect behavior and cookie capture are detailed in [Request lifecycle](request-lifecycle.md) and [Authentication and cookies](auth.md).

## Execution history

On save, `projectWorkspace` emits the current `lastResponse` as a `request_executions` local record keyed by document and start time. `WorkspacePersistence` preserves older execution records instead of deleting them when the runtime projection contains only the latest result. Restoration validates both the unversioned v1 inline shape and the versioned v2 `HttpExchange` descriptor. An invalid execution is ignored instead of preventing its workspace from opening; valid descriptors are preserved on the next projection.

Rust stores:

- encrypted execution payload/metadata in `request_executions`;
- the large encrypted body in `response_bodies`;
- Phase 5 metadata and independently encrypted chunks in `response_contents` and `response_content_chunks` after a v2 execution adopts them;
- indexed plaintext columns for workspace, document, start time, and status to support lookup.

Startup `read` hydrates only the newest execution for each document. `list_request_history` exposes cursor-style metadata pagination by document and `before`, with a limit clamped to 1–100. There is currently no history-browser UI and no frontend flow for hydrating an arbitrary older response. This is backend/storage support, not a complete product feature.

## GraphQL response interpretation

A GraphQL request uses the same native content reference as REST and is materialized only by the current compatibility presentation. `ResponseViewer` parses a JSON object and conditionally separates top-level `errors` and `extensions`; `data` remains visible in the Response body. HTTP status and transport failure semantics are unchanged. Purr does not convert GraphQL application errors into native transport errors.

## Pending, errors, and cancellation

`RequestSession` in `request-workbench.tsx` owns `sending`, `response`, and `error` per document. Sending shows the pending state. Validation/dynamic/auth failures and sanitized native failures populate Error without creating a response. An ordinary non-2xx HTTP response remains a response.

Every send captures an execution counter and an `AbortController`. Escape aborts the active transport, invokes `cancel_http` for its opaque operation ID, returns the UI to idle, and prevents a completed history entry. Rust observes cancellation before headers and while reading or writing chunks; partial staging content is released. Late completion ownership still follows the originating document, so navigating to another document does not itself cancel an in-flight request.

## Safe display invariants

- Default Request and Timeline surfaces use `displayRequest`, never the real wire request.
- Cookie and request values require an explicit reveal action.
- Downloads and binary/media rendering use original bytes.
- Error strings must not contain sensitive URLs, query values, or headers.
- A late completion must update only the document/session that owns its execution counter.

## Key files

- `src/domain/http.ts` — stable HTTP exchange contracts, opaque response content reference, inline compatibility type, and tolerant v1/v2 restore validation.
- `src/features/request-workbench/services/http-client.ts` — native wire DTOs, redirect loop, byte decode, timeline construction, and inline compatibility adaptation.
- `src/features/request-workbench/model/response.ts` — content classification, formatting, cookie parsing, filenames, and query subset.
- `src/features/request-workbench/components/response-viewer.tsx` — tabs, viewers, response find, query UI, GraphQL sections, and reveal policy.
- `src/features/request-workbench/components/response-code-viewer.tsx` — CodeMirror languages, syntax theme, folding, and body search.
- `src/features/request-workbench/components/response-state-view.tsx` — empty/pending/error/response state switch.
- `src/features/request-workbench/services/download-response.ts` — browser/native download selection.
- `src/features/request-workbench/request-workbench.tsx` — per-document response/error ownership and stale-completion guard.
- `src/application/project-projection.ts` — latest-response local projection and hydration.
- `src-tauri/src/http/transport.rs` and `http/operations.rs` — streaming capture, progress, operation cancellation, headers, timings, and sanitized errors.
- `src-tauri/src/content/` — encrypted content lifecycle, bounded reads, and the dedicated storage worker.
- `src-tauri/src/persistence/local_records.rs` and `response_bodies.rs` — execution persistence, atomic content adoption, deletion, and history pagination.
- `src-tauri/src/commands/response.rs` — native response-content IPC and inline save boundary.
