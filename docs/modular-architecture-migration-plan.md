# Purr: migration plan for a public core, private extensions, and a modular native engine

Status: canonical architecture plan, execution tracker, and product-owner checklist; no refactoring is implemented by this document.
Code baseline reviewed: `f841397` (`main`) on 2026-09-14.

This plan is based on the current TypeScript and Rust code, tests, persistence format, and documented request/response lifecycle. It deliberately keeps Purr as one application and one Rust crate for now. The main decisions are:

1. `purr` remains a complete public application and also exposes a narrow build-time extension API.
2. `purr-commercial` contains only commercial modules and the official composition shell. It never copies the application source.
3. Frontend composition uses explicit contracts, registries, and an application composition root. Build-time modules may contribute providers, namespaced pages/navigation, module-owned application logic, and extension document/protocol types through named contracts. It does not use a DI framework, arbitrary UI injection, or a runtime plugin marketplace.
4. Rust becomes the bounded engine for native transport, encrypted content storage, large response decoding/search/format/query, large request-body streaming, imports, filesystem work, OAuth callbacks, and secure storage.
5. TypeScript keeps interactive request composition, canonical project schemas, UI state, GraphQL editor intelligence, and application policy. Moving those wholesale to Rust would create a second application model and a second request-building path.
6. Large response support is built around an opaque native content reference. Merely moving `JSON.parse` to Rust while still returning the complete formatted result to React would not solve the memory problem.
7. A second repository is the intended result, but creating it before the extension contract and one public vertical slice are proven would be premature. The split happens near the end of the migration, after Jaeger validates the boundary.

## Migration progress

This tracker reflects the repository state reviewed on 2026-09-16. `PARTIALLY DONE` identifies an existing precursor only; it does not mean the phase acceptance criteria or its verification checklist are complete. No phase is `DONE` until its scope, automated checks, manual checks, and completion protocol are all recorded.

| Phase | Name | Status | Implemented in | Automated verification | Manual verification |
| --- | --- | --- | --- | --- | --- |
| 0 | Freeze measurements and compatibility fixtures | DONE | `10bf837` (tooling on `main`) and `c4c8c8d` | PASS — unit/UI/Rust suites, typecheck, lint, build, fmt, clippy, benchmark, fixture smoke | COMPLETE — safe response/GraphQL/RSS scenarios and current failure modes recorded |
| 1 | Stabilize repository and dependency rules | DONE | `ce48ae1` | PASS — clean npm install, repository policy, unit/UI/type/lint/build, Rust checks, Tauri dev/app build | COMPLETE — OSS launch, REST/GraphQL, restart, persistence, and secret/YAML behavior passed |
| 2 | Split stable HTTP exchange contracts | DONE | Phase 2 working tree based on `ce48ae1` | PASS — 123 unit/integration, 51 UI, 38 Rust tests; typecheck, lint, build, fmt, clippy, repository policy | COMPLETE — legacy response restore, REST viewers/restart, and GraphQL response tabs passed |
| 3 | Add frontend ports and OSS composition root | DONE | Phase 3 working tree based on `27cc0a8` | PASS — 127 unit/integration, 51 UI, 38 Rust tests; typecheck, lint, build, repository policy, fmt, clippy | COMPLETE — product-owner acceptance after browser persistence, desktop responses/cookies, OpenAPI import/base URL, health request, and OAuth opener verification |
| 4 | Mechanically modularize the Rust crate | DONE | Phase 4 working tree based on `f5f8362` | PASS — 129 TypeScript tests, 51 UI tests, 38 Rust tests; typecheck, lint, build, repository policy, fmt, clippy | COMPLETE — product-owner desktop smoke verification on 2026-09-15 |
| 5 | Implement encrypted native response content storage | DONE | Phase 5 working tree based on `c430458` | PASS — 129 TypeScript tests, 51 UI tests, 46 Rust tests; typecheck, lint, build, repository policy, fmt, clippy | COMPLETE — product-owner compatibility and persistence verification on 2026-09-15 |
| 6 | Switch native HTTP to response handles and real cancellation | DONE | Phase 6 working tree based on `b9724b0` | PASS — 132 TypeScript tests, 51 UI tests, 51 Rust tests; typecheck, lint, build, repository policy, fmt, clippy | COMPLETE — product-owner accepted all desktop streaming/cancel, redirects/cookies/binary, GraphQL/OAuth, restart, and content-reference scenarios on 2026-09-15 |
| 7 | Add bounded/virtualized response presentation | DONE | Phase 7 working tree based on `7e3492c` | PASS — 137 TypeScript tests, 54 UI tests, 54 Rust tests; typecheck, lint, build, repository policy, fmt, clippy, diff check | COMPLETE — product-owner accepted bounded navigation/search/restart and exact 1 MiB behavior on 2026-09-16; sub-threshold pathological lines explicitly deferred to Phase 8 |
| 8 | Move large response inspect/search/format/query to Rust | DONE | Phase 8 working tree based on `f58cbad` | PASS — 138 TypeScript tests, 58 UI tests, 65 Rust tests; typecheck, lint, build, repository policy, fmt, check, clippy, diff check | COMPLETE — product owner accepted the functional and UX-correction scenarios on 2026-09-16 |
| 9 | Remove remaining body round trips | PARTIALLY DONE | Existing base64 download/media/binary request paths; no handle-based phase reference | Existing request/response tests only | Not recorded |
| 10 | Profile and isolate GraphQL analysis | PARTIALLY DONE | Existing GraphQL parse/schema/editor flow; no profiling or worker phase reference | Existing GraphQL tests only | Not recorded |
| 11 | Migrate canonical integration envelope | PARTIALLY DONE | Existing `{provider, endpoint, credentials}` canonical shape; no envelope migration reference | Existing project validation only | Not recorded |
| 12 | Implement extension API and immutable registries | PARTIALLY DONE | Existing native import-adapter registry is a precursor only; no extension API reference | Import tests only; extension conformance not run | Not recorded |
| 13 | Add provider-neutral observability use case and UI | TODO | — | Not run | Not run |
| 14 | Implement Jaeger public validation adapter | TODO | — | Not run | Not run |
| 15 | Expose reusable frontend and Rust composition surfaces | PARTIALLY DONE | Existing `purr_lib` library target; no public builder/package export reference | Existing Rust build/tests only | Not recorded |
| 16 | Create `purr-commercial` and official build composition | TODO | — | Not run | Not run |

## Phase completion protocol

After completing every phase, the implementation agent must:

1. Update the phase `Status` and the summary table.
2. Record the commit hash, PR URL/number, or precise working-tree reference in `Implemented in`.
3. Mark only automated checks that were actually run; leave every unrun check unchecked.
4. Record the date in `Started` and `Completed`.
5. Record deviations from this plan and explain why they were necessary.
6. Record known follow-ups, including work deliberately deferred to a later phase.
7. Give the product owner a separate final block titled `## What you must verify manually` containing only the concrete manual checks for that phase, including required fixture/data setup.

### Failure rules

- A failing or unrun required automated check prevents `DONE`. Use `PARTIALLY DONE` when the implemented portion is usable and documented; use `BLOCKED` when a repeated unresolved condition prevents meaningful progress. Record the exact command/check and failure reason in `Implementation notes`.
- Do not silently rewrite the architecture when implementation differs. Record the difference in `Deviations from plan`, why it was necessary, and the smallest dependency/note update needed for later phases.
- `DONE` requires implemented scope, relevant tests, build/typecheck/lint/Rust checks, phase acceptance criteria, no known blocking regression, and a completed manual-verification record. Passing code review or inspecting code is not sufficient.

## A. Current architecture assessment

### A.1 Current dependency and data-flow picture

The current product already has useful boundaries, but the top half of the application is connected through feature-owned runtime types rather than stable application contracts.

```text
src/App.tsx
  -> src/app/app-router.tsx
  -> WorkspaceWorkbench
       -> mutable runtime Workspace aggregate
       -> RequestWorkbench / GraphQL components / workspace UI
       -> projectWorkspace() / restoreWorkspace()
       -> WorkspacePersistence
            -> PersistenceBackend / SecureStore
            -> Native Tauri adapter or browser adapter

request editor
  -> executeRequest()
  -> environment + variable resolution
  -> GraphQL envelope + auth + logical body serialization
  -> WireRequest { bodyBase64 }
  -> executeHttp(): redirect and cookie policy
  -> invoke("send_http")
  -> Rust reqwest transport
  -> WireResponse { bodyBase64 }
  -> Uint8Array + decoded string + HttpResult
  -> ResponseViewer / response history persistence
```

There are no file-level import cycles in the current graph, but directory ownership is not one-way:

- `src/application/` imports feature-owned `Workspace` and request types;
- `src/storage/` imports canonical types and is instantiated close to the UI rather than behind one composition root;
- `features/workspaces` and `features/request-workbench` import each other;
- `features/graphql` and `features/request-workbench` import each other;
- Tauri `invoke`, `isTauri`, dialog, and event details appear in HTTP, OAuth, download, import, workspace, and storage code;
- `Workspace` contains editor state, cookies, schema cache, `HttpResult`, and view types, so it is a useful runtime aggregate but an unsafe public SDK type.

The main issue is therefore not the current directory names. It is that stable domain/application seams are missing between the feature graph, native IPC, and future provider modules.

### A.2 Boundaries that are already good

- `src/domain/project.ts` is a real canonical boundary. It describes portable, Git-friendly data and has no React, Tauri, SQLite, filesystem, or YAML dependency.
- `projectWorkspace()` and `restoreWorkspace()` correctly distinguish canonical project files, encrypted local state, project assets, and `SecretRef` values.
- `WorkspacePersistence` provides one persistence route with revision checks and native journaling.
- `prepareWireRequest()` and `executeRequest()` provide one request-composition route. This should be preserved while its dependencies become explicit.
- The native HTTP transport rejects unsafe URL schemes and embedded credentials, disables automatic redirects, sanitizes transport errors, and preserves repeated response headers.
- Native project-file access rejects traversal and symlink escapes and uses revision-checked atomic writes.
- Secure storage already has strong layering: one Keychain root key, HKDF-separated database/secret keys, AES-GCM with context/AAD, an encrypted SQLite secret vault, and fail-closed recovery.
- OpenAPI import already runs in Rust and returns a normalized result rather than leaking the foreign AST into React. That is a good example of a CPU/I/O-heavy native adapter boundary.
- The browser backend is explicitly a development/test substitute, not a promise that browser mode has desktop transport or security semantics.

These parts should be adapted, not rewritten.

### A.3 Current coupling and risk points

| Area | Current coupling | Consequence |
| --- | --- | --- |
| Runtime workspace | `Workspace` owns canonical-like data, drafts, UI layout, cookies, caches, responses, and view types | It cannot be exposed as the extension API and makes application services depend on feature internals |
| Application shell | `WorkspaceWorkbench` performs feature composition and much orchestration | There is no place for public and private modules to register contributions at build time |
| Native boundary | Direct Tauri calls are spread through features/services | Tests and alternate composition must mock command details rather than ports |
| HTTP DTO | `WireRequest`/`WireResponse` in TS duplicate serde structs in Rust | Drift is discovered late; `invoke<T>` does not validate runtime payloads |
| Local state | Generic `LocalRecord.value: unknown` crosses IPC, while Rust indexes nested TS response fields | Rust is coupled to an undocumented frontend runtime shape |
| Integrations | Canonical `{provider, endpoint, credentials}` exists, but no runtime contract or registry exists | A first provider could easily become hardcoded in UI and persistence |
| Observability | Trace is only a disabled tab and reserved discriminant | `Trace`, `Span`, and `Log` have no vendor-neutral domain yet |
| Response UI | One 1,270-line component owns detection, GraphQL shaping, query controls, preview, headers, cookies, timeline, and trace placeholder | Adding streaming or a provider risks editing a central high-conflict file |
| Rust layout | Large `importing.rs`, `local_state.rs`, and `persistence.rs` combine contracts, orchestration, infrastructure, migrations, and commands | Future response and integration work would grow the flat crate into another monolith |

### A.4 Actual response memory path

The existing desktop path performs several full-body allocations:

```text
reqwest chunks
  -> Rust Vec<u8> (up to the current 20 MiB preview limit)
  -> Rust base64 String
  -> JSON serialization across Tauri IPC
  -> JavaScript base64 String
  -> atob intermediate characters
  -> Uint8Array
  -> TextDecoder String
  -> HttpResult retains both bodyBase64 and text
  -> JSON.parse object graph, when applicable
  -> JSON.stringify pretty String / hex String / base64 view
  -> CodeMirror document and syntax structures
```

Media preview creates another base64 data URL. Download sends base64 back to Rust, decodes it again, then writes the file. Response persistence serializes `{text, bodyBase64}`, encrypts the complete JSON blob, and reconstructs both values on load. Cancellation in the UI currently ignores a late completion but does not abort reqwest.

This is the highest-value Rust migration. The correct abstraction is a native `ResponseContentStore` with opaque content IDs, encrypted chunks, bounded views, native operations, and direct save. Streaming every response chunk into React would still grow WebView memory and generate IPC pressure, so the UI should receive progress plus requested windows/pages, not the whole stream.

### A.5 What should and should not move to Rust

| Work | Target | Reason |
| --- | --- | --- |
| HTTP protocol, TLS, decompression, timing, socket metadata | Rust | Already native and I/O-bound |
| Response capture, cancellation, hashing, byte count, encoding sniff, media metadata | Rust | Avoid full body copies and allow bounded work |
| Large-response text windows, line index, search, hex/base64 windows, pretty representations, jq/JSONPath subset | Rust behind `ResponseContentPort` | Operate against native content without returning a full duplicate |
| Small-response formatting/query | Initially TypeScript, later the same port may choose a fast path | Current behavior is well tested; IPC overhead can exceed the work for small inputs |
| Read-only large response rendering | React virtualized/windowed viewer | UI owns interaction but only holds visible data |
| Large binary/file/multipart request materialization | Rust from scoped body/file handles | Avoid `Blob.arrayBuffer() -> base64 -> decode` and stream repeatable bodies for redirects |
| URL, params, workspace inheritance, variables, auth choice, GraphQL-over-HTTP envelope | TypeScript application layer | Product policy, small data, and one existing composition path |
| Secret encryption, key derivation, vault, zeroization | Rust | Already correct and security-sensitive |
| Secret field ownership, `SecretRef` projection, editor reveal, template resolution | TypeScript application layer | Moving it is not a performance optimization and would duplicate the canonical/runtime model |
| OpenAPI/large collection loading and normalization | Rust | Already the right boundary; split the module without changing semantics |
| Request JSON/XML diagnostics and prettify while editing | TypeScript; use a Web Worker if profiling shows input lag | Per-keystroke editor feedback needs local AST offsets and CodeMirror integration |
| cURL paste parser and request code generation | TypeScript | Small, interactive, and tightly tied to `RequestDraft` semantics |
| GraphQL query parsing, completion, hover, variables hints | TypeScript, preferably a Web Worker before a Rust rewrite | It uses `graphql`, `graphql-language-service`, CodeMirror, and a live `GraphQLSchema` on each edit |
| Very large GraphQL introspection normalization/indexing | Conditional Rust service after measurements | Can reduce WebView memory, but only if the UI consumes a compact paged index instead of reconstructing the full schema |
| YAML canonical codec and project validation | TypeScript domain/storage | Git format and business invariants, not a measured hot path |

Moving all parsing to Rust is therefore not the target. Purr should move work when native ownership removes copies, provides streaming, protects the UI thread, or contains privileged I/O. Language services that must immediately feed CodeMirror should stay close to the editor until measurements justify a separate service.

## B. Target architecture

### B.1 Frontend structure

This is a target shape, not a command to create every empty directory immediately.

```text
src/
  App.tsx                         # OSS entry using createPurrApp(coreModules)
  app/
    app-router.tsx                 # core routes + immutable contributed pages
    create-purr-app.tsx           # public app factory
    composition/
      core-modules.ts             # public built-ins only
      create-services.ts          # builds ports and immutable registries

  domain/
    project.ts                    # existing canonical project model
    http.ts                       # HttpExchange metadata + ResponseContentRef
    observability.ts              # Trace, Span, LogRecord, correlation refs
    integration.ts                # provider-neutral IDs/config envelope
    extension-document.ts         # opaque, versioned config for contributed document types

  application/
    ports/
      http-transport.ts
      response-content.ts
      persistence.ts
      credentials.ts
      clock.ts                    # only if deterministic tests need it
      extension-state.ts          # encrypted module-scoped local state, only when needed
    requests/
      prepare-request.ts          # extracted current request policy
      execute-request.ts
    responses/
      inspect-response.ts         # chooses small/native presentation path
    observability/
      find-related-traces.ts
      query-logs.ts
    project-projection.ts         # existing boundary
    workspace-persistence.ts
    importing/

  integrations/
    contracts.ts                  # provider and build-time contribution contracts
    registry.ts                   # duplicate-safe immutable capability registries
    builtins/
      jaeger/                     # first public validation adapter
      # tempo/, loki/ only when implemented

  extension-api/
    index.ts                      # curated stable barrel, no feature internals
    testing.ts                    # conformance harness for external modules

  platform/
    tauri/
      contracts.ts                # all core IPC DTOs and protocol versions
      http-transport.ts
      response-content.ts
      persistence.ts
      credentials.ts
      oauth.ts
      importing.ts
    browser/
      persistence.ts
      credentials.ts
      response-content.ts         # Blob/IndexedDB or in-memory test implementation

  features/
    workspaces/                   # existing runtime aggregate and UI
    request-workbench/
      components/
      model/                      # editor/runtime models, not exported SDK
    graphql/
    observability/                # provider-neutral UI when implemented
    extensions/                   # core-owned page/document hosts and unavailable states

  storage/                        # YAML/file codecs; shrink as adapters move to platform/
  shared/                         # UI primitives, theme, general utilities
  styles/
```

`domain/http.ts` must not contain Tauri handles as platform concepts. It contains an opaque ID and metadata:

