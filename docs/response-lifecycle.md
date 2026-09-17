# Response lifecycle

The **Trace** tab calls a Rust-owned observability service using only stable workspace/integration/document references and the exact execution timestamp. Opening the tab starts a debounced lookup; it reads encrypted saved metadata, extracts correlation in Rust, resolves scoped integration credentials, and returns bounded normalized span rows plus correlation provenance. Pages enrich one hierarchy with selection and a separate inspector. Trace lookup does not delay HTTP response rendering. The native Jaeger adapter is included by default; see [tracing and observability](imports-and-integrations.md#tracing-and-observability).

This document owns the path from native response bytes to frontend rendering, search, extraction, history, and error state.

## Pipeline

```text
Reqwest response in src-tauri/src/http/transport.rs
  → bounded background encryption/SQLite pipeline
  → encrypted staging chunks in response_contents become ready
  → metadata + ResponseContentRef over completion IPC
  → executeHttp() redirect/cookie loop
  → intermediate redirect handles released
  → <1 MiB with no pathological line: bounded read into the inline compatibility view
  → ≥1 MiB or max line ≥64 KiB: HttpExchange retained without body materialization
  → RequestWorkbench document session
  → CodeMirror small-body viewer or bounded large-body page viewer
  → v2 exchange projected to local storage and content adopted atomically
```

Desktop transport completion contains status, status text, duplicate-preserving headers, an opaque content reference, network duration, header/download timings, processing diagnostics, HTTP version, optional local/remote socket addresses, and presentation hints (`lineCount` and `maxLineBytes`). It never contains a complete `bodyBase64`. `executeHttp` adds final URL and the frontend timeline. Responses smaller than 1 MiB are materialized only when their longest observed line is also below 64 KiB. Responses at or above either threshold remain `HttpExchange` values and are never converted to full-body text or base64. An inline response's `sourceExchange` is projected back to a body-free v2 exchange before persistence. Old content references remain readable without a schema migration: explicit native `inspect` computes missing line statistics in bounded windows.

`src/domain/http.ts` defines the stable `HttpExchange` shape: a request snapshot, response metadata, opaque `ResponseContentRef`, and timeline. The descriptor carries `protocolVersion: 2`; its content ID never exposes a filesystem path or database key. New desktop HTTP responses use this ownership model. Legacy/browser test adapters can still return inline completion while the migration remains incremental.

The UTF-8 text decode is permissive. Inline compatibility responses retain original byte-derived base64 for binary-safe modes. Opaque native responses never reconstruct a full `bodyBase64`: bounded hex/base64 windows use native reads, downloads stream decrypted chunks directly to the selected file, and image/audio/video previews use the `purr-content` handle protocol.

## Native response boundary

`src-tauri/src/http/transport.rs` disables Reqwest redirects and streams up to 128 MiB through a bounded queue into encrypted response chunks. Encryption and SQLite jobs run on the response-content worker and overlap network reads; at most two 8 MiB write batches are in flight before bounded backpressure pauses the network task. The WebView thread never encrypts or writes response bytes. Completion still requires a readable `ready` reference so Purr cannot display a response that silently fails to become persistable; later workspace/history adoption is asynchronous and is not part of request completion. The transport holds no complete response body and emits coalesced header/progress/completion events. It preserves repeated response headers including `Set-Cookie` and sanitizes transport errors so the request URL/query is not echoed into an error string.

`src-tauri/src/content/` owns the encrypted response-content engine. It stores bounded chunks with a response-specific derived key and AAD bound to content ID, chunk index, byte offset, length, and crypto version. Content remains unreadable while `staging`, becomes readable when `ready`, and is adopted atomically when its execution record is persisted. Bounded inspect, byte-range, segmented-line, literal/regex search, format, and query operations cross the `ResponseContentPort`. Search/format/query receive opaque operation IDs so an aborted frontend request can cancel native work without exposing a process or path. Cancellation or capture failure releases staging content before returning.

Rust does not choose a viewer, calculate cookie policy, normalize redirects, or own history policy. It does own bounded JSON/XML/NDJSON presentation parsing and the native jq/JSONPath adapters for opaque content. TypeScript still classifies media, selects the viewer, and defines when an extracted value is used by the application.

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
- **Trace**: provider-neutral hierarchy/details from a Rust-owned lookup, ancestor-preserving attribute search and incremental loading. The provider comes from request settings; correlation provenance explains differing sent/lookup/resolved IDs. Context changes cancel silently; explicit user cancellation is shown separately.
- **Request**: the prepared display request by default, with explicit secret reveal.

The parent response state also presents status, protocol, addresses, total duration, and byte size. HTTP errors still have a normal response viewer; transport/preparation errors use the Error state.

Responses at or above 1 MiB, and smaller native responses with a line at or above 64 KiB, use the native-backed read-only viewer with the same code typography and toolbar as inline responses. JSON up to 10 MiB opens in native Pretty automatically; this is a presentation policy, not an increased full-body IPC/CodeMirror threshold. The frontend receives logical-line previews through `readLines` with a `preview:<byte offset>` cursor. A long line retains at most 96 prefix bytes and 32 suffix bytes (UTF-8 cuts adjusted), its original byte extent, and `hiddenBytes`; the hidden-byte action explains the beta restriction rather than allocating the full line. The native reader scans past the hidden middle so subsequent JSON fields remain visible. Ordinary byte cursors retain the bounded 16 KiB segment API for other consumers.

Preview pages contain at most 1,000 rows and 192 KiB of visible text; native reads remain bounded even when skipping a giant logical line. Scrolling appends pages, retaining at most 3,000 preview rows plus visible DOM/overscan through `@tanstack/react-virtual`. After older rows leave this buffer, a Return to beginning action is available; native Find can jump directly to any matching byte. A Load more fallback supports keyboard users and responses that do not fill the viewport. There is no fixed page/slider toolbar. Native JSON Pretty highlights only bounded visible row text with the existing Lezer parser and Purr syntax tokens. Soft wrapping stays off; shortened lines are explicitly marked. Hex/base64 remain bounded range views. Full-body copy stays unavailable for opaque large content; Download writes the original handle directly through Rust.

Literal and bounded regex search run in Rust over 4 MiB windows, retain only offsets/snippets in JavaScript, and can be cancelled. Unbounded regexes and matches above 64 KiB are rejected. Pretty formatting runs through `serde_json`/`serde-transcode`, `quick-xml`, or line-wise NDJSON handling. jq and JSONPath use native adapters and preserve Purr's documented subset. Results up to 256 KiB cross IPC as a value/window; larger results become temporary encrypted content references and use the same bounded viewer. JSON/NDJSON path queries above the 32 MiB full-tree tier use a validated byte-scan path, while recursive selectors and jq pipe operations that require the complete tree fail with a clear bounded-operation error.

Inline JSON responses at or above 256 KiB keep the existing Pretty/query/context-action model but shorten individual string values over 16 KiB in the default CodeMirror preview. Raw and Copy still use the complete body. This avoids constructing a megabyte-wide CodeMirror line for fixtures and real responses with large scalar fields.

Large GraphQL bodies retain status, headers, request, cookie, and timeline tabs and expose bounded Data/Errors/Extensions extraction through the same native query operation. Dynamic-variable source responses also use native query and release their temporary source handle after extraction. GraphQL introspection still fails with a clear size message when its result cannot use the inline compatibility path; moving schema construction/analysis out of the WebView belongs to Phase 10.

## Rendering modes

Textual bodies support the modes applicable to their kind:

- JSON and XML can be pretty-formatted or shown raw;
- YAML, CSV, NDJSON, HTML, and text use textual code/raw presentation;
- any body can be represented as hex or base64 through response helpers where exposed by the viewer;
- inline images render from an original-byte data URL; referenced images load from the native handle protocol;
- inline audio/video use original-byte data URLs; referenced audio/video use native controls and range requests against the handle protocol;
- HTML preview is sandboxed and receives a restrictive CSP and no-referrer policy;
- binary content receives a metadata/download presentation rather than unsafe text rendering.

`downloadResponseBody` preserves original bytes. Desktop inline compatibility responses still use the base64 Tauri save command; browser development uses `showSaveFilePicker` when available and otherwise an object-URL download. A native `ResponseContentRef` uses `response_content_save`: Rust decrypts bounded chunks on the content worker, writes a temporary file beside the selected destination, syncs it, and atomically persists it without returning body bytes to JavaScript.

Referenced image/audio/video content is exposed only through the `purr-content` custom protocol. The URL contains an opaque content ID, never a filesystem path. The protocol accepts `GET`/`HEAD`, verifies a ready registered handle and an `image/*`, `audio/*`, or `video/*` media type, supports one closed/open/suffix byte range, and returns `Accept-Ranges`, `Content-Range`, `no-store`, and `nosniff` headers. Invalid IDs, non-media content, methods, and ranges fail without exposing storage details. Audio/video controls therefore seek through bounded range reads; media bytes do not cross command JSON or become a full JavaScript string.

## Syntax highlighting

`ResponseCodeViewer` is the read-only code viewer for inline responses smaller than 1 MiB. It uses CodeMirror 6 with:

- `@codemirror/lang-json` for JSON;
- `@codemirror/lang-xml` for XML;
- local `StreamLanguage` tokenizers for YAML, CSV, and NDJSON;
- plain text for formats without a configured parser.

All response code themes come from `src/shared/theme/code-editor-theme.ts`; folding uses `src/shared/theme/code-fold-gutter.ts`. Adding a response language should extend detection, viewer language selection, tests, and this list together.

## Find in response

Cmd/Ctrl+F is intercepted while Response, Headers, Timeline, or Trace is active. In Trace it focuses the span/attribute search in the trace header. It opens a find control at the top-right with match count and previous/next navigation. Enter moves forward; Shift+Enter moves backward. Inline body matches use CodeMirror’s search state. Large-body matches are found by native literal or regex search over bounded 4 MiB windows, and navigation requests only the preview around the selected byte offset. The `.*` toggle lives in Find, has an explicit pressed state, and sends `regularExpression` to Rust; native byte offset/length are used for regex highlighting without evaluating a JavaScript regex on the body. Closing find aborts the opaque native operation. Headers and Timeline use the viewer’s stable text-node highlighter. Search state is viewer-local and does not alter response content.

## jq and JSONPath extraction

Inline response filtering uses `queryResponseJson` in `model/response.ts`; referenced JSON/NDJSON filtering uses `ResponseContentPort.query`. Both expose the same intentionally limited subset:

- jq-style paths starting with `.`, property/index access, wildcards, recursive `..key`, quoted keys, and pipe operations `length`, `keys`, or another path;
- JSONPath starting with `$`, property/index access, wildcards, recursive `..key`, and quoted bracket keys.

There is no external jq process and Purr does not claim complete jq or JSONPath compatibility. Rust embeds `jaq` and `serde_json_path` behind an allow-list adapter; large structural JSONPath scans use `jsonpath-rfc9535` only after a streaming validation pass and never for authorization or redaction. Filters, expressions, predicates, arbitrary functions, mutations, and script evaluation are not part of the public subset. `getResponseQuerySuggestions` derives bounded suggestions only for inline response trees.

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
- `src/features/request-workbench/components/native-response-content.tsx` — referenced media, binary metadata, and direct native-handle save actions.
- `src/features/request-workbench/services/download-response.ts` — browser/native download selection.
- `src/features/request-workbench/request-workbench.tsx` — per-document response/error ownership and stale-completion guard.
- `src/application/project-projection.ts` — latest-response local projection and hydration.
- `src-tauri/src/http/transport.rs` and `http/operations.rs` — streaming capture, progress, operation cancellation, headers, timings, and sanitized errors.
- `src-tauri/src/content/` — encrypted content lifecycle, bounded reads, and the dedicated storage worker.
- `src-tauri/src/content/protocol.rs` — allowlisted media handle protocol and byte-range validation.
- `src-tauri/src/persistence/local_records.rs` and `response_bodies.rs` — execution persistence, atomic content adoption, deletion, and history pagination.
- `src-tauri/src/commands/response.rs` — native response-content IPC and inline save boundary.


Trace spans use a virtualized waterfall with native timing bounds and automatic
cursor loading near the viewport. The inspector is absent until a span is selected.
The Trace tab is hidden when the workspace has no integration with tracing capability;
when tracing is disabled for a request it explains how to enable it. Open-tab state
retains response view, trace search, loaded pages, collapsed spans and selection until
the document tab closes. Background tab unmounts cancel pending lookups.