```ts
type ResponseContentRef = Readonly<{
  id: string;
  byteLength: number;
  mediaType?: string;
  charset?: string;
  complete: boolean;
}>;

type HttpExchange = Readonly<{
  request: HttpRequestSnapshot;
  response: HttpResponseMetadata;
  content: ResponseContentRef;
  timeline: HttpTimeline;
}>;
```

The desktop adapter interprets the ID as native content. The browser/test adapter can interpret it as a Blob/IndexedDB key. Feature code never receives a filesystem path or SQLite key.

### B.2 Rust structure

Keep one public Rust crate. Add folders only when a capability has several cohesive files.

```text
src-tauri/src/
  main.rs                         # OSS binary calls purr_lib::run(core_builder())
  lib.rs                          # public builder/run surface
  composition.rs                  # managed states, public plugins, core commands

  commands/
    mod.rs                        # thin Tauri command registration
    app.rs                        # exit only; remove template greet
    http.rs                       # start/cancel HTTP hop DTO mapping
    response.rs                   # read/search/format/query/save/release commands
    persistence.rs
    importing.rs
    oauth.rs

  http/
    mod.rs
    client.rs                     # reqwest client and safe URL/header conversion
    transport.rs                  # one hop, timings, redirect remains app policy
    request_body.rs               # inline/body-handle/multipart streaming
    operations.rs                 # request IDs and cancellation tokens

  content/
    mod.rs
    contracts.rs                  # ContentId, metadata, range/page/result DTOs
    store.rs                      # lifecycle and quota policy
    chunks.rs                     # encrypted chunk append/read
    line_index.rs                 # incremental line offsets for text windows
    media.rs                      # safe custom protocol/stream response for media

  response/
    mod.rs
    inspect.rs                    # media type, charset, BOM, sniff prefix
    decode.rs                     # bounded text decoding
    search.rs                     # streaming literal/regex search with limits
    format.rs                     # JSON/XML/NDJSON presentation generation
    query/
      mod.rs
      jsonpath.rs                 # current supported subset first
      jq.rs                       # current supported subset first

  importing/
    mod.rs
    contracts.rs
    source.rs                     # file/directory/URL/text and budgets
    references.rs
    openapi.rs
    project.rs                    # normalized Purr result

  persistence/
    mod.rs                        # RuntimeStorage coordinator
    local_records.rs
    response_bodies.rs            # typed execution metadata + content adoption
    project_files.rs
    watcher.rs
    journal.rs
    migrations.rs
    legacy.rs

  security/
    mod.rs
    root_key.rs
    cipher.rs
    credential_vault.rs

  oauth.rs                        # keep one file until more flows exist
```

There is no generic Rust `domain/` or `services/` folder in this proposal. HTTP, content, import, persistence, and security are clearer capability boundaries. `commands/` is only transport glue; it must not become the business layer.

### B.3 Native large-response flow

```text
React execute use case
  -> HttpTransportPort.startHop(prepared transport request, progress sink)
  -> Tauri command start_http
  -> reqwest headers arrive
  -> response metadata event (no body bytes)
  -> chunks are encrypted and appended to ResponseContentStore
  -> bounded progress events, with backpressure and cancellation
  -> completion returns HttpResponseMetadata + ResponseContentRef

Response UI
  -> ResponseContentPort.inspect(contentId)
  -> readLines/readRange(contentId, cursor, limit)
  -> virtualized read-only viewer holds visible windows only
  -> search/query/format run in Rust for native content
  -> scalar/small results cross IPC; large results become another contentId

Save response
  -> save(contentId, dialog choice)
  -> native store decrypts chunks and streams directly to destination
  -> no body round trip through WebView
```

Use a Tauri channel for headers/progress/state changes, not for sending every response byte to JavaScript. The content store provides the backpressure boundary. Progress should be coalesced by time or byte count.

The initial content-store implementation should use the existing local SQLite security model and add independently encrypted chunks, rather than writing plaintext temporary response files:

```text
response_contents(
  id, workspace_id?, execution_id?, state, byte_length,
  media_type?, charset?, created_at, expires_at?
)

response_content_chunks(
  content_id, chunk_index, plain_offset, plain_length,
  crypto_version, nonce, ciphertext
)
```

Each chunk uses a separate nonce and AAD containing content ID, index, and format version. Add a separate HKDF info label such as `purr:response-content:v1`; do not reuse the credential-vault key. A staging response starts without workspace ownership, then persistence atomically adopts it for an execution. Abandoned staging content expires and startup cleanup removes incomplete/expired records. Deleting history or a workspace cascades to its chunks.

Use a small content-store actor/worker that owns its SQLite connection and response-content cipher. Async HTTP tasks send chunks through a bounded channel and wait when it is full; this supplies real backpressure and keeps synchronous `rusqlite`/AEAD work off the Tokio request task. Reuse the same SQLite database in WAL mode, but do not share one unlocked connection between async tasks. Reads and adoption/release operations go through the same store API. A database pool or async ORM is unnecessary unless measurements later show this single ownership model is the bottleneck.

Starting tuning values, held in one internal `ResponseLimits` struct rather than the public contract:

- encrypted chunk: 256 KiB;
- maximum IPC byte/text window: 256 KiB;
- full CodeMirror response document: smaller than 1 MiB; the exact 1 MiB boundary is bounded because a single-line body at that size measurably blocks WebView layout;
- progress emission: at most every 100 ms or 1 MiB;
- full-tree native JSON operation: explicit bounded tier, initially 32 MiB;
- larger JSON: supported streaming/indexed operations only, with an explicit unsupported-expression error rather than unbounded allocation.

Capture quota, TTL, and maximum retained history bytes must be benchmarked before choosing public defaults. During the first storage PR, preserve the current 20 MiB product limit so storage and rendering changes do not also change product behavior. A later measured PR raises/replaces that limit and verifies 100 MiB+ responses.

### B.4 Native response operations

The frontend port should express user operations rather than native implementation details:

```ts
interface ResponseContentPort {
  inspect(ref: ResponseContentRef, signal?: AbortSignal): Promise<ContentInfo>;
  readRange(ref: ResponseContentRef, range: ByteRange, mode: "bytes" | "text" | "hex" | "base64"): Promise<ContentWindow>;
  readLines(ref: ResponseContentRef, cursor: LineCursor, limit: number): Promise<LinePage>;
  search(ref: ResponseContentRef, query: SearchQuery, cursor?: SearchCursor, signal?: AbortSignal): Promise<SearchPage>;
  format(ref: ResponseContentRef, request: FormatRequest, signal?: AbortSignal): Promise<ContentOperationResult>;
  query(ref: ResponseContentRef, request: JsonQueryRequest, signal?: AbortSignal): Promise<ContentOperationResult>;
  save(ref: ResponseContentRef, suggestion: SaveSuggestion): Promise<string | null>;
  release(ref: ResponseContentRef): Promise<void>;
}
```

`ContentOperationResult` is a discriminated union: a small scalar/JSON value, a bounded page, or another `ResponseContentRef`. It must never return an unbounded pretty string by accident.

Port the exact currently tested jq/JSONPath subset first. Purr does not implement complete jq or complete JSONPath today, and a Rust migration must not silently change the language. Run the same conformance fixtures against the TypeScript and Rust implementations before switching. Full jq via a compatible engine can be a later product decision.

Search returns byte/line offsets, bounded snippets, total-known/has-more state, and a cursor. Pretty JSON/XML creates a cached derived content entry for large results. Hex/base64 are calculated for the requested range. NDJSON is naturally pageable. Recursive JSON selectors that require a complete tree must respect the native parse tier and report that the expression is unavailable for a body of that size if no bounded algorithm exists.

Images/audio/video should use a handle-bound custom protocol or equivalent safe stream URL. Do not create base64 data URLs. The protocol must validate opaque IDs, content ownership, range headers, allowed media types, and lifecycle; it must not expose an arbitrary local file protocol.

### B.5 GraphQL performance boundary

The current `GraphQLSchema` object drives completion, hover, validation, field filling, variables hints, schema exploration, navigation, and introspection export. Replacing `parseGraphqlSchema()` with a Rust command while recreating the full JS `GraphQLSchema` would add IPC and duplicate representations without reducing final WebView memory.

Use this sequence:

1. Instrument schema parse duration, SDL/introspection size, UI long tasks, and WebView memory.
2. Move `graphql` parsing/language-service calls into a Web Worker if responsiveness is the problem. This preserves current libraries and message-compatible editor results.
3. Only if total memory remains a real problem, introduce a `GraphqlSchemaService` port backed by Rust. Rust then owns normalized SDL/introspection storage and a compact schema index, while the UI requests type pages, field details, search results, metrics, and operation templates. Do not return a reconstructed full schema to every component.
4. Keep the query editor parser close to the language service. A native schema index can supply compact type data, but per-keystroke query parsing in Rust is not part of the initial migration.

If step 3 becomes necessary, add `graphql/{introspection.rs,index.rs,service.rs}` to Rust then. Do not create that module tree before the profile justifies it.

### B.6 Request parsing and large request bodies

There are three different meanings of “request parser” in the current code and they should not be migrated together:

- reqwest/hyper already owns HTTP protocol parsing and serialization in Rust;
- `RequestDraft` composition (inheritance, paths/query, variables, GraphQL envelope, auth, cookies, redirects) is application policy and stays in TypeScript;
- JSON/XML diagnostics, cURL paste, and GraphQL query parsing are interactive editor services and initially stay in TypeScript, with a Web Worker when input size causes UI stalls.

For large bodies, TypeScript should produce a transport-level plan after all application policy is complete:

```ts
type PreparedBodySource =
  | { kind: "none" }
  | { kind: "inline"; encoding: "utf8" | "base64"; value: string }
  | { kind: "content"; id: string; byteLength: number }
  | {
      kind: "multipart";
      boundary: string;
      parts: Array<
        | { kind: "inline"; headers: [string, string][]; value: string }
        | { kind: "content"; headers: [string, string][]; id: string; byteLength: number }
      >;
    };
```

The exact final DTO can differ, but it must have these properties: it is already resolved, repeatable for redirects/retries, bounded for inline values, and contains opaque scoped handles rather than filesystem paths. Rust materializes bytes and multipart framing; it does not decide which editor rows are enabled or how variables/auth work. Request prettify and diagnostics remain in the editor because returning the full edited string from Rust would not reduce memory.

The native file-selection/body adapter creates a content handle. The browser adapter keeps a Blob-backed handle with the same application interface. A handle has ownership, byte length, last-modified/source identity as needed, TTL, and explicit release. Revalidate file identity before send so a replaced file is not silently uploaded.

### B.7 Secret boundary after migration

Keep Keychain access, HKDF, encryption/decryption, vault records, reference validation, and zeroization in Rust. Split them into `security/` modules because `local_state.rs` currently mixes these responsibilities with history and migrations.

Keep `SecretRef` ownership, canonical projection, form/reveal state, auth selection, and template expansion in TypeScript. The current UI must sometimes display or edit a secret, so moving one parser does not automatically keep plaintext out of WebView. A future high-security mode may send credential slots/refs in the prepared request and let Rust inject values immediately before transport, but that requires a complete threat model for redirects, request previews, OAuth tokens, provider access, and secret-bearing templates. It is not justified as a performance migration.

Extensions receive a scoped `CredentialResolver` bound to their integration instance and declared credential keys. They do not receive the raw `SecureStore` or arbitrary ref lookup. Public application code resolves `external-secret` variables through a registered credential-provider contract with explicit cache, redaction, and error policy; project YAML still contains only provider/key metadata or `SecretRef` values.

## C. Dependency rules

Allowed frontend directions:

```text
feature UI -> application use cases -> domain
feature UI -> shared UI
application -> application ports + domain
platform adapters -> application ports + IPC contracts
integrations -> integration contracts + public domain/application ports
extension-api -> selected domain/contracts/testing exports
app composition -> core features + adapters + integrations
private modules -> public extension-api
private module UI -> public extension-api/UI primitives + that module's private services
extension hosts -> frozen page/document contribution descriptors, never module internals
```

Allowed native directions:

```text
commands -> http/content/importing/persistence/security/oauth
http -> content contracts/store (for bodies), never persistence JSON shapes
response -> content store
persistence -> content store + security + project files
content -> security cipher abstraction + storage infrastructure
composition -> commands and managed implementations
private native plugin -> public builder/plugin API
```

Forbidden dependencies:

- public source importing `purr-commercial`, Datadog, CloudWatch, New Relic, Splunk, licensing, or enterprise policy modules;
- domain importing React, Tauri, SQLite, YAML, filesystem paths, CodeMirror, reqwest, or vendor DTOs;
- core UI switching on provider IDs such as `if (provider === "datadog")`;
- core router, sidebar, or workbench importing a private page/editor component directly;
- providers mutating global registries after app startup;
- provider adapters reading `Workspace`, `RequestDraft`, or `LocalRecord.value` directly;
- contributed pages/editors receiving the mutable runtime `Workspace`, raw `PersistenceBackend`, raw `SecureStore`, or unrestricted application service container;
- private protocol/vendor types being added to core document, response, or navigation unions;
- extension modules replacing the core router, request pipeline, persistence coordinator, or security policy through monkey patches/middleware;
- Tauri commands deciding workspace inheritance, variables, auth policy, or canonical persistence ownership;
- response operations returning arbitrarily large strings/arrays through IPC;
- private Rust code reaching into non-public modules of `purr_lib`;
- a provider writing project YAML, local SQLite, or secrets directly;
- plaintext response spool files or body paths exposed to the frontend;
- a second request serializer in Rust that interprets editor body modes independently of the prepared transport plan.

Enforce frontend rules initially with ESLint import restrictions for `domain`, `application`, `platform`, and `extension-api`. Enforce the private-to-public rule through separate-repository CI, public export maps, and by keeping feature-internal paths out of package exports.

## D. Public/private boundary

### D.1 Public `purr`

Public code contains the full useful OSS product:

- HTTP and GraphQL editing/execution;
- workspaces, environments, variables, history, imports, request/response UI;
- canonical schemas and migrations;
- project filesystem, encrypted local state, secure-store abstraction and platform implementations;
- native HTTP/body/content engine, search/format/query capabilities;
- provider-neutral observability domain and UI;
- integration contracts, registries, composition root, extension API, and conformance tests;
- core-owned hosts and generic envelopes for namespaced extension pages/navigation and contributed workspace document types;
- public built-ins such as Jaeger, Tempo, and Loki when each is actually implemented;
- public app entry, icons/config appropriate for the OSS build, CI, and release artifacts.

### D.2 Private `purr-commercial`

Private code may contain:

- Datadog, CloudWatch, New Relic, Splunk, SaaS, and enterprise provider adapters;
- licensing, entitlement, organization/team policy, enterprise auth, and credential-provider modules;
- private UI components attached through named page, document, settings, or provider contributions;
- private pages, navigation entries, settings surfaces, workspace document editors, and protocol-specific presentation registered through named contributions;
- module-owned application services and protocol clients built only from constrained public ports or their own private native plugin;
- optional Tauri plugins/commands needed by private providers;
- the official composition entry, official branding/config, signing/notarization workflow, and release publication configuration;
- compatibility manifest and tests against a pinned public core revision.

It must not contain copied core components, workspace/request models, storage implementations, or a forked `WorkspaceWorkbench`.

### D.3 Boundary decisions

- `Trace`, `Span`, `LogRecord`, time ranges, pagination, correlation, and provider-neutral errors are public domain concepts.
- Jaeger/Tempo/Loki/Datadog/CloudWatch payloads remain inside their adapters.
- `SecretRef`, `Credential`, and a scoped credential resolver are public contracts. Credential values are never extension configuration.
- Licensing and entitlement concepts stay private unless the OSS product later needs a generic capability policy. Core must not contain dormant commercial checks.
- Official branding/build metadata can be private, but the public build must have valid independent identity and config.
- A provider that only calls an HTTP API should normally be TypeScript and use the public transport/credential ports. Add a private native plugin only for privileged native APIs, native SDKs, or a measured memory/security need.
- Private feature logic may remain entirely module-owned. It becomes a core dependency only when it implements a narrow public capability contract; merely showing a private page does not require exporting its service through core.
- A new request protocol is a contributed document type with an opaque canonical envelope and its own editor/controller. It does not expand the core `RequestDraft` or `HttpExchange` with vendor/protocol fields. If it reuses HTTP, it calls the public HTTP execution ports; if it needs sockets, streaming, or an SDK, its module owns a namespaced Tauri plugin.

## E. Extension model

### E.1 Canonical integration envelope

Evolve the current integration schema with a migration rather than replacing it with vendor-specific unions:

```ts
type IntegrationDefinition = {
  kind: "integration";
  id: EntityId;
  name: string;
  provider: string;              // stable adapter ID
  enabled: boolean;
  configVersion: number;
  config: JsonObject;            // owned and validated by that adapter
  credentials: Record<string, Credential>;
  folderId?: EntityId;
};
```

The old `endpoint` migrates into `config` for adapters that use it. Unknown provider/config data must round-trip unchanged so opening an official workspace in OSS Purr does not destroy commercial configuration. OSS Purr shows an unavailable-provider state and permits safe disable/delete; it does not attempt to interpret private fields.

### E.2 Module and registry contracts

Use one build-time module contract and capability-specific registries:

```ts
interface PurrExtensionModule {
  readonly manifest: {
    id: string;
    extensionApi: 1;
    version: string;
  };
  register(registrar: ExtensionRegistrar): void;
}

interface ExtensionRegistrar {
  integrations: IntegrationProviderRegistrar;
  traceProviders: TraceProviderRegistrar;
  logProviders: LogProviderRegistrar;
  correlationExtractors: CorrelationExtractorRegistrar;
  schemaRegistries: SchemaRegistryRegistrar;
  credentialProviders: CredentialProviderRegistrar;
  pages: ExtensionPageRegistrar;
  documentTypes: WorkspaceDocumentTypeRegistrar;
}
```

The baseline external-module proof needs integration, trace, correlation, page/navigation, and document-type registration. Log, schema-registry, credential-provider, response-panel, or policy registries are added only with their first real use case; do not create empty registries for every possible product idea.

Registration occurs once in `createPurrApp()`. The builder rejects duplicate module/provider IDs, validates API versions, and freezes registries before rendering. No module discovery, dynamic loading, service locator, or global singleton is needed.

Separate non-React provider contracts from optional React UI contributions. A provider manifest supplies label/icon/capabilities and a config validator. An optional settings editor receives typed form state and public UI primitives through documented imports; domain and application services never import that component.

#### E.2.1 Named UI pages and module-owned logic

The official build must be able to add a complete private feature page without replacing `AppRouter`, forking the shell, or importing private code from the public repository. Use a namespaced page contribution rather than a generic component slot:

```ts
type ExtensionPageContribution = {
  id: string;                    // unique within the module
  routeSegment: string;          // core creates /extensions/<module-id>/<segment>
  title: string;
  navigation?: {
    area: "primary" | "workspace" | "settings";
    label: string;
    icon?: ExtensionIcon;
    order?: number;
  };
  create(context: ExtensionModuleContext): ExtensionPage;
};

type ExtensionModuleContext = {
  moduleId: string;
  http: HttpTransportPort;
  responseContent: ResponseContentPort;
  localState?: ModuleScopedStatePort;
  logger: ExtensionLogger;
};
```

`ExtensionPage` owns its React component and module-private hooks/services. It imports React, documented Purr UI primitives/tokens, and public extension contracts; core domain/application code never imports it. The router derives and validates the full path, the navigation host renders its descriptor, and unloading the module removes both atomically. Contributions cannot shadow `/workbench`, `/`, or another module's route.

The context is capability-limited. It has no mutable `Workspace`, raw persistence backend, arbitrary secret lookup, registry mutation, router replacement, or unrestricted service locator. Integration/provider factories receive a credential resolver scoped to their integration and declared keys. A private page can call its own private service directly; it registers that service with core only if a core workflow needs a stable, provider-neutral capability.

When a private feature needs native code, the private composition root constructs its typed TypeScript adapter for that module's namespaced Tauri plugin and captures the adapter in the page/controller factory. The public registrar does not expose a generic `invoke(command, payload)` capability, and neither the plugin command DTOs nor the private service interface enter the core API unless a provider-neutral core workflow actually needs them.

These are trusted build-time modules shipped in a selected binary, not a security sandbox for third-party code. Import/export restrictions, scoped contexts, and registries keep architecture stable; they cannot make arbitrary React/JavaScript loaded into the process hostile-code-safe. Supporting untrusted plugins would require a separate process/permission design and is outside this plan.

Settings are initially ordinary contributed pages with `navigation.area: "settings"`. Add a narrower inline settings section or response-panel contract only when a concrete feature must appear inside an existing core screen. Each such surface gets explicit props and lifecycle; there is no `render(slotName, anything)` API.

#### E.2.2 Extension document types and new protocols

Do not model every future protocol as another branch in `RequestDraft`. Add one public opaque envelope that the canonical project/YAML layer can preserve without understanding module fields:

```ts
type ExtensionDocumentDefinition = {
  kind: "extension";
  id: EntityId;
  name: string;
  folderId?: EntityId;
  extensionType: string;         // globally stable, for example commercial.grpc
  configVersion: number;
  config: JsonObject;            // no secret values or filesystem paths
};

interface WorkspaceDocumentTypeContribution {
  extensionType: string;
  ownerModuleId: string;
  label: string;
  validateAndMigrate(configVersion: number, config: JsonObject): ValidatedConfig;
  create(context: ExtensionModuleContext): ExtensionDocumentController;
}
```

The core document host owns identity, folders, tabs, dirty/saved lifecycle, unavailable-module state, and opaque canonical round-trip. The module-owned controller owns its editor, protocol actions, application logic, and presentation. It updates only its validated `config`; encrypted session/cache data uses a module- and document-scoped state port. Secrets use public `Credential`/`SecretRef` conventions plus a scoped resolver. A later asset contract may expose opaque project asset refs, never absolute paths.

HTTP and GraphQL continue through the single core request-composition path. A contributed protocol such as gRPC, WebSocket, MQTT, or a proprietary SaaS workflow may:

- reuse public HTTP/content ports when their semantics fit;
- return provider-neutral execution metadata/content references when the standard response UI fits;
- own a specialized bounded streaming/session UI when request/response semantics do not fit;
- invoke its own namespaced Tauri plugin for sockets, streaming, native SDKs, or privileged OS access.

Core does not pretend all protocols are HTTP and does not add `if (extensionType === "commercial.grpc")` branches. When the module is absent, OSS Purr preserves the definition and shows an unavailable document with safe rename/move/delete actions; it never discards or interprets the opaque config.

Cross-cutting core behavior uses separate named contracts only when there is a concrete requirement. For example, an enterprise request policy could later receive redacted prepared-request metadata and return allow/deny diagnostics. It must not become generic middleware that mutates request bodies, secrets, persistence, or navigation.

### E.3 Observability domain and provider contracts

The first useful contract needs more than `fetchTrace()`:

```ts
type TraceReference = {
  traceId: string;
  spanId?: string;
  integrationId?: string;
  source: "response-header" | "request-header" | "response-body" | "manual";
};

type Trace = {
  id: string;
  startedAt: string;
  durationUs: number;
  rootService?: string;
  rootOperation?: string;
  status: "unset" | "ok" | "error";
  spans: Span[];
  attributes: Record<string, AttributeValue>;
};

type Span = {
  id: string;
  traceId: string;
  parentSpanId?: string;
  service: string;
  operation: string;
  startedAt: string;
  durationUs: number;
  status: "unset" | "ok" | "error";
  attributes: Record<string, AttributeValue>;
  events: SpanEvent[];
};

type LogRecord = {
  id: string;
  timestamp: string;
  severity?: string;
  message: string;
  traceId?: string;
  spanId?: string;
  attributes: Record<string, AttributeValue>;
};

interface TraceProvider {
  getTrace(ref: TraceReference, signal: AbortSignal): Promise<Trace | null>;
  searchTraces(query: TraceSearchQuery, signal: AbortSignal): Promise<Page<TraceSummary>>;
}

interface LogProvider {
  queryLogs(query: LogQuery, signal: AbortSignal): Promise<Page<LogRecord>>;
}
```

`AttributeValue`, `Page`, time ranges, normalized provider errors, and cancellation are public. Raw Jaeger/Datadog/CloudWatch responses are private to adapters. Provider factories receive a constrained context such as `HttpTransportPort`, scoped `CredentialResolver`, cache, and logger. They do not receive all application services.

Correlation is its own contract because trace IDs can come from W3C `traceparent`, B3, vendor headers, response JSON, or a manual value. Extractors return `TraceReference[]`; the application service chooses enabled integration instances and queries registered providers. The response tab consumes normalized traces and never checks a vendor string.

### E.4 Representative Jaeger vertical slice

```text
HttpExchange metadata/headers
  -> public correlation extractors
  -> TraceReference
  -> FindRelatedTraces application use case
  -> TraceProviderRegistry resolves integration.provider
  -> JaegerTraceProvider maps Jaeger HTTP DTO -> Trace/Span
  -> provider-neutral Trace panel renders Trace
```

The public built-in module is conceptually:

```ts
export const jaegerModule: PurrExtensionModule = {
  manifest: { id: "purr.jaeger", extensionApi: 1, version: "..." },
  register(registrar) {
    registrar.integrations.register(jaegerDefinition);
    registrar.traceProviders.register(jaegerTraceProviderFactory);
    registrar.correlationExtractors.register(w3cAndB3Extractor);
  },
};
```

A private Datadog module implements the same contracts:

```ts
export const datadogModule: PurrExtensionModule = {
  manifest: { id: "commercial.datadog", extensionApi: 1, version: "..." },
  register(registrar) {
    registrar.integrations.register(datadogDefinition);
    registrar.traceProviders.register(datadogTraceProviderFactory);
    registrar.logProviders.register(datadogLogProviderFactory);
  },
};
```

The official entry passes `datadogModule` to `createPurrApp`. No public file changes. If Datadog needs a native API, its TS adapter invokes a namespaced command exposed by a private Tauri plugin registered by the private binary.

### E.5 TypeScript/Rust shared contracts

Do not create a common npm package for IPC. Keep one checked-in TypeScript boundary in `src/platform/tauri/contracts.ts` and matching concrete serde DTOs beside the Rust capability. Add:

- a `protocolVersion` on multi-step response/content protocols and versioned stored descriptors;
- Zod decoding for untrusted/complex command results rather than relying on `invoke<T>` casts;
- fixture-based contract tests serialized by Rust and parsed by TypeScript for HTTP, content operations, imports, and persistence descriptors;
- stable command names collected in the Tauri adapter, not scattered string literals;
- provider-specific IPC DTOs inside provider adapters/plugins, never in core HTTP/observability domain.

Do not generate code in the first migration PR. `ts-rs`, Specta, or JSON Schema generation can be adopted later if DTO drift remains costly after centralization. A code-generation framework is not needed to establish the boundary.

Replace Rust inspection of generic `request_executions` JSON with a typed execution persistence command/DTO. Generic local records can remain for drafts/layout/cache, but Rust must not know nested frontend fields such as `response.timeline.startedAtMs`.

## F. Repository layout

```text
purr/                     PUBLIC
  complete OSS React app
  public app factory + extension API
  all canonical/application contracts
  public integrations
  purr_lib Rust crate + OSS Tauri binary
  OSS tests, docs, CI, releases

purr-commercial/          PRIVATE
  thin official React entry/composition
  commercial extension modules
  optional private Tauri plugins
  thin official Rust binary/config
  compatibility manifest
  private integration/e2e/release/signing workflows

purr-site/                PUBLIC (independent)
  website/docs/download pages
  no application source
```

Dependency flow:

```text
purr-site        (independent consumer of release metadata)

purr-commercial
  -> exact compatible revision of purr frontend package
  -> exact compatible revision of purr_lib Rust crate

purr
  -> no private dependency
```

The private repo owns composition scaffolding plus commercial modules: its own `index.html`, Vite entry, package/Cargo manifests, `tauri.conf.json`, official branding, `main.rs`, private provider/protocol adapters, module-owned services, and contributed UI. That shell and the commercial features are expected private source; no public feature, domain, persistence, shell, router, or workbench source is duplicated.

Initially the public root package can expose `./app`, `./extension-api`, and `./styles` through `package.json`. Do not extract `packages/integration-api`. Add a public `build:core` library build that emits JavaScript, type declarations, one compiled/tokenized CSS entry, and its font/assets into a deterministic ignored output directory. The private Vite build consumes those exports, so its Tailwind scan does not need to know public source paths. Keep React/React DOM as peer/singleton dependencies for the consumed build (and normal development dependencies for the OSS app) to prevent a second React instance. The normal public app build remains a separate first-class build target.

The Rust crate already exists as `purr_lib`; expose a narrow builder surface rather than adding another crate. `core_builder()` registers all public state, commands, and plugins. A run helper accepts the builder and the caller-generated Tauri context; it must not always call `generate_context!()` inside the public crate, because the private binary must use its own `tauri.conf.json` and capabilities.

## G. Local development workflow

Recommended checkout:

```text
~/projects/
  purr/
  purr-commercial/
```

OSS development stays unchanged:

```bash
cd ~/projects/purr
npm install
npm run tauri dev
```

Official development runs from the private shell. Its frontend dependency resolves to the sibling checkout and its Rust dependency uses a sibling path:

```json
{
  "dependencies": {
    "@purr/core": "file:../purr"
  }
}
```

```toml
[dependencies]
purr_lib = { path = "../../purr/src-tauri" }
```

The precise Cargo relative path depends on whether the private manifest is at the root or under `src-tauri`; CI must use the same sibling checkout layout. The private app imports `createPurrApp`, compiled public styles, and `extension-api`, then supplies `commercialModules`. Those modules may register providers, pages/navigation, private services, and extension document/protocol types through the same build-time call. Its `main.rs` augments `purr_lib::core_builder()` with private Tauri plugins and calls the public run helper with the private crate's `tauri::generate_context!()` result.

For local hot reload, a private `dev` script starts the public `build:core --watch` task and the private Vite/Tauri task together. This is build orchestration, not source copying. The public package output is the same artifact shape that CI consumes.

Use npm consistently. The current repository has both `package-lock.json` and `yarn.lock`, while Tauri config invokes Yarn and README invokes npm. Standardize this before making the core consumable. For a solo developer, npm plus sibling `file:` dependency and Cargo path dependency is the smallest workable model.

Alternatives considered:

| Option | Decision |
| --- | --- |
| Copy public source into private build | Rejected; creates permanent merge/cherry-pick debt |
| Git submodule containing Purr inside private repo | Rejected for normal development; obscures the sibling workflow and still encourages nested build assumptions |
| Publish every internal package/crate | Deferred; unnecessary release/versioning overhead for one developer |
| A third super-workspace repo | Deferred; two sibling checkouts and deterministic scripts are enough |
| Runtime dynamic plugin loading | Rejected for now; build-time composition covers official/private modules |
| Sibling path dependencies locally, exact sibling checkout in CI | Chosen |

Add `core-version.json` to the private repo:

```json
{
  "coreGitSha": "...",
  "coreVersion": "0.x.y",
  "extensionApi": 1,
  "nativeApi": 1
}
```

A private bootstrap script validates that the sibling public checkout matches the manifest and gives a clear command to switch it. It should not copy files or rewrite source imports.

## H. CI and release implications

Public CI must be self-contained:

```text
public PR
  -> npm clean install
  -> TypeScript tests + typecheck + lint + build
  -> Rust fmt/clippy/test
  -> extension API conformance fixtures
  -> OSS Tauri build smoke test
```

Private/official CI:

```text
public release tag selected
  -> read purr-commercial/core-version.json
  -> checkout purr at exact SHA into ../purr
  -> checkout purr-commercial at compatible tag/SHA into ../purr-commercial
  -> validate extensionApi/nativeApi and dependency locks
  -> build public core package in place
  -> test commercial modules against public conformance harness
  -> build official frontend composition
  -> build official Tauri binary with private plugins
  -> e2e/smoke test
  -> sign -> notarize -> publish official release
```

Requirements to establish now:

- deterministic public package exports; private code must not import `src/features/...` paths;
- public `core_builder()`/run API for the Rust shell;
- unique command/plugin namespaces for private native modules;
- API version in every extension manifest and a checked compatibility manifest;
- conformance tests owned publicly so private CI can verify providers without public CI seeing private code;
- conformance coverage for every declared contribution kind: providers, page/routes, document types, scoped state, and any namespaced native commands;
- one package manager and committed lockfiles;
- separate OSS and official bundle identifiers, updater endpoints/public keys, branding, and release channels;
- no signing identity or signing key committed in `tauri.conf.json`; CI injects release credentials;
- no copy/overlay step in the official build. Both repositories are normal dependency inputs checked out side-by-side.

Public PRs cannot normally run private CI without exposing private credentials/code. Breaking extension changes therefore require an explicit public API version bump, migration notes, and a coordinated private compatibility branch. Private CI should run on every supported public release candidate and on a scheduled check against public `main`.

## I. Incremental migration plan

Each phase is intended to be one reviewable PR unless explicitly split. Every PR must keep the OSS application working. Pure file moves should not be mixed with behavior changes, which reduces conflicts with ongoing feature development.

### Phase 0 — freeze measurements and compatibility fixtures

Status: DONE

Implemented in: `10bf837` (performance tooling on `main`) and `c4c8c8d` (Phase 0 fixtures, tests, baseline, and tracking).

Started: 2026-09-15

Completed: 2026-09-15

Automated verification:
- [x] Run deterministic response benchmarks for 100 KiB, 1 MiB, 20 MiB, and 100 MiB fixtures and save the report.
- [x] Run the reusable jq/JSONPath conformance fixture suite against the current TypeScript implementation.
- [x] Run TypeScript unit/UI tests and Rust tests after adding fixtures: 120 unit tests, 51 Playwright tests, and 37 Rust tests passed.
- [x] Run `npm run typecheck`, `npm run lint`, `npm run build`, `cargo fmt --check`, and `cargo clippy --all-targets -- -D warnings`.
- [x] Smoke-test synthetic JSON, NDJSON, binary, GraphQL, and 100 MiB `HEAD` fixture endpoints; verify the native 20 MiB + 1 byte compatibility error in a deterministic Rust test.

Manual verification:
- [x] From a clean isolated desktop start, record idle native/WebView RSS and verify the exact 100 KiB JSON fixture. Idle was 134.2/218.0 MiB native/WebView; the response completed in under 100 ms without a visible freeze at 153.6/279.0 MiB. The earlier 1 MiB text scenario caused a 1–2 second UI stall.
- [x] Execute exactly 20 MiB and 20 MiB + 1 byte scenarios. Exactly 20 MiB made the UI permanently unresponsive and prevented normal close; 20 MiB + 1 byte returned `Response exceeds the 20 MB preview limit.`. RSS was not captured.
- [x] Execute the delayed-header fixture. After approximately one second Purr became unresponsive, then eventually displayed the response; there was no separately visible headers/TTFB state.
- [x] Execute the slow 20 MiB cancellation scenario. The response appeared canceled and the UI recovered temporarily, but the application later crashed. Available fixture-server byte logs also contained Yaak/other-client traffic and were not treated as attributable Purr measurements.
- [x] On completed JSON responses up to 1 MiB, verify Pretty, jq `.meta.fixture`, search for `purr-tail-marker`, and download; all returned the expected results/payload.
- [x] Verify the 40-type GraphQL fixture and record responsiveness plus schema search, autocomplete, and hover behavior. All passed; observed RSS was 161.7 MiB native and 543.3 MiB WebView. The 1,200-type schema also worked without a reported issue.

Implementation notes:
- Added deterministic synthetic response and GraphQL generators, a local streaming fixture server, and a manual desktop measurement procedure under `tests/performance/` and `scripts/performance/`.
- Saved the current full-copy Node baseline in `tests/performance/baseline-current.md`; the 100 MiB case peaked at 912.5 MiB RSS on the recorded machine and demonstrates the retained source/base64/decoded/parsed/formatted representations.
- Extracted jq/JSONPath behavior into a reusable versioned JSON fixture and added a native compatibility test for the current 20 MiB + 1 byte rejection.
- Performance values are observational only. Normal CI tests assert deterministic fixture shape and compatibility semantics without RSS or timing thresholds.
- Product-owner desktop testing recorded a 1–2 second UI stall at 1 MiB, an unrecoverable UI hang/reported crash at exactly 20 MiB, a later crash after canceling the slow 20 MiB response, and correct handling of the 20 MiB + 1 byte limit error.
- Small completed JSON operations and the 1,200-type synthetic GraphQL schema remained functional. Exact timing/RSS and detailed editor-operation observations were not captured for the 1,200-type run; the 40-type run was measured separately below.
- Clean-state measurements recorded 134.2/218.0 MiB native/WebView RSS at idle, 153.6/279.0 MiB after the responsive sub-100-ms 100 KiB response, and 161.7/543.3 MiB during the successful 40-type GraphQL workflow.
- Workspace loading was noticeably prolonged after the earlier large-response/crash tests. The cause was not isolated in this measurement phase.
- The 100 MiB desktop request was deliberately not repeated after the 20 MiB boundary caused an unsafe hang/crash. Its representation-cost baseline is recorded by the separate 100 MiB Node run; this is not a missing acceptance check.

Deviations from plan:
- None.

Known follow-ups:
- Later response phases must preserve a diagnostic case for the post-cancellation crash and distinguish native process failure, WebView failure, and an indefinitely blocked UI. Multi-client fixture-server logs must not be attributed to Purr without a unique request/run identifier.
- Investigate the large WebView RSS increase during the successful 40-type GraphQL workflow and the prolonged workspace loading observed after large-response/crash tests; do not assume causality until history/local-state and WebView recovery paths are measured separately.
- Later response phases must rerun the same baseline on the same machine/build mode; the recorded Node values must not become CI thresholds.

- **Objective:** establish the current behavior and memory baseline before choosing thresholds.
- **Files/modules affected:** `tests/response.test.ts`, native HTTP tests, a new performance fixture/runner under `tests/performance/` or `scripts/`; response/request/GraphQL docs.
- **Changes:** add deterministic synthetic bodies at roughly 100 KiB, 1 MiB, 20 MiB, and 100 MiB; record native RSS, WebView RSS, time to headers, time to first visible page, completed download time, search time, pretty/query time, and cancellation latency. Extract current jq/JSONPath cases into reusable conformance fixtures. Record representative small/large GraphQL introspection samples without real service data.
- **Risk:** performance tests can be noisy. Keep hard correctness assertions separate from benchmark reports and compare broad memory/latency budgets rather than millisecond snapshots.
- **Verification:** current unit/UI/Rust suites still pass; baseline report reproduces the current 20 MiB rejection and shows the known base64/string copies.
- **Scope:** S–M, one PR. It should touch little production code.

### Phase 1 — stabilize repository and dependency rules

Status: DONE

Implemented in: `ce48ae1`.

Started: 2026-09-15

Completed: 2026-09-15

Automated verification:
- [x] Run `npm ci` in a clean detached worktree using npm 11.16.0; 408 packages installed, audit reported zero vulnerabilities, and the resulting lockfile was byte-identical to the prepared Phase 1 lockfile.
- [x] Run `npm run check:repo`, `npm test` (120), `npm run test:ui` (51), `npm run typecheck`, `npm run lint`, `npm run build`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test` (37).
- [x] Run an OSS Tauri development/build smoke check using only public configuration: `tauri dev` launched with an ad-hoc signature and no TeamIdentifier; an unsigned release `Purr.app` bundle built successfully with `--no-sign --ci`.

Manual verification:
- [x] Launch the OSS build without any private dependency. A clean detached checkout installed and built with npm only; the product owner confirmed the resulting dev configuration launches and operates normally.
- [x] Open an existing current-format workspace, send REST and GraphQL requests, restart Purr, and confirm workspace/request/schema state restores; all passed.
- [x] Inspect and enforce the public Tauri configuration: no developer signing identity or release credential is present, repository policy passes, and the owner observed no signing-related runtime failure.
- [x] Save and use a secret-backed value in the ad-hoc-signed macOS dev build, restart, and confirm it remains usable without entering project YAML; passed.

Implementation notes:
- npm 11.16.0 is declared as the only supported JavaScript package manager. Yarn lock/config/install state were removed without changing dependency versions; `package-lock.json` changed only for the reserved package name.
- Tauri hooks now invoke npm. Public Tauri config contains no signing identity; the macOS dev runner uses ad-hoc signing unless `PURR_DEV_SIGNING_IDENTITY` is supplied locally.
- The root reserves `@purr/core@0.1.0` but remains private and exposes no supported library paths until Phase 15 adds the reviewed exports.
- ESLint now protects the current domain/application boundaries and reserves rules for future platform/extension API paths. `src/application/import-workspace.ts` remains the one explicit legacy Tauri exception until Phase 3.
- Added a repository policy check for package identity, npm-only artifacts, lock metadata, public registry URLs/credentials, and signing config; public macOS CI runs the full check/test/build set and produces an unsigned OSS `.app` bundle.
- Existing Vite large-chunk/Zod annotation warnings and npm's deprecation warning for the locked ESLint 9.39.5 package remain non-blocking; dependency upgrades are outside this phase.
- Product-owner smoke testing found no Phase 1 functional regression in REST, GraphQL, restart, workspace persistence, or secret/YAML handling.
- Existing app data produced multi-second UI stalls when saving a document or variable after the large-response stress tests; renaming the app-data directory and starting clean restored normal performance. Code inspection supports a persistence-amplification hypothesis: every store edit persists all workspaces and synchronously compares local records with `JSON.stringify`, while restored/in-session execution records carry full response `text` and `bodyBase64`. SQLite encryption/loading may add cost, but the root-cause share has not been profiled.

Deviations from plan:
- None.

Known follow-ups:
- Upgrade the existing ESLint dependency in a separate dependency-maintenance change after verifying compatibility; do not combine it with architecture migration.
- Phase 3 removes the direct Tauri imports currently owned by feature/application modules, including the documented `import-workspace.ts` lint exception.
- Phase 15 implements the reserved `./app`, `./extension-api`, and `./styles` package exports and external-shell conformance checks.
- The first pushed commit must exercise the new GitHub workflow; local equivalents and the unsigned OSS bundle pass, but the hosted runner has not executed it yet.
- Phases 5–9 must profile and eliminate full response bodies from frontend persistence snapshots/change detection. Measure WebView serialization separately from SQLite encryption/write and workspace-load decryption before assigning the slowdown to the database alone.

- **Objective:** make the public repo a deterministic dependency before introducing extension code.
- **Files/modules affected:** `package.json`, lockfiles, `src-tauri/tauri.conf.json`, ESLint config, CI skeleton, architecture docs.
- **Changes:** choose npm, update Tauri build commands to npm, remove Yarn state/lock/config after a clean install comparison, add import restrictions, remove template `greet`, move developer signing identity out of checked-in config, define OSS package name/version/export intent.
- **Risk:** lockfile changes can update transitive packages. Pin existing resolved versions first; do dependency upgrades separately.
- **Verification:** clean clone install, unit/typecheck/lint/build, `cargo test`, OSS `tauri dev` and build smoke test.
- **Scope:** S, one PR.

### Phase 2 — split stable HTTP exchange contracts from feature services

Status: DONE

Implemented in: Phase 2 working tree on `architecture-migration`, based on `ce48ae1`.

Started: 2026-09-15

Completed: 2026-09-15

Automated verification:
- [x] Run response, GraphQL, dynamic-variable, persistence, and UI coverage with synthetic v1 inline and v2 response-reference contracts: `npm test` passed 123 tests and `npm run test:ui` passed 51 tests. A local smoke request to the new `/graphql/result` verification endpoint returned the expected `data`, `errors`, and `extensions` envelope.
- [x] Run `npm run typecheck`, `npm run lint`, and `npm run build` after removing service-owned HTTP types from runtime model imports; all passed. `npm run check:repo` also passed.
- [x] Add restore fixtures proving a pre-migration local execution opens without data loss. TypeScript restore/reprojection tests preserve both fixtures; `cargo test` passed 38 tests, including native v2 descriptor/history round-trip. `cargo fmt --all -- --check` and `cargo clippy --all-targets -- -D warnings` passed.

Manual verification:
- [x] Launch Purr with a workspace created before the phase, open a request with a saved last response, and confirm its status, headers, body, and Timeline values match the pre-phase data.
- [x] With `npm run fixture:responses` running, send `GET http://127.0.0.1:43119/response/json?size=102400`; use Pretty, Raw, Hex, and Base64, restart Purr, reopen the request, and confirm the same response remains available.
- [x] Create a GraphQL request to `http://127.0.0.1:43119/graphql/result` with query `{ fixture }`; confirm Response/Data shows `purr-v1`, Errors shows `Synthetic partial result`, and Extensions shows `purr-extension`.

Implementation notes:
- `src/domain/http.ts` now owns `HttpRequestSnapshot`, response metadata, timeline, opaque `ResponseContentRef`, versioned `HttpExchange`, and the transitional `InlineHttpResponse` shape.
- Runtime workspace/history accepts validated v1 inline and v2 reference responses. Invalid execution records are ignored so an isolated damaged response cannot prevent its workspace from opening.
- Current transport and response viewers still use the inline compatibility shape. The native HTTP command, body limit, response parsing, rendering, and request behavior are unchanged.
- Synthetic fixtures contain only `fixture.invalid`, loopback addresses, deterministic payloads, and opaque test IDs.
- Product-owner verification confirmed legacy response restoration, all REST response representations after restart, and GraphQL Data/Errors/Extensions behavior with no observed regression.

Deviations from plan:
- `src-tauri/src/local_state.rs` received a minimal compatibility branch although the initial affected-files list emphasized TypeScript. This was necessary because native persistence otherwise extracted null inline body fields from v2 descriptors and failed to index their nested status, corrupting the contract during a real desktop round trip. No storage schema, command, or content-engine behavior was added.

Known follow-ups:
- The transitional inline adapter remains until Phase 6 replaces desktop body IPC.
- V2 content references are preserved by workspace persistence but are not materialized by the current response UI; Phase 3 introduces the content port and Phase 6 begins returning native references.
- The large inline response persistence/amplification issue observed after stress tests remains assigned to Phases 5–9; Phase 2 does not change response memory ownership or performance.

- **Objective:** stop treating `services/http-client.ts` and `HttpResult` as the public data model.
- **Files/modules affected:** new `src/domain/http.ts`; `http-client.ts`; request-workbench response consumers; project projection/history tests.
- **Changes:** introduce provider-neutral HTTP metadata/timeline types and a transitional `ResponseContentRef`. Keep a compatibility adapter that can wrap the existing inline `{text, bodyBase64}` response, so no UI changes are required yet. Remove service-layer types from runtime model exports.
- **Risk:** response history and tests construct `HttpResult` directly. Use fixture builders and tolerate both v1 inline and v2 ref descriptors while migrating.
- **Verification:** existing response, GraphQL, dynamic-variable, persistence, and UI tests pass unchanged in behavior; old local state restores.
- **Scope:** M, one PR.

### Phase 3 — add frontend ports and the OSS composition root

Status: DONE

Implemented in: Phase 3 working tree on `architecture-migration`, based on `27cc0a8`.

Started: 2026-09-15

Completed: 2026-09-15

Automated verification:
- [x] Added import-boundary tests proving domain/application/feature modules do not import `@tauri-apps/*` and `invoke()` calls stay inside `src/platform/tauri`.
- [x] Verified memory adapters can be installed through the application-services context; the complete 51-test Playwright suite passed with browser persistence and mocked desktop adapters.
- [x] Added composition tests proving core plus future route descriptors are validated and frozen, duplicate IDs/paths fail, and the shared router remains the renderer.
- [x] `npm test` passed 127 tests; `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run check:repo` passed. `cargo test` passed 38 tests; `cargo fmt --all -- --check` and `cargo clippy --all-targets -- -D warnings` passed.

Manual verification:
- [x] Launch the browser development build and create, save, reopen, and delete a workspace using the browser persistence adapter (product-owner verified 2026-09-15).
- [x] Launch desktop Purr, open an existing workspace, switch environment, send `/cookies/set` then `/cookies/echo` from the synthetic fixture server, and verify the echo body contains `purr-phase3=ok`, the cookie and latest response persist across restart, and normal responses still work (product-owner verified 2026-09-15).
- [x] From desktop Purr, use the workspace location action and confirm the project directory opens in Finder; import `tests/fixtures/openapi-phase-3.yaml` through the native file dialog and confirm its workspace/request survives restart (product-owner accepted 2026-09-15; import, generated base URL, and `/health` request explicitly verified).
- [x] Start OAuth authorization for a test provider/local callback, cancel it, and confirm the app returns to the request editor without a stuck authorization state (product-owner accepted 2026-09-15; system browser opener explicitly verified).

Implementation notes:
- Added application-owned HTTP/content/persistence/credential/platform ports and one `ApplicationServices` context at the shell.
- Centralized browser/desktop selection in `core-services`; moved Tauri command strings, command DTO use, persistence, secure-store, OAuth callback, import, download, dialog, folder, and lifecycle calls into the Tauri platform adapter.
- `createPurrApp` now installs services and renders a validated immutable route composition. Phase 12 registration remains unimplemented.
- The first UI run exposed a synchronous `getCurrentWindow()` failure in the mocked desktop environment. Restoring the previous asynchronous catch boundary fixed startup; the subsequent full 51-test UI run passed.
- Added deterministic local cookie set/echo fixture endpoints because the original response fixtures intentionally emitted no cookie headers, so they could not validate this desktop scenario.
- Product owner accepted the completed manual verification on 2026-09-15. No blocking regression was reported.

Deviations from plan:
- `storage/native-backend.ts` remains as a compatibility re-export and browser IndexedDB persistence remains implemented in `storage/browser-backend.ts`; actual platform selection and every Tauri call are centralized. This avoids an unrelated mechanical file move before Phase 4 while preserving one implementation of each backend.

Known follow-ups:
- `ResponseContentPort` is deliberately unavailable in both adapters until Phase 5 implements encrypted native content ownership; current inline responses still use the existing download port.
- Phase 12 exposes route/page/document registries; this phase only makes the public shell and router accept immutable validated composition inputs.

- **Objective:** centralize platform selection and make private composition possible without adding private code.
- **Files/modules affected:** `src/app/create-purr-app.tsx`, `src/app/composition/*`, `src/application/ports/*`, `src/platform/{tauri,browser}/*`, current `src/storage/native-backend.ts`, direct Tauri callers.
- **Changes:** define `HttpTransportPort`, `ResponseContentPort`, `PersistencePort`, `CredentialResolver/SecureStore`, OAuth/import/download ports; adapt existing implementations; pass a service object through app context/hooks. Move Tauri command strings and DTOs into one platform boundary. `App.tsx` calls the public factory with core modules. Make the shell/router consume immutable composition inputs so Phase 12 can add namespaced pages without replacing `AppRouter`.
- **Risk:** a giant prop-drilling refactor. Use one typed application-services context at the shell, not a DI container and not service parameters on every leaf.
- **Verification:** browser tests inject memory adapters; a guard test fails if feature/domain code imports `@tauri-apps/*`; desktop behavior remains unchanged.
- **Scope:** M–L; split into platform centralization and shell wiring if the diff exceeds a comfortable review.

### Phase 4 — mechanically modularize the Rust crate

Status: DONE

Implemented in: Phase 4 working tree on `architecture-migration`, based on `f5f8362`.

Started: 2026-09-15

Completed: 2026-09-15

Automated verification:
- [x] Added a command-registration guard for the unchanged 21 IPC command names and verified the command attribute stays in `commands/` or the intentionally flat OAuth boundary.
- [x] Ran `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test` (38 tests), plus 129 TypeScript tests, 51 Playwright tests, typecheck, lint, build, and repository policy.
- [x] Ran existing Rust regression coverage for HTTP transport, OpenAPI import, encrypted persistence/secret vault, legacy migration, OAuth callback validation, and safe project-file paths.

Manual verification:
- [x] Launch Purr, open an existing workspace, send a REST request, and confirm headers, cookies, redirects, and response download behavior are unchanged (product-owner verified 2026-09-15).
- [x] Import an OpenAPI file, folder, URL, and pasted text fixture; confirm the resulting workspace opens and persists normally (product-owner verified 2026-09-15).
- [x] Attach or open a project directory, edit a request, save it, modify it outside Purr, and confirm the existing reload/change behavior still works (product-owner verified 2026-09-15).
- [x] Start and cancel an OAuth authorization attempt and confirm the loopback callback workflow remains available (product-owner verified 2026-09-15).

Implementation notes:
- Moved the native sources into `commands/`, `http/`, `importing/`, `persistence/`, and `security/`; `composition.rs` now owns the builder, managed state, plugins, and the registered command list.
- HTTP transport, import normalization, local encrypted records, canonical project files, legacy retirement, and security retain their existing implementations and tests. Command names, serde DTOs, local database schema, and product behavior were not intentionally changed.
- `commands/http.rs`, `commands/importing.rs`, `commands/persistence.rs`, and `commands/response.rs` are now the Tauri command adapters. OAuth remains intentionally flat as specified by the target architecture.
- Product owner completed the required desktop smoke verification on 2026-09-15; no blocking regression was reported.

Deviations from plan:
- The internal implementation of the existing large import and persistence coordinators remains co-located as `importing/mod.rs` and `persistence/runtime.rs`. Splitting their private helpers into the future `source`/`references`/`openapi`/`project` and watcher/journal/migration files would create a much larger move-only diff with no new boundary exposed to callers. The capability boundaries and thin command adapters are in place; split those internals only when the Phase 5 content store or a later import change gives each resulting file an independent owner.

Known follow-ups:
- Behavior changes to HTTP/content storage belong to Phases 5–9, not to mechanical move commits.
- Record the implementation commit reference when this working-tree phase is committed.

- **Objective:** create cohesive native boundaries before adding the content engine.
- **Files/modules affected:** all current `src-tauri/src/*.rs` modules, without intentional behavior/schema changes.
- **Changes:** move HTTP, import, persistence, project-files, legacy, and security code into the target capability modules; make commands thin; keep `oauth.rs` flat; preserve command names and serde shapes. Split `importing.rs` and persistence files along the mapping in section J.
- **Risk:** noisy moves collide with feature work and hide logic changes. Use move-only commits followed by visibility/import cleanup; do not combine with new response behavior.
- **Verification:** identical registered command list, all 36+ Rust tests pass, `cargo fmt --check`, `cargo clippy`, desktop smoke test.
- **Scope:** L mechanically, preferably 3 sequential PRs: import split, persistence/security split, command/composition split.

### Phase 5 — implement encrypted native response content storage

Status: DONE

Implemented in: Phase 5 working tree on `architecture-migration`, based on `c430458`.

Started: 2026-09-15

Completed: 2026-09-15

Automated verification:
- [x] Rust tests cover the v3-to-v4 schema migration with an existing inline response body, staging/finish, atomic execution adoption and rollback, execution/workspace deletion, expiry cleanup, quota/20 MiB limits, and reads spanning encrypted chunk boundaries.
- [x] Rust tests cover ciphertext tampering, chunk-position/reordering metadata changes, missing chunks, response-key domain separation, and absence of a synthetic plaintext marker in SQLite.
- [x] `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test` passed (46 tests). `npm test` passed 129 tests; `npm run test:ui` passed 51 tests; typecheck, lint, build, and repository policy passed.

Manual verification:
- [x] Open a workspace created before the migration, open a saved response/history entry, restart Purr, and confirm the body is still readable (product-owner verified 2026-09-15).
- [x] Send an ordinary response under the current inline limit; verify Pretty, search, download, and persistence after restart still behave as before (product-owner verified 2026-09-15).
- [x] Edit and save a document or variable, restart Purr, and confirm the change persists after the SQLite v4 migration (product-owner verified 2026-09-15).
- [x] Confirm the normal desktop workflow completes without a migration error or a blocking regression (product-owner verified 2026-09-15).

Implementation notes:
- Added SQLite schema version 4 with `response_contents` metadata and cascading `response_content_chunks`. Content uses explicit `staging`, `ready`, and `adopted` states and a one-hour cleanup deadline while unowned.
- Added a dedicated response-content HKDF key, 256 KiB maximum encrypted chunks, per-chunk AAD, a 256 KiB read window, and the existing 20 MiB response ceiling. Aggregate retention quota remains unset until measured; tests exercise the configurable quota path.
- Added a dedicated blocking SQLite worker with a bounded async call surface. Phase 6 can feed its writer without running rusqlite or AES-GCM work on the HTTP task.
- Added bounded inspect/range/line IPC commands and a Zod-validating Tauri `ResponseContentPort` adapter. Search, format, query, handle-based save, and HTTP capture remain assigned to later phases.
- Persisting a locally known v2 content reference atomically adopts it with its execution. Existing opaque v2 descriptors without a local content row remain round-trippable for Phase 2 compatibility.
- Updated architecture, response-lifecycle, and persistence documentation for the new native boundary.

Deviations from plan:
- The original manual checklist included interrupted native capture and UI deletion of handle-backed history. Phase 5 deliberately does not switch HTTP/UI to handles, so those scenarios cannot produce content rows yet without adding test-only product commands. The Phase 5 checklist therefore verifies migration and inline-regression behavior; the handle-backed scenarios are assigned to Phase 6. Automated store-level tests cover the Phase 5 crash/cleanup and deletion invariants.

Known follow-ups:
- Phase 6 switches transport to these references; preserve the current preview limit until that isolated transport change is verified.
- Phase 6 must manually verify interrupted native capture, handle-backed history deletion, and no readable partial content after a restart.

- **Objective:** make Rust able to own a response incrementally without a complete in-memory body.
- **Files/modules affected:** new Rust `content/*`, `persistence/response_bodies.rs`, `security/cipher.rs`, DB migration, thin response commands, TS `ResponseContentPort` adapter.
- **Changes:** add content metadata/chunk tables, a response-content HKDF key, 256 KiB independently encrypted chunks, staging/adopt/release/cleanup lifecycle, range and line-page reads, quota/TTL state, and typed DTO validation. Preserve current `response_bodies` reads and migrate lazily or transactionally; never make v1 data prevent startup.
- **Risk:** migration correctness, SQLite write contention, WAL growth, crash cleanup, corrupted individual chunks. Use WAL-aware bounded transactions, foreign keys, per-chunk AAD, explicit `state`, and corruption tests. Do not delete v1 data until v2 has verified reads.
- **Verification:** interrupted writes leave no readable partial result; tampered/reordered chunks fail closed; staging cleanup is deterministic; ranges cross chunk boundaries correctly; old execution bodies load; no plaintext body appears in DB or temporary files.
- **Scope:** L, likely two PRs: store/migration then application adapter.

### Phase 6 — switch native HTTP to response handles and real cancellation

Status: DONE

Implemented in: Phase 6 working tree based on `b9724b0`

Started: 2026-09-15

Completed: 2026-09-15

Automated verification:
- [x] Add native transport tests proving completion IPC contains metadata/content reference and no complete `bodyBase64`.
- [x] Add cancellation race tests for cancel-before-headers, cancel-during-download, complete-while-canceling, and redirect cleanup.
- [x] Run HTTP, cookie/redirect, binary payload, persistence, TypeScript build/type/lint, and Rust fmt/clippy/test checks.

Manual verification:
- [x] Run `npm run fixture:responses`; first complete `/response/json?size=102400`, then change the same request to `/response/json?size=20971520&chunkSize=65536&delayMs=25`. Confirm the pending message reports downloaded MiB, press Escape mid-download, and confirm the UI returns to the prior completed response while the fixture server logs fewer than 20,971,520 sent bytes (product-owner verified 2026-09-15).
- [x] After that cancellation, wait for “Saved locally”, restart Purr, reopen the request, and confirm the prior 102,400-byte response is restored rather than the cancelled response (product-owner verified 2026-09-15).
- [x] Add a manual `Authorization` header and query API-key auth named `api_key`, send `/redirect/cross-origin`, and confirm the final JSON contains `authorization: null`, `apiKey: null`, and no cross-origin cookie; then send `/cookies/echo` on `127.0.0.1` and confirm `purr-redirect=kept` was retained for the original origin (product-owner verified 2026-09-15).
- [x] Send `/response/binary?size=102400&cookies=repeated`; confirm status/protocol/duration/size are present, both `purr-binary-first` and `purr-binary-second` appear in Cookie, and Download writes a 102,400-byte file (product-owner verified 2026-09-15).
- [x] Send `/response/json?size=1048576`, verify Pretty and search for `purr-tail-marker`, wait for “Saved locally”, restart Purr, reopen the same request, and confirm the response is readable with the same status, size, and marker through its persisted content reference (product-owner verified 2026-09-15).
- [x] Send a GraphQL request to `/graphql/result` and confirm Data, Errors, and Extensions still render; load `/graphql/introspection?types=40` into a schema and confirm schema search/autocomplete still work (product-owner verified 2026-09-15).
- [x] Configure OAuth Client Credentials with token URL `http://127.0.0.1:43119/oauth/token`, any synthetic client ID/secret, obtain the token, and confirm the Auth UI shows `purr-fixture-access-token` without a transport/content error (product-owner verified 2026-09-15).

Implementation notes:
- Replaced `send_http` with operation-scoped `start_http`/`cancel_http`. Rust observes cancellation before headers, during network reads, and while backpressured chunk writes are pending; operation cleanup is idempotent and bounded cancellation tombstones cover cancel/start command ordering.
- Native capture writes 256 KiB batches through an eight-job async queue to the existing encrypted content worker. Header/progress events are coalesced by 100 ms or 1 MiB, completion carries only metadata and `ResponseContentRef`, and the 20 MiB compatibility ceiling remains enforced.
- The TypeScript use case retains redirect, credential-masking, cookie, and timeline policy. It releases every intermediate redirect handle and materializes only the final handle through 192 KiB range reads for the current viewer. `projectWorkspace` strips that presentation and persists/adopts the v2 exchange, so body text/base64 is not duplicated in new desktop execution records.
- Added synthetic cross-origin redirect, repeated-cookie binary, and OAuth token fixtures for the manual checklist. Updated request, response, persistence, and system architecture documentation.
- Automated verification passed: `npm test` (132), `npm run test:ui` (51), `npm run typecheck`, `npm run lint`, `npm run build`, `npm run check:repo`, `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test` (51).
- Product owner accepted every manual Phase 6 scenario on 2026-09-15. No blocking regression was reported.

Deviations from plan:
- None.

Known follow-ups:
- Phase 7 removes the transitional full inline presentation for large responses; this phase deliberately retains the current 20 MiB capture/viewer behavior while eliminating the complete HTTP body from completion IPC and Rust memory.
- Phase 9 replaces the inline download round trip with direct handle-based save. Until then the compatibility viewer keeps current download/media behavior.

- **Objective:** remove response base64 from desktop IPC and stop network work when the user cancels.
- **Files/modules affected:** Rust `http/*`, `commands/http.rs`, `commands/response.rs`; TS Tauri HTTP adapter and execute flow.
- **Changes:** add request operation ID, `start_http`/`cancel_http`, cancellation token map, header/progress/completion channel, encrypted chunk append, `ResponseContentRef` completion result, and release of intermediate redirect bodies. Keep redirect/cookie/security policy in the TypeScript execute use case. Preserve the 20 MiB cap in this phase to isolate the contract change.
- **Risk:** races between completion/cancel/release, leaked handles, redirects retaining bodies, progress flooding. Make operation state transitions idempotent, coalesce progress, and give the content store sole ownership of cleanup.
- **Verification:** desktop response IPC contains no `bodyBase64`; cancel aborts reqwest and chunk writes; redirect bodies are released; repeated headers/timings/binary bytes remain correct; memory no longer scales by multiple full-body copies.
- **Scope:** L, one focused PR after Phase 5.

### Phase 7 — add bounded/virtualized response presentation

Status: DONE

Implemented in: Phase 7 working tree on `architecture-migration`, based on `7e3492c`.

Started: 2026-09-15

Completed: 2026-09-16

Automated verification:
- [x] UI coverage proves the existing small-response Pretty/query/context-action path and the bounded byte-page path remain separate, including a compact legacy-inline JSON scalar preview, the exact 1 MiB native boundary, Response-tab reopening, and request-processing diagnostics.
- [x] Synthetic 100 MiB coverage proves aligned first/middle/last page reads, repeated previous/next search navigation, and restart restoration never construct a full-body JavaScript string; native transport tests cover pipelined encrypted capture, cancellation, size failure, and fail-closed plaintext policy.
- [x] TypeScript tests (137), full UI tests (54), Rust tests (54), typecheck, lint, production build, repository policy, Rust fmt/clippy, and diff checks passed after the exact-boundary correction on 2026-09-16.

Manual verification:
- [x] Run `npm run fixture:responses`, send `/response/text?size=104857600`, and confirm the initial page contains `purr-synthetic-start`; move the Response position control near the middle and confirm `purr-middle-marker`; click Last and confirm `purr-tail-marker`. The UI must remain responsive during each jump (product-owner accepted Last/navigation and no-freeze behavior 2026-09-16).
- [x] In that 100 MiB response press Cmd/Ctrl+F, search for `purr-tail-marker`, and confirm the counter reaches `1/1`; click Previous and Next and confirm the tail page remains selected without a freeze or growing list of loaded pages (product-owner accepted search navigation 2026-09-16).
- [x] Send a JSON response smaller than 1 MiB; confirm Pretty, Raw, copy, jq `.meta.fixture`, field context actions, and Download still work without a UI freeze. Send `/graphql/result` and confirm Data, Errors, and Extensions still render (product-owner accepted functional behavior and no-freeze result 2026-09-16; compact-preview presentation quality is a non-blocking follow-up).
- [x] In a freshly rebuilt `npm run tauri dev`, repeat a small REST request, `/response/text?size=1048576`, a tiny GraphQL response twice, and the 100 MiB response. Confirm the exact 1 MiB response immediately opens the bounded viewer, then switch Headers → Response and verify the application does not freeze. Inspect Timeline diagnostics and confirm background storage does not freeze navigation (product-owner accepted the corrected exact-boundary behavior on 2026-09-16; a 999 KiB one-line response still reproduces the CodeMirror layout stall and is explicitly assigned to Phase 8).
- [x] Wait for “Saved locally” on the 100 MiB response, restart Purr, reopen the request, and confirm the bounded viewer opens at the first page; click Last and confirm the tail marker, then verify Headers, Timeline, Request, status, and 100 MiB size remain available. While jumping between pages, confirm WebKit RSS does not grow continuously with every visited position (product-owner accepted this checklist item 2026-09-16).

Implementation notes:
- Native responses smaller than 1 MiB retain the existing `InlineHttpResponse`/CodeMirror behavior. Responses at or above 1 MiB remain `HttpExchange` values in request sessions and after restoration; `WorkspaceWorkbench` no longer materializes them during load. The exact boundary was moved to the bounded path after diagnostics showed native work completed in 42 ms but a one-line 1 MiB text body blocked CodeMirror/WebView layout for about one second on initial display and every Response-tab reopen.
- Added a read-only 192 KiB byte-window viewer with text, hex, and base64 modes; first/previous/position/next/last navigation; bounded temporary TypeScript search; and an explicit disabled full-body Copy action. Only the current page and bounded search match metadata are retained.
- Raised native transport/content capture limits from 20 MiB to 128 MiB so the 100 MiB validation case can complete. Streaming, encrypted 256 KiB storage chunks, cancellation, and response-handle IPC remain unchanged.
- Added deterministic `purr-middle-marker` content to synthetic text/JSON/NDJSON fixtures. No private or working data is present.
- Updated architecture, request lifecycle, response lifecycle, persistence, and performance-fixture documentation.
- Product-owner testing confirmed the 100 MiB response no longer freezes the UI and restart restoration works, but exposed snake_case progress events (`NaN MiB`), ~15.9 s debug capture, a repeated-search/last-page alignment defect, and a visible 1 MiB CodeMirror stall. Those blocking Phase 7 findings were corrected and retested; the distinct 999 KiB pathological-line limitation is accepted for Phase 8.
- Corrective implementation serializes progress fields in camelCase and runtime-validates them, uses 8 MiB storage batches with reconstructible response content on WAL `synchronous=NORMAL`, optimizes the Rust dev hot path, scans through 4 MiB text windows, aligns the final/search page, performs one bounded materialization read for responses smaller than 1 MiB, and shortens large JSON scalars only in the default Pretty preview.
- The 128 MiB capture regression improved from approximately 14 seconds to 1.22 seconds in the optimized dev test profile; this is diagnostic evidence, not a CI timing threshold.
- Follow-up product-owner testing accepted the corrected loader, Last navigation, repeated tail search, and non-freezing 1 MiB response. The first GraphQL request still took up to one second, later GraphQL requests about 200 ms, and ordinary local responses remained perceptibly slower at roughly 400 ms than other clients; elapsed-time semantics were also misleading.
- Response encryption/SQLite writes now form a bounded two-batch native pipeline that overlaps network reads. Completion still requires a readable handle, but history/workspace adoption remains asynchronous and never blocks the response UI. The response summary reports network time, while Timeline exposes native setup, network, encryption, SQLite, storage backpressure, IPC, content read/decrypt/decode, and response-ready diagnostics.
- Product-owner diagnostics for the problematic exact 1 MiB text response reported 4.0 ms network, 7.5 ms encryption, 2.4 ms SQLite write, 9.9 ms storage backpressure, 5.0 ms IPC, 22.0 ms read/decrypt/decode, and 42.0 ms response-ready time. The remaining approximately one-second freeze therefore occurred in frontend presentation, where CodeMirror with line wrapping synchronously laid out a nearly one-million-character line. The exact 1 MiB native boundary now stays on the existing byte-window viewer; no additional virtualization dependency is justified.
- Added an application-owned response-storage policy resolver with document-over-nearest-folder-over-workspace precedence and encrypted default. The preference is reserved for local settings, never project YAML; the current product sends encrypted and the native boundary rejects plaintext until mixed-mode storage is deliberately implemented. Secrets remain encrypted independently of this future policy.

Deviations from plan:
- Large GraphQL Data/Errors/Extensions extraction and dynamic-variable querying through `ResponseContentPort` remain in Phase 8. The existing port reserves native `format`/`query` but does not implement them yet; implementing those operations here would pull Phase 8 forward. Phase 7 instead keeps small responses unchanged and fails GraphQL introspection, OAuth token, or dynamic-variable body consumers at or above 1 MiB with a bounded, explicit error rather than materializing the body.
- Product-owner performance feedback pulled bounded background write pipelining, request-stage diagnostics, and the response-storage policy contract into Phase 7. The actual plaintext store format and settings UI remain postponed; enabling them here would require a new persistence migration and security UX beyond the requested foundation.
- The original threshold allowed exactly 1 MiB into CodeMirror. It was changed to an exclusive inline limit after the exact-boundary fixture reproduced a presentation freeze. This is a boundary correction rather than a new architecture: the same `HttpExchange`, `ResponseContentPort`, and `LargeResponseViewer` path is used, while Phase 8 remains responsible for restoring Pretty/query operations to bounded bodies.

Known follow-ups:
- Phase 8 replaces the temporary bounded TypeScript search with native search and adds bounded formatting/query extraction for large JSON/GraphQL/dynamic-variable consumers.
- Phase 9 adds direct handle-based download; full-body copy/download remain unavailable in the large viewer until a bounded native operation exists.
- Phase 8 should still move search into Rust to eliminate remaining text-window IPC and provide encoding-correct native matching; the Phase 7 scanner is a bounded compatibility implementation.
- A future response-protection feature must persist workspace/folder/document preferences as local settings, add a versioned plaintext chunk representation beside encrypted chunks, migrate/clean mixed content safely, and preserve unconditional encryption for credentials, cookies, OAuth tokens, and secret-backed values.
- Phase 8 must replace the total-size-only presentation decision with native content hints that include the longest observed line. A response below 1 MiB can still freeze CodeMirror when nearly all bytes form one line; the product owner accepted this as a non-blocking Phase 7 limitation on 2026-09-16.
- Phase 8 must revise `LinePage.lines: string[]` before treating it as stable API. A logical line may exceed the IPC/window limit, so Rust must return bounded line segments with byte offsets, logical line identity, continuation flags, and cursors instead of rejecting the page or returning one unbounded string.

- **Objective:** keep WebView memory proportional to the visible response rather than total content.
- **Files/modules affected:** split `response-viewer.tsx`; `response-code-viewer.tsx`; new response content hooks/viewer; GraphQL response panels; dynamic variable resolver.
- **Changes:** retain CodeMirror for native content smaller than 1 MiB; use a read-only line/byte virtualized viewer at or above that boundary; request pages through `ResponseContentPort`; show loading/progress/complete state; make Copy full body an explicit streamed native/clipboard operation or disable it above a safe limit with a clear action. GraphQL errors/extensions use bounded/native extraction for large bodies. Dynamic variables query through the response port when their dependency returns a native ref.
- **Risk:** cursor/search/context-menu behavior differs between viewers. Define shared line/match/field-action models and e2e tests before replacing the large path.
- **Verification:** 100 MiB text can show first/last pages without a 100 MiB JS string; scrolling does not grow unbounded; small-body visual behavior remains the same; browser/mock adapter passes tests.
- **Scope:** L, split into viewer extraction and large-viewer activation.

### Phase 8 — move large response inspect/search/format/query to Rust

Status: DONE

Implemented in: Phase 8 working tree based on `f58cbad`.

Started: 2026-09-16

Completed: 2026-09-16

Automated verification:
- [x] Run the shared jq/JSONPath conformance fixtures against both TypeScript and Rust implementations.
- [x] Add bounded-operation tests for search cancellation, invalid encoding, oversized query results, recursive selectors, JSON/XML/NDJSON formatting, and derived-content lifecycle.
- [x] Add native tests for a sub-threshold response containing one line larger than the line window and for a multi-million-line response; every returned row/segment and IPC page must remain within configured byte/count limits.
- [x] Add UI coverage proving content-aware routing keeps a 999 KiB pathological line out of CodeMirror, a virtualized multi-million-line response retains only visible rows plus bounded overscan in the DOM, and a segmented giant line never becomes one DOM text node.
- [x] Run response/UI/persistence tests plus `npm run typecheck`, `npm run lint`, `npm run build`, `cargo fmt --check`, `cargo clippy`, and `cargo test`.

Manual verification:
- [x] Start `npm run fixture:responses` and a freshly rebuilt `npm run tauri dev`; use the origin printed by the fixture server for every scenario below.
- [x] Request `/response/json?size=35651584`; run jq `.meta.fixture` and JSONPath `$.meta.fixture`, verify both return `purr-synthetic`, then switch Pretty/Raw/Hex/Base64 without an app freeze.
- [x] Request `/response/ndjson?size=35651584`; run JSONPath `$.fixture`, verify it returns `purr-synthetic`, then run Pretty and confirm the response remains pageable and responsive.
- [x] Request `/response/xml?size=20971520`; run Pretty, switch back to Raw and search for `purr-tail-marker`, confirming only bounded windows are rendered and the UI remains responsive.
- [x] On the 35,651,584-byte JSON response, run JSONPath `$..fixture` and confirm Purr shows the explicit full-tree-tier error rather than hanging or exhausting memory.
- [x] Create a GraphQL request to `/response/graphql?size=2097152`, send any valid query, and use Data, Errors, and Extensions. Confirm each native extraction shows respectively `purr-v1`, `Synthetic partial result`, and `purr-extension` without materializing the full envelope in CodeMirror.
- [x] Save an HTTP source request to `/response/json?size=2097152`; configure a Dynamic environment variable named `largeFixture` that uses this request with JSONPath `$.meta.fixture`, then use it in `/health?fixture={{largeFixture}}`. Confirm the dependent request resolves to `purr-synthetic` and the final health request succeeds.
- [x] Request `/response/text?size=104857600`; search for `purr-tail-marker`, enable Regex search and search for `purr-(middle|tail)-marker`, then begin another search and immediately close Find. Confirm cancellation leaves the existing response view usable.
- [x] Request `/response/text?size=1022976`; confirm the 999 KiB giant-line fixture selects the bounded viewer, remains responsive, renders bounded segments, and states that wrapping and full-document syntax highlighting are disabled.
- [x] Request `/response/lines?size=4000000`; use Next/Previous, move the position slider to the middle, and use Last. Confirm the two-million-line response remains responsive and the rendered DOM contains only visible rows plus bounded overscan rather than millions of elements.

The product owner confirmed all preceding functional scenarios passed, then reported UX issues (small typography, segment rows looking like wrapping, page controls, and an ineffective Regex control). The checkmarks above record that functional round; the previous navigation wording describes the accepted initial implementation. The product owner accepted the following UX correction round on 2026-09-16, with further visual polish explicitly deferred:

- [x] Request `/response/json?size=2097152` and `/response/json?size=10485760`: Pretty opens automatically, normal code font/syntax colors are used, `payload` occupies one shortened logical row, and `tail` remains visible. Click the hidden-byte action and confirm it explains the beta limitation; Raw/Pretty switching must remain responsive.
- [x] Request `/response/text?size=1022976`: the giant line occupies one shortened row with a visible hidden-byte button, without apparent wrapping. Verify the button remains reachable in a narrow split pane.
- [x] Request `/response/lines?size=4000000`: scroll down through successive windows; rows load automatically, DOM and retained row data stay bounded. After the buffer advances, Return to beginning restores the start.
- [x] On `/response/text?size=104857600`, open Find via the search icon, enable `.*`, enter `purr-(middle|tail)-marker`, and navigate both highlighted matches. Disable `.*` to confirm the same pattern is treated literally, then close Find during a new search.


Implementation notes:
- Native capture now records `lineCount` and `maxLineBytes`; a line at or above 64 KiB selects the bounded viewer even when total content is below 1 MiB. Old persisted handles need no schema migration because native `inspect` can derive missing hints through bounded reads.
- Initial `readLines` supplies bounded 16 KiB segments. The owner-requested UX correction adds `preview:` cursors returning logical rows with at most 96 prefix/32 suffix bytes and explicit `hiddenBytes`, scanning past long middles to preserve later fields. The viewer uses bounded lazy scrolling (3,000 retained rows), regular code typography, native default Pretty for JSON up to 10 MiB, and bounded visible-row syntax colors. Regex now lives in Find with native match byte lengths for highlights.
- Literal/regex search moved to Rust with 4 MiB windows, bounded matches, opaque cancellation IDs, and rejection of unbounded regexes. Closing response find cancels the active operation.
- JSON/XML/NDJSON Pretty and jq/JSONPath query operations run behind `ResponseContentPort`. Results above 256 KiB become temporary encrypted content references; UI cleanup releases derived handles.
- `jaq-core`/`jaq-std`/`jaq-json` implement the existing jq subset; `serde_json_path` implements the existing small-tree JSONPath subset; `serde_json`, `serde-transcode`, and `quick-xml` handle formatting; Rust `regex` handles bounded search. These MIT/Apache-compatible engines remain behind Purr contracts and their broader grammars are restricted by Purr's allow-list.
- Above the 32 MiB full-tree tier, validated JSON/NDJSON structural paths use `jsonpath-rfc9535`'s `rsonpath` scan mode. jq paths are adapted to the same scanner; recursive selectors, root selection, and jq pipes that require a complete tree fail explicitly. A streaming `IgnoredAny` validation pass precedes the scan because the scanner alone is not a safe malformed-input validator.
- Native structured input and formatted output are capped by the existing 128 MiB content boundary. The WebView receives only bounded pages/results; Rust may retain one decrypted source byte buffer while a large operation runs, but does not construct a full JSON tree above 32 MiB.
- Referenced dynamic-variable responses now query natively and release their source handle. Large GraphQL responses expose native Data/Errors/Extensions extraction controls; large introspection schema construction stays assigned to Phase 10.
- The synthetic fixture server now exposes deterministic XML, large GraphQL-envelope, and two-million-short-line response shapes so product verification does not depend on private or external data.
- Automated verification passed on 2026-09-16: 138 TypeScript tests, 58 Playwright tests, and 65 Rust tests plus typecheck, lint, production build, repository policy, `cargo fmt --check`, `cargo check`, clippy with warnings denied, full `cargo test`, synthetic fixture smoke checks, and `git diff --check`.

### Library reuse policy

Before implementing any parser/query/formatting engine in Rust, evaluate mature existing crates and prefer composition over custom reimplementation.

At minimum evaluate:

- jq:
  - `jaq-core`
  - `jaq-std`
  - `jaq-json`

- JSONPath:
  - evaluate maintained JSONPath crates and choose one only if its semantics can be adapted to Purr's existing supported subset

- JSON:
  - `serde_json`

- XML parsing / writing / formatting:
  - `quick-xml`

- regex search:
  - prefer the established Rust `regex` ecosystem unless required query semantics need something else

The goal is NOT to preserve the current TypeScript implementation internally.
The goal is to preserve Purr's observable query semantics where they are already documented/tested.

Do not write a custom jq or JSONPath interpreter unless:
1. no maintained crate can support the required semantics,
2. an adapter around an existing crate would be more complex or unsafe,
3. the deviation is explicitly documented.

Before choosing a crate, evaluate:
- maintenance/activity;
- license compatibility with the public OSS repository;
- API stability;
- cancellation/bounded execution possibilities;
- streaming vs full-tree requirements;
- memory behavior on large documents;
- thread-safety;
- malformed-input behavior;
- compatibility with existing Phase 0 conformance fixtures.

Record the selected crate and rationale in Implementation notes.

Deviations from plan:
- Following product-owner UX feedback, transport segments are no longer presented as separate visual lines; collapsed logical-line previews and lazy scrolling replace the page toolbar. The hidden-byte action explains the beta restriction without expanding the full source. The underlying native storage, query contracts, encryption, and dependency direction are unchanged.
- The scan engine requires a contiguous validated JSON text buffer. Large query/format work stays fully in Rust and avoids a full DOM/IPC copy, but it does not yet stream decrypt directly from SQLite into the parser or stream formatted bytes directly back into encrypted chunks. Add that extra store-reader/store-writer complexity only if Phase 0 RSS measurements show the bounded 128 MiB Rust buffer is still a practical problem.
- A line page exposes `lineStartOffset` only when the logical line start is known inside the bounded scan. A page opened in the middle of a giant line uses continuation flags until the next newline rather than scanning unbounded data backwards solely to manufacture a line number.

Known follow-ups:
- Do not advertise full jq/JSONPath compatibility while only the existing subset is implemented.
- Further large-response visual polish and hidden-line expansion UX are deferred after product-owner acceptance; they do not block the Phase 8 architecture or bounded-response behavior.
- Phase 9 still owns direct native-handle download/copy and binary/media paths; Phase 10 owns large GraphQL introspection/schema construction and analysis.
- Profile the Rust source buffer and derived-output buffer with the Phase 0 100 MiB fixtures. Introduce a decrypting `Read`/encrypted `Write` pipeline only if those measurements justify the additional storage complexity.

- **Objective:** provide useful large-response tools without reconstructing full content in JS.
- **Files/modules affected:** Rust `response/*`; TypeScript `model/response.ts` becomes small-value helpers plus port calls; search/query UI.
- **Changes:** implement prefix-based content inspection, bounded decoding,
  line indexing, bounded logical-line segmentation, literal/regex search with limits, and native
  JSON/XML/NDJSON formatting/query adapters.

  Native capture/inspection records presentation hints such as maximum observed
  line bytes and line count when known. The UI uses those hints instead of total
  body size alone when choosing CodeMirror versus the bounded viewer.

  Replace an unbounded `string[]` line page with segment records containing a
  logical line number/ID, byte start/end, bounded text, continuation flags, and
  forward/backward cursors. A single giant logical line is therefore rendered as
  independently pageable segments rather than one JavaScript string or DOM node.

  The React viewer virtualizes rows so a response with millions of lines retains
  only roughly 30–100 visible rows plus a small overscan window. Evaluate a mature
  virtualizer such as `@tanstack/react-virtual` or `react-window`; keep it behind
  Purr's viewer component and select it only after a small prototype verifies
  variable-height/segment navigation and keyboard search behavior. Large-response
  mode disables soft wrap and full-document syntax highlighting and shows an
  explicit “Line wrapping disabled for large responses” notice. Bounded per-page
  highlighting may be added later if measurements show it is safe.

  Prefer mature third-party Rust crates for language/parser/evaluator
  functionality instead of custom implementations.

  In particular:
  - jq should be implemented through an embedded jq-compatible engine
    such as `jaq-core`/`jaq-std`/`jaq-json`, subject to conformance testing;
  - JSONPath should use a maintained crate behind Purr's own adapter if
    its semantics can satisfy the existing supported subset;
  - JSON parsing/serialization should use `serde_json`;
  - XML parsing/writing should use a mature streaming library such as
    `quick-xml`;
  - regex search should use a mature bounded-safe regex engine.

  Third-party engines must remain behind Purr-owned contracts and must
  not leak their AST/value/error types into application/UI layers.

  Preserve currently documented/tested Purr semantics through Phase 0
  conformance fixtures rather than preserving the old implementation.

- No custom parser/interpreter is introduced for jq, JSONPath, JSON, XML,
  or regex without a documented evaluation showing why available mature
  crates are unsuitable.

- **Risk:** semantic drift and unbounded recursive JSON work. Reuse Phase 0 fixtures, set explicit parse limits, stream supported large expressions, and reject unsupported large expressions rather than loading them blindly.
- **Verification:** TypeScript and Rust conformance results match; large searches can cancel; query result larger than the IPC limit is another handle; invalid encoding/data produces a typed error, not process failure; neither millions of logical lines nor one giant line create unbounded IPC strings or DOM nodes.
- **Scope:** L across several PRs: inspect/read/search, formatting, then query engines.

### Phase 9 — remove remaining body round trips

Status: PARTIALLY DONE

Implemented in: Existing `downloads.rs`, response media previews, and binary/multipart request support use base64/full-body paths; no handle-based phase commit/reference.

Started: Pre-plan

Completed: —

Automated verification:
- [ ] Add direct-save tests proving response content is written from a content ID without base64 returning to JavaScript.
- [ ] Add byte-for-byte native request-body tests for large binary, multipart files, redirect replay, stale handle, and handle cleanup cases.
- [ ] Run media/range protocol tests, request body/auth tests, UI tests, TypeScript checks, and Rust checks.

Manual verification:
- [ ] Download a large binary response and verify the chosen file's hash matches the fixture while Purr remains responsive during save.
- [ ] Preview a range-capable image, audio, and video fixture; seek audio/video and confirm media loads without a base64 data URL failure.
- [ ] Upload a large binary file and a multipart form with a file to a local echo fixture; verify received bytes, filenames, and content types exactly match the source.
- [ ] Send a 307/308 redirecting upload fixture and confirm the request body is replayed once with the expected headers and no stale-file error.

Implementation notes:
- Existing user-facing paths work for ordinary payloads but still perform the memory-expensive body round trips targeted by this phase.

Deviations from plan:
- None.

Known follow-ups:
- Keep small inline text bodies simple; only scoped large/file bodies require native handles.

- **Objective:** cover native download, media preview, and large request bodies with handles.
- **Files/modules affected:** current `downloads.rs`, response preview/download components, request body/file UI, `prepareWireRequest`, Rust `http/request_body.rs`, platform file/body port.
- **Changes:** save response directly from content ID; serve range-capable image/audio/video through a safe handle protocol; introduce scoped request file/body handles; keep small inline text bodies simple; stream native file and multipart parts into reqwest; make body sources repeatable for 307/308 redirects; clean abandoned handles.
- **Risk:** arbitrary path access, stale file handles, multipart incompatibility, redirect replay, media CSP. Handles are created only by approved file selection/import, contain no path in domain state, validate ownership/TTL, and have byte-for-byte transport fixtures.
- **Verification:** a large download does not cross WebView memory; media seek/range works; large binary/multipart upload avoids `arrayBuffer` and base64; small text/auth behavior remains identical.
- **Scope:** L, at least two PRs: response download/media then request bodies.

### Phase 10 — profile and isolate GraphQL analysis

Status: PARTIALLY DONE

Implemented in: Existing TypeScript GraphQL request/schema/editor flow; no profiling, worker, or native-schema-service phase commit/reference.

Started: Pre-plan

Completed: —

Automated verification:
- [ ] Record schema parse duration, UI long tasks, and memory for the Phase 0 small/large schema fixtures.
- [ ] Add worker request-ID/cancellation tests and regression tests for completion, hover, diagnostics, operation generation, and schema navigation.
- [ ] Run GraphQL unit/UI tests, `npm run typecheck`, `npm run lint`, `npm run build`, and Rust checks if a native service is introduced.

Manual verification:
- [ ] Open a large synthetic SDL and introspection schema, type a query, and verify completion, hover, diagnostics, and field filling remain responsive.
- [ ] Switch between two linked schemas while a query editor is open and confirm suggestions/navigation are from the active schema only.
- [ ] Run an introspection request, pin its SDL, restart Purr, and confirm the schema explorer and offline pinned source still open correctly.
- [ ] If a worker is added, rapidly edit a query and confirm stale diagnostics/completions do not appear after the latest edit.

Implementation notes:
- Existing GraphQL functionality is the behavioral baseline; it has not been profiled or moved off the UI thread.

Deviations from plan:
- None.

Known follow-ups:
- Add Rust `graphql/*` only if the measured worker path cannot meet responsiveness/memory requirements.

- **Objective:** improve large-schema responsiveness based on evidence without duplicating GraphQL semantics.
- **Files/modules affected:** GraphQL model/editor/explorer and optional worker; Rust only if the second tier is justified.
- **Changes:** collect Phase 0 schema metrics; first move parse/validate/language-service work to a Web Worker with versioned request IDs and cancellation. If WebView memory is still above the agreed budget, design the narrower Rust `GraphqlSchemaService` described in B.5 and migrate explorer pages before editor hints.
- **Risk:** worker message copies and stale diagnostics; a Rust service could lose feature parity. Transfer compact results, discard stale request IDs, and keep the existing synchronous path for small schemas during rollout.
- **Verification:** no editor long task above the chosen budget on the large fixture; completions/hover/diagnostics/operation generation match current tests; no Rust GraphQL module is added if the worker solves the problem.
- **Scope:** M for profiling/worker; separate L project only if justified.

### Phase 11 — migrate the canonical integration envelope

Status: PARTIALLY DONE

Implemented in: Existing `integrationDefinitionSchema` stores `{provider, endpoint, credentials}`; no `enabled`, `configVersion`, generic `config`, or unknown-provider round-trip migration reference.

Started: Pre-plan

Completed: —

Automated verification:
- [ ] Add canonical/YAML fixtures for legacy endpoint integrations, unknown provider config, disabled integrations, and secret refs.
- [ ] Run projection/restore validation proving unknown config round-trips without mutation and cross-workspace secret refs fail.
- [ ] Run persistence, import, TypeScript type/lint/build, and Rust checks.

Manual verification:
- [ ] Open a workspace with a legacy integration YAML fixture, save it, and inspect the resulting YAML to confirm it migrates without losing credentials or unrelated fields.
- [ ] Open and save a fixture for an unavailable/private provider with nested config; confirm Purr preserves it, shows it as unavailable, and does not expose credential values.
- [ ] Disable and re-enable the unavailable provider, restart Purr, and confirm its configuration remains intact.

Implementation notes:
- The existing shape reserves provider data but cannot safely preserve arbitrary future private configuration.

Deviations from plan:
- None.

Known follow-ups:
- Provider-specific validation and settings UI remain adapter work in later phases.
- The generic extension-document envelope and unavailable-document host are Phase 12 work because they belong to module/document registration rather than integration configuration.

- **Objective:** make persisted integration configuration safe for unknown public/private providers.
- **Files/modules affected:** `src/domain/project.ts`, YAML codec/projection, migrations/fixtures, integration resource UI placeholder.
- **Changes:** add `enabled`, `configVersion`, `config`, credential map rules, provider ID validation, old `endpoint` migration, and unknown-provider round-trip. Keep vendor validation in adapters and core envelope validation generic.
- **Risk:** strict Zod parsing can drop or reject private fields. Preserve the config object as JSON and add a fixture representing a provider unavailable in the current build.
- **Verification:** old integration YAML opens; unknown private config survives save unchanged; no secret value is serialized; invalid cross-workspace refs fail.
- **Scope:** M, one PR.

### Phase 12 — implement extension API and immutable registries

Status: PARTIALLY DONE

Implemented in: Existing native import-adapter registry is a related precursor; no public extension API, immutable provider registry, or external conformance harness reference.

Started: Pre-plan

Completed: —

Automated verification:
- [ ] Add conformance tests for a fake external module importing only documented public exports and contributing a provider, namespaced page/navigation entry, module-owned service, and extension document type.
- [ ] Add boot tests for duplicate module/provider/page/document-type IDs, route collisions, incompatible API versions, registry freeze, and zero optional modules.
- [ ] Add canonical/local-state tests proving an unknown extension document round-trips unchanged in OSS, shows an unavailable state, and becomes editable again when its module is restored.
- [ ] Run package export/build tests plus TypeScript unit/UI/type/lint/build and Rust checks.

Manual verification:
- [ ] Launch the OSS app with no optional module configured and confirm all existing workspace/request/GraphQL workflows still start normally.
- [ ] Run the example external fake-module shell, open its contributed navigation entry/page, execute its module-owned sample action, and confirm no public source file imports that module.
- [ ] Create and save its fake protocol/document, restart, remove the fake module and confirm the unavailable document remains renameable/moveable/deletable with config intact; restore the module and confirm the editor/config returns.
- [ ] Attempt to load an intentionally incompatible/duplicate fake module and confirm startup reports the precise module conflict without partially registering it.

Implementation notes:
- The import registry demonstrates a registry pattern but is not an extension boundary and must not be treated as completion of this phase.

Deviations from plan:
- None.

Known follow-ups:
- Keep settings embedded inside existing screens, response panels, workspace actions, and request-policy hooks out of the API until a concrete module needs each named surface.
- Phases 13–14 still validate the provider/observability half of the same module API with Jaeger.

- **Objective:** provide the single supported build-time registration seam for provider modules and independently owned feature modules.
- **Files/modules affected:** `src/integrations/{contracts,registry}.ts`, `src/extension-api/*`, `src/app/composition/*`, `src/app/app-router.tsx`, generic extension document domain/host files, package exports, conformance tests.
- **Changes:** implement module, integration-provider, trace-provider, correlation, page/navigation, and workspace-document-type registries; add the opaque extension-document envelope and unavailable host; validate IDs/API versions/routes/duplicates; freeze at startup; expose a curated barrel, public UI primitives, and test kit. Provider/page/document factories receive constrained contexts. Do not export runtime `Workspace`, raw storage/secrets, the router, or core feature components.
- **Risk:** the API becomes a dump of internals or a universal plugin framework. Keep page routes namespaced, document persistence opaque, services module-owned, and every cross-core hook named. Split provider registries and page/document composition into two sequential PRs if review size grows.
- **Verification:** a fake external module registers a provider, page, private service action, and document type without internal imports; an unknown document survives without the module; duplicates and incompatible API versions fail atomically; the app with zero optional modules is fully functional.
- **Scope:** L, preferably two sequential PRs: base/provider registries, then page/document composition.

### Phase 13 — add provider-neutral observability use case and UI

Status: TODO

Implemented in: —

Started: —

Completed: —

Automated verification:
- [ ] Add domain tests proving trace/span/log models import no React, Tauri, storage, or vendor DTOs.
- [ ] Add UI/application tests using at least two fake providers without provider-ID branches in core code.
- [ ] Run response, observability, type/lint/build, and Rust checks.

Manual verification:
- [ ] Configure two fake provider integrations, send a request with a fixture `traceparent` or B3 header, and confirm the Trace tab shows the normalized trace from the selected integration.
- [ ] Open a response with no correlation data and confirm the Trace tab explains that no trace was found rather than exposing a vendor-specific error.
- [ ] Start a deliberately delayed fake trace lookup, cancel or navigate away, and confirm the response view remains usable with no stale trace result.
- [ ] Use trace/log pagination/search fixtures and confirm service, operation, timestamps, status, and attributes render without provider field names leaking into the UI.

Implementation notes:
- None yet.

Deviations from plan:
- None.

Known follow-ups:
- Keep persistence/cache minimal until a real provider demonstrates the required lifecycle.

- **Objective:** prove that Trace/Span/Log are independent of any vendor.
- **Files/modules affected:** `domain/observability.ts`, application use cases, new observability feature components, response-tab extraction, fake provider tests.
- **Changes:** define normalized models, trace/log search pages, correlation extraction, errors, cancellation; replace disabled Trace placeholder with a provider-neutral state driven by a fake provider. Keep persistence/cache minimal and local.
- **Risk:** designing contracts from hypothetical providers. Limit the first surface to response-linked trace lookup plus the search/pagination required by Jaeger; add logs as a contract only when a real log UI/provider is being built.
- **Verification:** UI tests use two fake providers and contain no provider ID branches; domain imports no React/Tauri/vendor code.
- **Scope:** M–L, one or two PRs.

### Phase 14 — implement Jaeger as the public validation adapter

Status: TODO

Implemented in: —

Started: —

Completed: —

Automated verification:
- [ ] Add Jaeger adapter fixtures for configuration validation, correlation extraction, normalized trace/span mapping, errors, pagination, and cancellation.
- [ ] Run extension conformance tests with Jaeger plus a second fake provider, then remove Jaeger from core-module composition in a build test.
- [ ] Run OSS build, TypeScript tests/type/lint, and Rust checks.

Manual verification:
- [ ] Prepare a local Jaeger instance or documented fixture endpoint containing a known trace and configure it through the new integration settings.
- [ ] Send a request carrying the trace ID through `traceparent`/B3 or a configured response header; open the Trace tab and verify spans, service names, duration, hierarchy, and error status against Jaeger.
- [ ] Disable the Jaeger integration, restart Purr, and confirm the saved configuration persists while trace lookup becomes unavailable without breaking ordinary requests.
- [ ] Run the OSS build with Jaeger removed from the core module list and confirm Purr still launches and sends HTTP/GraphQL requests.

Implementation notes:
- None yet.

Deviations from plan:
- None.

Known follow-ups:
- Other public providers must use the same contracts; do not add Jaeger branches to core UI/application logic.

- **Objective:** validate contracts, registry, configuration, credentials, normalized mapping, and UI end to end with a real public provider.
- **Files/modules affected:** `src/integrations/builtins/jaeger/*`, core module composition, integration settings, observability tests/docs.
- **Changes:** implement Jaeger configuration schema/editor, HTTP adapter, trace mapping, correlation integration, errors/cancellation, and fixtures. Use the public HTTP and credential ports only.
- **Risk:** leaking Jaeger fields into core domain or widening the API for convenience. Keep raw DTOs under the adapter and change public contracts only when the use case cannot be expressed generically.
- **Verification:** Jaeger can be removed from `core-modules.ts` and the app still compiles; adding a second fake provider changes no core UI/business files; public standalone build works.
- **Scope:** L, several provider-focused PRs.

### Phase 15 — expose reusable frontend and Rust composition surfaces

Status: PARTIALLY DONE

Implemented in: Existing `purr_lib` Rust library target; no `core_builder()`, public frontend package exports, compiled core artifact, or external-shell phase commit/reference.

Started: Pre-plan

Completed: —

Automated verification:
- [ ] Build the OSS app and the deterministic core JavaScript/type/CSS artifact from a clean checkout.
- [ ] Run an example external shell that imports only `./app`, `./extension-api`, and `./styles`, with one fake module contributing a page/navigation entry, module-owned service, extension document type, and one test native plugin.
- [ ] Run package export checks, React-singleton check, TypeScript tests/type/lint/build, and Rust fmt/clippy/test.

Manual verification:
- [ ] Launch the normal OSS binary and verify existing workspaces, REST/GraphQL requests, persistence, downloads, and OAuth still work with the thin public `main.rs`.
- [ ] Launch the example consumer shell using its own Tauri configuration/capabilities and confirm its page, navigation entry, fake protocol/document editor, module-owned action, and native-plugin call work without copying public source files.
- [ ] Inspect the consumer build output and confirm public styles/assets load and no duplicate-React hook error occurs.
- [ ] Remove the example consumer checkout and confirm the public OSS build remains independently runnable.

Implementation notes:
- `purr_lib` is already a Rust crate boundary, but it currently owns the concrete Tauri run/composition and is not a reusable official-build surface.

Deviations from plan:
- None.

Known follow-ups:
- Phase 16 consumes these exports from the real private repository.

- **Objective:** make the exact public source consumable by the official shell.
- **Files/modules affected:** root package exports/build, `src/app/create-purr-app.tsx`, Rust `lib.rs`, `composition.rs`, `main.rs`, OSS Tauri config.
- **Changes:** expose `./app`, `./extension-api`, `./styles`; add the deterministic core library/CSS/type build; keep React a single peer instance; document supported imports; export `core_builder()` and a run helper that accepts the caller's Tauri context; make the OSS `main.rs` a thin caller; support adding Tauri plugins before run. Keep public app build as the contract test.
- **Risk:** Vite/Tailwind asset resolution and Tauri context assumptions from a sibling dependency. Add an example consumer fixture inside public CI before creating the private repo.
- **Verification:** example shell composes one external fake provider/page/document module and a test native plugin without copying source; the extension imports only public exports and the OSS build remains identical in behavior.
- **Scope:** M, one PR.

### Phase 16 — create `purr-commercial` and official build composition

Status: TODO

Implemented in: —

Started: —

Completed: —

Automated verification:
- [ ] Run the private compatibility script against the exact public SHA/API versions in `core-version.json`.
- [ ] Build/test the official shell with a commercial provider plus a private page/module-owned use case, and verify imports are limited to documented public exports/APIs.
- [ ] Run the public OSS build in a checkout with no private sibling, then run official build/signing smoke checks with credentials injected only by CI/local secure configuration.

Manual verification:
- [ ] Prepare sibling `purr/` and `purr-commercial/` checkouts at the pinned revisions; launch OSS Purr from the public checkout and confirm it works with no private directory present.
- [ ] Launch the official shell and verify its commercial provider is available while the same provider is absent from the OSS build.
- [ ] Open a private navigation page and, if the first commercial module supplies one, create/reopen its protocol document; confirm the OSS build preserves that document as unavailable without interpreting its config.
- [ ] Open a workspace containing commercial integration configuration in OSS Purr, save/reopen it, then open it in the official build and confirm the configuration was preserved.
- [ ] Inspect both build directories and confirm official composition did not modify/copy public application source or require public signing credentials.

Implementation notes:
- None yet.

Deviations from plan:
- None.

Known follow-ups:
- Release signing, notarization, and publication remain pipeline work but must use this composed build rather than source overlays.

- **Objective:** establish the real repository boundary after the public API is proven.
- **Files/modules affected:** new private repo only, except public compatibility notes if defects are found.
- **Changes:** create thin frontend/Rust entries, sibling dependencies, `core-version.json`, compatibility validation, one private fake or real commercial provider, private tests, and release-build skeleton without signing credentials committed.
- **Risk:** private code reaches internal public paths or begins copying source. CI rejects imports outside package exports and verifies the public checkout is clean after the private build.
- **Verification:** delete/rename the private sibling and OSS Purr still builds; official build contains private module; `git diff` in public is empty after composition; changing private module requires no public source edit.
- **Scope:** M for shell/scaffold; provider work separate.

### Ordering and merge-conflict guidance

Phases 0–3 are prerequisites. Phase 4 should land before new Rust content files. Phases 5–9 form one native-response program and should stay sequential. Phase 10 can follow Phase 7 measurements. Integration work in Phases 11–14 can proceed after Phase 3 and may overlap the native-response program only when file ownership does not overlap. Phases 15–16 come last.

Avoid mixing these high-conflict files in broad migrations:

- change `workspace-workbench.tsx` through small extracted callbacks/hooks, not a rewrite;
- split `response-viewer.tsx` before changing response behavior;
- move Rust files with preserved command names before changing DTOs;
- add tolerant v1/v2 restore paths before changing persisted execution shapes;
- land package/export work after current feature branches no longer depend on deep imports.

## J. Files and modules mapping

### J.1 Frontend mapping

| Current file/module | Current responsibility | Target | Refactor? | Reason |
| --- | --- | --- | --- | --- |
| `src/App.tsx`, `src/app/app-router.tsx` | Mount and route the whole app | Keep; call `app/create-purr-app.tsx` and render immutable core/contributed routes | Small | Public and official entries need one reusable app factory; private pages must not replace the router |
| `features/workspaces/workspace-workbench.tsx` | Workspace UI plus top-level request/schema/import/navigation orchestration | Keep UI; extract use cases/composition calls | Yes, incremental | It is the highest-conflict frontend composition point |
| `features/workspaces/model/workspace.ts` | Mutable runtime aggregate, documents, layout, response/cache state | Keep internal; add a generic extension-document runtime branch/host | Medium in Phase 12 | Useful runtime model, unsuitable stable extension API; extensions receive narrow document props rather than the aggregate |
| `features/workspaces/hooks/use-workspaces.ts` | Load/autosave/flush/failure handling | Keep; depend on `PersistencePort` | Small | Existing lifecycle is sound; remove platform construction |
| `src/domain/project.ts` | Canonical schemas and cross-resource validation | Keep; add integration and opaque extension-document envelopes | Medium across Phases 11–12 | Unknown private config must round-trip without vendor unions or secret/path leakage |
| `application/project-projection.ts` | Runtime ↔ canonical/local/assets/secrets | Keep | Small for content refs | Preserve one projection route; add v1/v2 response restoration |
| `application/workspace-persistence.ts` | File layout, revisions, commits, reconciliation | Keep | Small | Good application service; depend on ports |
| `application/environment-secrets.ts` | Lazy secret resolution for environments | Keep application-side | Small | Policy/ownership work, not a Rust performance target |
| `application/import-project.ts`, `import-workspace.ts` | Validate/commit normalized imports and secrets | Move under `application/importing/` when convenient | Small | Good normalized persistence route; direct invoke moves to platform adapter |
| `storage/contracts.ts` | Persistence and secure-store interfaces plus generic local DTOs | Split ports into `application/ports`; keep codec storage types local | Yes | Ports should not be owned by infrastructure and execution DTO must become typed |
| `storage/native-backend.ts` | Direct Tauri persistence/secret adapter | `platform/tauri/{persistence,credentials}.ts` | Move/adapt | Centralize native boundary |
| `storage/browser-backend.ts` | IndexedDB/WebCrypto preview implementation | `platform/browser/*` | Move/adapt | Explicit alternate platform implementation |
| `storage/secrets.ts` | Stable refs, credential storage helpers, protected runtime traversal | Keep application/storage helper; later expose narrow credential resolver | Small | No benefit from moving recursive UI/runtime projection to Rust |
| `storage/yaml.ts`, `file-codec.ts` | Canonical serialization | Keep under storage | No structural need | Deterministic Git format is not an extension or performance issue |
| `importing/contracts.ts` | TS IPC/application import DTOs | Application import contract plus `platform/tauri/contracts.ts` wire schema | Yes | Separate stable normalized result from IPC encoding/version |
| `request-workbench/model/request*.ts` | Request editor/domain-like models, auth/body/cURL/code | Keep feature-internal; extract only stable transport snapshots | Selective | Do not turn mutable editor state into SDK/domain |
| `model/request-body.ts` | Diagnostics, serialization, conversion, prettify | Keep editor logic; produce native body plan for large files | Medium later | Interactive diagnostics stay TS; large byte materialization moves native |
| `model/response.ts` | Detection, full-body format, hex, jq/JSONPath, suggestions/cookies | Split small helpers from `ResponseContentPort` operations | Yes | Current functions require whole strings/bytes and create large copies |
| `services/http-client.ts` | Wire DTOs, direct invoke, redirects/cookies, response decode | Transport adapter + application HTTP execution | Yes | It mixes platform transport and application policy |
| `services/execute-request.ts` | Workspace/env/GraphQL/auth/body preparation and execution | `application/requests/*` behind explicit inputs | Yes, preserve order | One composition path should become reusable/testable |
| `services/oauth-client.ts` | OAuth token requests plus native callback calls | Application OAuth service + Tauri callback adapter | Medium | Keep token policy application-side; isolate privileged callback |
| `components/response-viewer.tsx` | All response tabs, parsing/query, media, GraphQL, download | Several response/GraphQL/observability panels | Yes before streaming | Current size and responsibilities make every change conflict-prone |
| `components/response-code-viewer.tsx` | Full-string CodeMirror display/search | Keep small viewer; add large virtualized viewer | Yes | CodeMirror full documents are inappropriate for very large read-only bodies |
| `services/download-response.ts` | base64 decode or round trip to native save | `ResponseContentPort.save()` | Replace desktop path | Native content can stream directly to disk |
| `graphql/model/graphql.ts` | GraphQL envelope, operation parse, schema parse/normalize | Split request helper and schema service; initially TS/worker | Medium | Different hot paths; blanket Rust move would duplicate schema state |
| GraphQL editor components | CodeMirror language intelligence | Keep UI; optionally call worker | Small–medium | Tight editor integration and per-keystroke latency |
| `graphql/components/schema-explorer.tsx` | Schema sources, introspection, cache, explorer, export | Split source/load use case from view | Yes, incremental | Future paged schema service needs a clear port |
| `workspaces/services/dynamic-variable-resolver.ts` | Executes dependency request and applies jq/JSONPath | Use application execute/content-query ports | Medium | Must support native response refs without parsing a full string |
| `src/shared/` | UI system, theme, general utilities | Keep; curate explicitly supported UI primitives through `extension-api` | Small export review | Private pages need consistent UI without gaining access to every shared/internal helper |
| New extension page/document hosts | Namespaced pages/navigation and opaque contributed document lifecycle | `features/extensions/*` plus app composition | New in Phase 12 | Supports full private feature UI and protocols without a shell/workbench fork |
| New module-scoped state adapter | Encrypted local state for private module sessions/caches | Application port plus native/browser adapter, only when first needed | New, narrow | Modules must not receive raw local tables or create ad hoc plaintext storage |

### J.2 Rust mapping

| Current module | Current responsibility | Actual layer | Target location/split | Refactor needed? | Target dependencies |
| --- | --- | --- | --- | --- | --- |
| `src-tauri/src/main.rs` | Calls `purr_lib::run()` | Binary composition | Thin OSS entry calling `run(core_builder())` | Small | Public `purr_lib` only |
| `src-tauri/src/lib.rs` | Module declarations, plugins, managed state, setup, command list, template greet | Composition root mixed with app commands | `lib.rs`, `composition.rs`, `commands/mod.rs`, `commands/app.rs` | Yes | Tauri, public capability constructors; no provider implementations from private repo |
| `downloads.rs` | Sanitizes filename, receives base64, opens save dialog, writes whole file | Command + filesystem output | `commands/response.rs` + content-store save method | Replace | Dialog adapter and `content::store`; no base64 and no raw frontend path |
| `http.rs` | Reqwest client, wire DTOs, URL/header validation, send/timing, whole-body collection/base64, tests | Command + transport + response buffering | `commands/http.rs`, `http/{client,transport,operations,request_body}.rs` | Yes | Reqwest/Tokio, `content::store`, safe URL policy; no workspace/application model |
| `importing.rs` | Import source DTOs, filesystem/URL loading, budgets, JSON/YAML parse, `$ref`, OpenAPI mapping, normalized project output, registry, tests | Import application/adapters + infrastructure + command | `commands/importing.rs`, `importing/{contracts,source,references,openapi,project}.rs` | Yes, mechanical first | HTTP URL/fetch policy, filesystem, serde; returns normalized DTO only; no persistence writes |
| `local_state.rs` | DB open/migrations, key setup, generic records, secret vault, workspace registry, execution body extraction, history, journal, tests | Persistence + security + migrations + typed history, heavily mixed | `persistence/{local_records,response_bodies,migrations,journal}.rs`, `security/credential_vault.rs` | Yes | Rusqlite, cipher abstractions; response store uses typed records instead of nested `Value` indexing |
| `persistence.rs` | Lazy runtime storage, app paths, workspace registry, watchers, recovery, secure and persistence commands, open/attach folder | Composition/coordinator + commands + watcher + OS shell | `persistence/mod.rs`, `persistence/watcher.rs`, `commands/persistence.rs`; secure commands in credential command adapter | Yes | Project files, local store, content store, opener/event adapter; commands remain thin |
| `project_files.rs` | Safe paths, recursive load, base64 assets, revision preflight, atomic writes | Filesystem persistence infrastructure | `persistence/project_files.rs` | Mostly move | Filesystem/hash/base64 for canonical assets only; no response content |
| `secure_store.rs` | Ref validation, platform Keychain root, HKDF keys, AES-GCM seal/open, zeroization | Security infrastructure | `security/{root_key,cipher}.rs` | Split | Keyring, HKDF, AEAD, zeroize; no Tauri commands or domain models |
| `oauth.rs` | Validates URLs, opens browser, owns loopback listener/session cancel, parses callback | Privileged OAuth callback adapter | Keep `oauth.rs` initially; thin wrappers may move to `commands/oauth.rs` | Small | Shared safe URL validation, opener, Tokio; no token exchange/business auth model |
| `workspaces.rs` | Read-only legacy v1 loader and authenticated archive/retirement | Persistence migration adapter | `persistence/legacy.rs` | Move/rename | Filesystem + cipher only; no new workspace writes |

### J.3 TypeScript/Rust contract mapping

| Current contract | Problem | Target |
| --- | --- | --- |
| TS `WireRequest` ↔ Rust `HttpRequest` | Manual duplicate; body is base64 | Versioned `PreparedHttpTransportRequest` with inline bytes only under a bound or opaque repeatable body source |
| TS `WireResponse` ↔ Rust `HttpResponse` | Manual duplicate; complete body crosses IPC | `HttpResponseMetadata + ResponseContentRef`; validate at adapter boundary |
| `HttpResult` persisted inside generic local JSON | Rust removes/restores nested `text/bodyBase64` by field name | Typed `ExecutionRecordV2` metadata plus content ID/adoption command |
| `LocalTable` string union ↔ Rust `TABLES` | Manual duplicate and generic `Value` | Central IPC constants/fixtures; typed commands for rows Rust must index |
| TS import DTOs ↔ Rust import structs/`Value` | Native output is trusted by a TypeScript cast | `protocolVersion` + Zod parse + serialized fixture tests |
| GraphQL introspection JSON | Full text parsed into JS schema | Keep current for normal sizes; future schema-service DTO is compact/paged and separate from HTTP domain |
| Provider DTOs | Risk of leaking into core commands | Adapter/private-plugin-owned namespaced DTOs mapped to public domain at the adapter edge |
| Extension protocol/native DTOs | Risk of adding private unions/commands to core | Module-owned DTOs and namespaced Tauri plugin commands; core sees only opaque document config and public execution/content summaries |

## K. Open-source readiness checklist

### K.1 Findings from the current checkout

- A limited regex scan of the current tree and non-test Git patches found no committed private key block, common cloud key/token format, updater signing private key, or obvious production credential. Synthetic tests contain values such as `test-token`, `secret-password`, and `private-token`; keep them clearly fake.
- `src-tauri/tauri.conf.json` commits a personal Apple Development signing identity including email and team ID. This is not the signing private key, but it should be removed from the public config and injected only in local/private release configuration.
- No `LICENSE` file is present. `package.json` is still `private: true`; Cargo metadata says `authors = ["you"]` and generic description.
- Both npm and Yarn lock/config artifacts are present. `.yarn/install-state.gz` is tracked despite being ignored now and is the largest repeated blob in the repository history. Standardize and remove it from the index; history cleanup for size is optional unless other sensitive history is found.
- `.DS_Store`, `dist/`, and `test-results/` exist locally but are ignored and were not shown as tracked. Verify this again from a clean clone.
- `theme-ref.html` is a standalone generated/design reference using CDN assets and includes secret-looking mock text. Establish its provenance/license and either remove it, document it, or sanitize it before publication.
- Bundled fonts, icons, `public/tauri.svg`, `public/vite.svg`, and other visual assets need an ownership/license inventory. Remove unused starter assets.
- The Tauri app CSP is currently `null`. Define an explicit production CSP before public binaries are distributed, particularly before adding a handle-based media protocol.
- Native secure storage currently fails closed outside macOS. Document supported platforms accurately or add native root-key adapters before advertising those builds.
- There is no visible `.github/` pipeline in the current checkout, so secret scanning, dependency review, and reproducible OSS builds still need CI setup.

The limited scan is evidence about this checkout, not a complete history/security audit.

### K.2 Checklist before changing repository visibility

- [ ] Run Gitleaks or an equivalent scanner over all refs, commits, tags, large blobs, and LFS objects; review findings manually.
- [ ] If any real secret ever existed, revoke/rotate it first, then rewrite history if exposure reduction is useful. History deletion alone does not make a credential safe.
- [ ] Inspect deleted historical `.env`, databases, logs, exports, screenshots, HAR files, fixtures, provisioning profiles, certificates, and archives.
- [ ] Remove the personal `bundle.macOS.signingIdentity` from public Tauri config. Keep Apple certificates, API keys, app-specific passwords, notarization credentials, and CI issuer/key IDs only in secret storage.
- [ ] Keep any Tauri updater private key outside all repos; only the updater public key may be committed to the build that uses it.
- [ ] Audit GitHub Actions, repository variables, environments, caches, build logs, release assets, and artifact retention before enabling public workflow logs.
- [ ] Add an OSI license and confirm copyright ownership for all code.
- [ ] Generate a third-party dependency/license inventory for npm, Cargo, fonts, icons, and design assets; resolve incompatible or missing licenses.
- [ ] Decide whether the Purr name/logo is available for OSS use and document the trademark/branding policy separately from the code license.
- [ ] Remove unused Vite/Tauri starter assets and confirm `theme-ref.html` provenance.
- [ ] Standardize npm; remove `.yarn/install-state.gz`, `.yarnrc.yml`, and `yarn.lock` if npm is selected. Verify no credentials exist in package-manager config/registry URLs.
- [ ] Add `.env.example` only if configuration is actually needed; it must contain names/placeholders, never values.
- [ ] Verify `.gitignore` covers `.env*` except an explicit example, signing files, `*.p12`, `*.mobileprovision`, databases, logs, HAR files, local workspaces, build output, and test artifacts.
- [ ] Review all test fixtures for real hosts, internal organization names, customer payloads, emails, trace IDs, tokens, and proprietary API schemas. Prefer synthetic `example.test` data.
- [ ] Confirm project YAML/asset fixtures contain no response history, cookies, local file paths, username/home paths, or secret values.
- [ ] Inspect error paths and logs so request URLs with query secrets, headers, OAuth codes/tokens, response bodies, and filesystem paths are not emitted to console/CI.
- [ ] Add dependency vulnerability review, lockfile verification, Rust audit, secret scan, and source/build tests to public CI.
- [ ] Add `SECURITY.md` with a private reporting channel and supported-version policy.
- [ ] Replace package/Cargo placeholder metadata; add repository, license, authorship/contact, description, and minimum supported Rust/Node versions.
- [ ] Create separate public/official bundle identifiers and release channels. Do not make the OSS build depend on a private updater endpoint.
- [ ] Set a restrictive production CSP and test dialogs, editors, OAuth opener, and future content/media protocol under it.
- [ ] Verify Keychain service/bundle identifier migration so changing public/official identifiers does not orphan or accidentally share credentials.
- [ ] Test a fresh machine, upgrade from current local DB/YAML, missing Keychain root, corrupt local data, and uninstall/reinstall behavior.
- [ ] Review the remote repository’s issues, PRs, wiki, releases, branch names, and collaborators for private information before visibility changes.
- [ ] Make a clean clone from the would-be public commit and build/test it without private checkout, private npm registry, private Cargo source, local absolute path, or developer certificate.

## L. Decisions to postpone

- **A standalone `packages/integration-api`:** premature. A curated root export gives the same boundary without another publish/version pipeline. Extract only after at least two repositories need independent installation/versioning.
- **Multiple Rust crates:** premature. `purr_lib` already provides a crate boundary; internal modules plus a narrow public builder API are enough. Extract a crate only for demonstrated compile-time ownership/reuse.
- **A runtime plugin marketplace or dynamic native libraries:** unnecessary for the official composition goal and much harder to secure/version. Build-time modules and Tauri plugins are sufficient.
- **A general-purpose DI framework/service locator:** unnecessary. One typed services object, explicit constructors, and immutable registries are easier to understand.
- **A universal event bus:** unnecessary. Use direct use-case calls and a Tauri channel only for the concrete HTTP progress lifecycle.
- **A full Rust rewrite of request composition:** rejected unless the product model changes. It would duplicate inheritance, variable, auth, body-mode, cookie, and redirect semantics.
- **Moving all secret handling to Rust:** rejected as a blanket goal. Cryptography and storage are already native; UI editing/projection/template policy remains application logic. A future threat model may justify native final credential injection for selected providers, behind scoped handles.
- **Full jq/JSONPath compatibility:** postpone until explicitly selected as a product feature. First preserve the documented subset and its fixtures.
- **Rust GraphQL language server:** conditional on profiling after a Web Worker. It is a separate product-sized effort because current editor behavior relies on the JS GraphQL ecosystem.
- **Persistent content-addressed files/deduplication/compression:** postpone until chunked encrypted SQLite is measured with real history workloads. Correct bounded ownership matters before storage optimization.
- **Full syntax highlighting and soft wrapping for large responses:** postpone until the segmented/virtualized viewer is measured. The safe default is no full-document highlighting and no wrapping; a giant logical line must never be handed to CodeMirror or rendered as one DOM text node merely to preserve editor-like presentation.
- **Logs, metrics, traces, and events in one generic telemetry interface:** avoid. Trace/Span/Log are related but have different query and presentation semantics. Add metrics/events only with real use cases.
- **Generic arbitrary UI slots:** reject. Support namespaced pages/navigation and extension document hosts as first-class named contributions. Add inline settings sections, response panels, workspace actions, or observability surfaces only with concrete typed props when a real module needs them; unrestricted `slotName + ReactNode` injection would make the SDK unstable.
- **One universal protocol provider interface:** reject. HTTP, WebSocket, gRPC, MQTT, and long-lived proprietary sessions have different lifecycles. Use the generic extension-document envelope/host for ownership and persistence, then give each real protocol the smallest execution/session contracts it needs while reusing public HTTP/content ports where they fit.
- **Licensing hooks in public core:** postpone and keep private unless a generic OSS capability policy becomes a real requirement.
- **Immediate creation of `purr-commercial`:** postpone until Phases 12–15 prove the public API and builder through Jaeger plus an example consumer. This avoids designing the public API around only hypothetical private needs.

## Architecture acceptance criteria

The migration is complete only when all of these are mechanically verifiable:

- a clean public checkout compiles, tests, and produces a useful OSS binary with no private repository;
- the official build checks out public and private repositories side-by-side and performs no source copy/overlay;
- public imports and Cargo dependencies contain no private module/provider/licensing reference;
- private modules import only declared public package exports and public Rust builder/plugin APIs;
- adding a trace provider requires an adapter, registration, configuration contribution, and tests, but no vendor branches in core UI/application code;
- an external build-time module can add a namespaced navigation page, run module-owned application logic, and contribute a persisted workspace document/protocol type using only public exports and without replacing the router/workbench;
- removing that module leaves the OSS app runnable and preserves its opaque document/integration configuration in an explicit unavailable state; restoring the module restores the feature;
- protocol-specific UI, runtime types, native DTOs, and commands remain module-owned and do not expand core `RequestDraft`, `HttpExchange`, or Tauri command unions with vendor branches;
- Trace/Span/Log domain files import no React, Tauri, reqwest, storage, or vendor DTOs;
- Tauri commands are thin adapters and do not reconstruct `RequestDraft` or own workspace/auth policy;
- desktop response bodies no longer cross IPC as complete base64/text values;
- a 100 MiB response can reach first visible content, search, save, cancel, and persist/restore while WebView memory remains bounded by configured windows rather than body size;
- large query/pretty results remain handles/pages instead of unbounded IPC strings;
- response staging/persistence is encrypted at rest, chunk corruption fails closed, and abandoned content is cleaned;
- old canonical files and local execution records still open through an explicit migration/compatibility path;
- the extension and native API versions are pinned and checked by private CI;
- the architecture remains one public application, one public Rust crate, one thin private composition shell, explicit contracts, registries, and adapters.
