# Purr: migration plan for a public core, private extensions, and a modular native engine

Status: canonical architecture plan, execution tracker, and product-owner checklist; no refactoring is implemented by this document.
Code baseline reviewed: `f841397` (`main`) on 2026-09-14.

This plan is based on the current TypeScript and Rust code, tests, persistence format, and documented request/response lifecycle. It deliberately keeps Purr as one application and one Rust crate for now. The main decisions are:

1. `purr` remains a complete public application and also exposes a narrow build-time extension API.
2. `purr-commercial` contains only commercial modules and the official composition shell. It never copies the application source.
3. Frontend composition uses explicit contracts, registries, and an application composition root. Build-time modules may contribute integration presentation metadata, namespaced pages/navigation, module-owned UI logic, and extension document/protocol types through named contracts. It does not use a DI framework, arbitrary UI injection, or a runtime plugin marketplace.
4. Rust becomes the bounded engine for native transport, encrypted content storage, large response decoding/search/format/query, large request-body streaming, imports, filesystem work, OAuth callbacks, secure storage, and the complete observability execution pipeline. React never executes a trace/log provider: provider selection, configuration validation/migration, credential resolution, network calls, vendor parsing, correlation extraction, normalization, caching, pagination, and cancellation are native responsibilities.
5. TypeScript keeps interactive HTTP/GraphQL request composition, canonical project schemas, UI state, GraphQL editor intelligence, and ordinary workspace/application policy. This does not include observability provider business logic, which follows the Rust boundary above. Moving the existing editor/workspace responsibilities wholesale to Rust would create a second application model and a second request-building path.
6. Large response support is built around an opaque native content reference. Merely moving `JSON.parse` to Rust while still returning the complete formatted result to React would not solve the memory problem.
7. A second repository is the intended result, but creating it before the extension contract and one public vertical slice are proven would be premature. The split happens near the end of the migration, after Jaeger validates the boundary.

## Migration progress

This tracker reflects the repository state reviewed on 2026-09-17. `PARTIALLY DONE` identifies an existing precursor only; it does not mean the phase acceptance criteria or its verification checklist are complete. No phase is `DONE` until its scope, automated checks, manual checks, and completion protocol are all recorded.

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
| 9 | Remove remaining body round trips | DONE | Phase 9 working tree based on `cf80691` | PASS — 149 unit/integration, 60 UI, 76 Rust tests; typecheck, lint, build, repository policy, fmt, check, clippy, diff check | COMPLETE — product-owner accepted download/media, redirects, multipart, Request Code, autosave, and attachment restart/restore on 2026-09-16 |
| 10 | Profile and isolate GraphQL analysis | DONE | Phase 10 working tree based on `175ab8b` | PASS — 151 unit/integration, 61 UI, typecheck, lint, build, repository policy, benchmark, Rust fmt/check/clippy and 76 tests | COMPLETE — large schema, active-schema isolation, pinned restart, cancellation, responsiveness, and desktop profiling accepted 2026-09-16 |
| 11 | Migrate canonical integration envelope | DONE | Phase 11 working tree based on `e721a5d` | PASS — 153 unit/integration, 62 UI, 76 Rust tests; typecheck, lint, build, repository policy, fmt, check, clippy | COMPLETE — product-owner accepted legacy migration and unavailable-provider persistence scenarios on 2026-09-16 |
| 12 | Implement extension API and immutable registries | DONE | Phase 12 working tree based on `2f5e3b4` | PASS — 156 unit/integration, 64 UI, 76 Rust tests; typecheck, lint, build, repository policy, fmt, check, clippy, diff check; Rust-only observability seam correction rechecked | COMPLETE — product-owner OSS/fake-module/unavailable-module/conflict scenarios accepted 2026-09-16 |
| 13 | Add provider-neutral observability use case and UI | DONE | Phase 13 working tree based on `44781e0` | PASS — 159 TypeScript, 66 UI, 88 Rust tests in both default/fixture builds; typecheck, lint, build, repository policy, fmt/check/clippy | COMPLETE — both providers, correlation, credentials/restart, empty/error, cancellation, paging/search and cache invalidation accepted 2026-09-16 |
| 14 | Implement Jaeger public validation adapter | DONE | `architecture-migration` working tree based on `0bf5295` | PASS — 162 TS, 68 UI, 98 Rust default/fixture and 92 Rust provider-free tests; type/lint/build/policy, fmt/clippy, provider removal builds | COMPLETE — synthetic fixture and a real business-service/Jaeger deployment accepted by product owner on 2026-09-17; secrets remained confined to secure storage |
| 15 | Expose reusable frontend and Rust composition surfaces | DONE | Phase 15 working tree based on `d420e98` | PASS — deterministic core artifact, external frontend/native consumer, 162 TS and 68 UI tests, type/lint/build/policy, Rust fmt/clippy/98 tests/provider-free check | COMPLETE — product owner accepted OSS and external desktop shells on 2026-09-17 |
| 16 | Create `purr-commercial` and official build composition | PARTIALLY DONE | Local sibling `../purr-commercial`, branch `main`; exact public revision lives in its `core-version.json` | PASS — minimal-shell exact-pin/API/import/React/dev-worker checks, type/lint/build/fmt/clippy/Cargo test, native executable and standalone OSS builds; signing deferred | Pending owner verification |

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
    observability.ts              # bounded display/IPC models; no provider execution
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
      observability-port.ts       # UI-facing typed port to the native service
    project-projection.ts         # existing boundary
    workspace-persistence.ts
    importing/

  integrations/
    contracts.ts                  # frontend presentation contribution contracts only
    registry.ts                   # duplicate-safe immutable presentation registries
    builtins/
      jaeger/                     # label/settings UI only; executable adapter is Rust
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
    observability.rs              # lookup/search/cancel DTO mapping only
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

  observability/
    mod.rs
    domain.rs                     # Trace/Span/Log DTOs and provider-neutral errors
    registry.rs                   # immutable native provider/extractor registry
    service.rs                    # provider selection and response-linked use cases
    correlation.rs                # W3C/B3/vendor-neutral correlation extraction
    cache.rs                      # bounded encrypted/local cache policy
    credentials.rs                # integration-scoped credential resolution
    providers/
      jaeger.rs                   # public validation adapter; raw DTOs stay here

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

Native observability providers receive a Rust `ScopedCredentialResolver` bound to one workspace, integration instance, and the credential keys declared by that provider. Plaintext credentials never cross observability IPC and providers never receive the raw vault or arbitrary reference lookup. Public application code may later resolve `external-secret` variables through a separate credential-provider contract with explicit cache, redaction, and error policy; that future feature must not weaken the observability boundary. Project YAML still contains only provider/key metadata or `SecretRef` values.

## C. Dependency rules

Allowed frontend directions:

```text
feature UI -> application use cases -> domain
feature UI -> shared UI
application -> application ports + domain
platform adapters -> application ports + IPC contracts
frontend integrations -> presentation contracts + public UI/application ports; no observability execution
extension-api -> selected domain/contracts/testing exports
app composition -> core features + adapters + integrations
private modules -> public extension-api
private module UI -> public extension-api/UI primitives + that module's private services
extension hosts -> frozen page/document contribution descriptors, never module internals
observability UI -> ObservabilityPort -> typed Tauri adapter
```

Allowed native directions:

```text
commands -> http/content/importing/persistence/security/oauth
http -> content contracts/store (for bodies), never persistence JSON shapes
response -> content store
persistence -> content store + security + project files
content -> security cipher abstraction + storage infrastructure
composition -> commands and managed implementations
commands/observability -> observability service
observability service -> native provider/correlation registries + scoped credentials + cache/content/http capabilities
native observability providers -> provider-neutral observability domain + constrained native capabilities
private native provider -> public Rust observability API + builder registration surface
```

Forbidden dependencies:

- public source importing `purr-commercial`, Datadog, CloudWatch, New Relic, Splunk, licensing, or enterprise policy modules;
- domain importing React, Tauri, SQLite, YAML, filesystem paths, CodeMirror, reqwest, or vendor DTOs;
- core UI switching on provider IDs such as `if (provider === "datadog")`;
- React/TypeScript implementing observability provider requests, parsing vendor payloads, resolving provider credentials, extracting correlation IDs, or owning provider caches;
- observability commands accepting plaintext credentials or returning raw Jaeger/Datadog/CloudWatch payloads;
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
- module-owned non-observability application services and protocol clients built only from constrained public ports or their own private native plugin;
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
- Every observability provider is native Rust, including providers that only call an HTTP API. This keeps plaintext credentials, vendor payloads, correlation and cache policy outside the WebView and gives public and commercial providers one execution model. A matching frontend contribution may provide label/icon/settings UI, but cannot execute or wrap the provider.
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
  integrations: IntegrationPresentationRegistrar;
  pages: ExtensionPageRegistrar;
  documentTypes: WorkspaceDocumentTypeRegistrar;
}
```

The frontend registry deliberately has no executable trace-provider, log-provider, correlation-extractor, credential-resolver, or provider-cache contract. Its integration contribution is presentation metadata and, when Phase 14 needs it, a typed settings editor. Executable observability registration belongs to the Rust builder and native registry described in E.3. Log, schema-registry, external-credential-provider, response-panel, or policy registries are added only with their first real use case; do not create empty registries for every possible product idea.

Registration occurs once in `createPurrApp()`. The builder rejects duplicate module/provider IDs, validates API versions, and freezes registries before rendering. No module discovery, dynamic loading, service locator, or global singleton is needed.

Separate the Rust provider contract from optional React UI contributions. The native provider supplies its stable ID, capabilities, config version/validation/migration, and executable behavior. A frontend contribution with the same stable ID supplies label/icon and an optional settings editor. The native registry is authoritative: if the presentation exists without a matching native provider, the integration remains unavailable, and official-build CI must reject mismatched frontend/native manifests. The settings editor receives typed form state and public UI primitives through documented imports; domain/application code never imports it, and authoritative config validation remains native.

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

The context is capability-limited. It has no mutable `Workspace`, raw persistence backend, arbitrary secret lookup, registry mutation, router replacement, or unrestricted service locator. Frontend integration contributions do not receive credentials or provider factories. A private page can call its own private service directly; it registers that service with core only if a core workflow needs a stable, provider-neutral capability. A private page must use the public observability port when it needs traces/logs rather than bypassing the native provider service.

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

The executable contract is Rust-owned. Phase 14 freezes the capability shape against Jaeger before Phase 15 exports it, but the ownership boundary may not move back into TypeScript:

Observability has five separate layers. Do not collapse them into a vendor-specific provider or a single UI workflow:

1. **Workspace integration instance:** where data is read from, its enabled state, versioned opaque config and `SecretRef` credential slots. One instance may expose several capabilities, for example Datadog traces and logs.
2. **Outbound trace propagation:** an optional native policy that generates or accepts trace context and prepares W3C Trace Context, B3 or provider-specific propagation fields immediately before transport. This is separate from fetching a stored trace and from choosing an observability backend. W3C is the default portable format; an integration may contribute additional formats without adding vendor branches to request UI. The effective propagation selection may be inherited at workspace/folder/document scope, but Rust validates it, generates IDs and injects the final headers. An explicit user header is preserved unless an explicit conflict policy says otherwise. Native request metadata records the effective injected context so Request/Timeline and later correlation use what was actually sent.
3. **Correlation resolution:** native extractors examine the saved request/response metadata and bounded content to produce ordered trace-reference candidates with their source/provenance. Extraction does not assume that a request-side ID is the final backend trace ID.
4. **Data capabilities:** capability-specific Rust contracts fetch and normalize traces, logs or later metrics. They share the integration instance and scoped credentials but remain separate traits/services rather than one growing provider interface.
5. **Presentation:** React renders bounded provider-neutral projections and controls loading, cancellation, selection and navigation. It never propagates context, fetches vendor data, resolves credentials or interprets provider config.

Use distinct identities throughout the native use case:

- `injectedTraceId`: optional trace ID placed on the outbound request by Purr (or recorded from an explicit user header);
- `lookupReference`: the ordered manual/request/response/body candidate used for a provider query, including its source and propagation format;
- `resolvedTraceId`: the canonical trace ID returned by the provider after lookup.

These values may match but are not required to. Provider normalization validates `resolvedTraceId`; core must not reject a result merely because it differs from the injected or lookup ID. The bounded IPC result may include the three provider-neutral values and provenance needed to explain correlation to the user, never raw provider fields.

The native registry must support one stable integration provider ID with multiple capabilities. Model this as a shared provider descriptor plus capability-specific registrations (`TraceProvider`, later `LogProvider`, and propagation/extraction contributions), not a monolithic trait with optional methods. Composition rejects duplicate capability registrations and inconsistent descriptors. Capability availability is exposed as a provider-neutral set so the frontend can show Trace or Logs surfaces without knowing whether the implementation is Jaeger, Datadog, Loki, or another adapter. Do not add `LogProvider` executable code until the first log use case, but freeze this registration shape before exposing the Rust builder in Phase 15.

```rust
pub trait IntegrationProviderDescriptor: Send + Sync {
    fn id(&self) -> ProviderId;
    fn capabilities(&self) -> CapabilitySet;
    fn config_version(&self) -> u32;
    fn validate_and_migrate_config(
        &self,
        version: u32,
        config: JsonValue,
    ) -> Result<ValidatedProviderConfig, ProviderError>;
}

pub trait TraceProvider: Send + Sync {
    fn provider_id(&self) -> ProviderId;
    async fn get_trace(
        &self,
        context: &ProviderContext,
        reference: &TraceReference,
        cancellation: &CancellationToken,
    ) -> Result<Option<Trace>, ProviderError>;
    async fn search_traces(
        &self,
        context: &ProviderContext,
        query: TraceSearchQuery,
        cancellation: &CancellationToken,
    ) -> Result<Page<TraceSummary>, ProviderError>;
}

pub trait TracePropagator: Send + Sync {
    fn id(&self) -> PropagatorId;
    fn provider_id(&self) -> Option<ProviderId>; // None for shared W3C/B3 propagators
    fn prepare(
        &self,
        policy: &PropagationPolicy,
        existing_headers: &HeaderView,
    ) -> Result<InjectedTraceContext, PropagationError>;
}

pub trait CorrelationExtractor: Send + Sync {
    fn id(&self) -> CorrelationExtractorId;
    async fn extract(
        &self,
        exchange: &BoundedExchangeInput,
        cancellation: &CancellationToken,
    ) -> Result<Vec<TraceReference>, CorrelationError>;
}

pub struct ProviderContext<'a> {
    pub integration: &'a ValidatedIntegrationInstance,
    pub credentials: &'a ScopedCredentialResolver,
    pub http: &'a ProviderHttpClient,
    pub cache: &'a ObservabilityCache,
    pub content: &'a ResponseContentReader,
    pub logger: &'a ObservabilityLogger,
}
```

`Trace`, `Span`, `LogRecord`, `AttributeValue`, page/time-range types, correlation references, and normalized errors are public Rust domain concepts. They contain no Tauri, React, storage, or vendor types. Raw Jaeger/Datadog/CloudWatch requests and responses stay inside their Rust adapters. The TypeScript side has matching bounded display DTOs at the typed Tauri boundary; those DTOs are views of the native domain, not a second provider/domain implementation.

The native `ObservabilityService` owns the complete use case: load the integration definition, resolve the provider by stable ID, validate/migrate its config, create a workspace/integration/key-scoped credential resolver, extract correlation from request/response metadata or bounded content reads, apply cache and cancellation policy, execute provider HTTP, map the vendor payload, and return only normalized bounded results. Rust cache keys include workspace, integration, provider/config version, query/reference and relevant credential generation without storing plaintext. Cache entries have explicit size/TTL/invalidation limits and live in encrypted local storage when persisted.

The frontend `ObservabilityPort` accepts stable IDs, response/content references, bounded queries, cursors, and operation IDs. It never accepts plaintext credentials or raw provider config for execution and never returns vendor DTOs. React owns loading/error/empty states, selection, navigation, and rendering. It may request another bounded page or cancel an operation; it does not parse trace payloads, extract correlation, retry providers, or maintain the authoritative cache.

### E.4 Representative Jaeger vertical slice

```text
React Trace panel
  -> ObservabilityPort.findRelatedTraces(exchangeId, integrationId, operationId)
  -> typed Tauri command
  -> Rust ObservabilityService
      -> Rust CorrelationExtractorRegistry reads bounded exchange metadata/content
      -> Rust TraceProviderRegistry resolves integration.provider
      -> ScopedCredentialResolver resolves declared SecretRefs inside Rust
      -> JaegerProvider performs HTTP, parses/maps Jaeger DTO -> Trace/Span
      -> ObservabilityCache stores bounded normalized results
  -> bounded provider-neutral DTO
  -> React Trace panel renders it
```

The public built-in has two build-time halves with the same stable provider ID. The frontend half is presentation only:

```ts
export const jaegerModule: PurrExtensionModule = {
  manifest: { id: "purr.jaeger", extensionApi: 1, version: "..." },
  register(registrar) {
    registrar.integrations.register(jaegerPresentation);
  },
};
```

The public native composition registers execution:

```rust
core_builder()
    .register_integration_provider(JaegerDescriptor::new())
    .register_trace_provider(JaegerTraceProvider::new())
    .register_trace_propagator(W3cB3Propagator::new())
    .register_correlation_extractor(W3cB3CorrelationExtractor::new());
```

A private Datadog module follows the same split. Its React half contains settings/presentation only:

```ts
export const datadogModule: PurrExtensionModule = {
  manifest: { id: "commercial.datadog", extensionApi: 1, version: "..." },
  register(registrar) {
    registrar.integrations.register(datadogPresentation);
  },
};
```

Its private Rust crate depends on the public Rust observability API and registers `DatadogProvider` with the official builder. The official entry passes `datadogModule` to `createPurrApp` and adds `DatadogProvider` to `core_builder()`; no public file changes. Datadog credentials, HTTP, raw DTOs, correlation rules, cache and normalization remain in the private Rust crate. The frontend cannot invoke a provider-specific command; it uses the same public `ObservabilityPort` as Jaeger.

### E.5 TypeScript/Rust shared contracts

Do not create a common npm package for IPC. Keep one checked-in TypeScript boundary in `src/platform/tauri/contracts.ts` and matching concrete serde DTOs beside the Rust capability. Add:

- a `protocolVersion` on multi-step response/content protocols and versioned stored descriptors;
- Zod decoding for untrusted/complex command results rather than relying on `invoke<T>` casts;
- fixture-based contract tests serialized by Rust and parsed by TypeScript for HTTP, content operations, imports, and persistence descriptors;
- stable command names collected in the Tauri adapter, not scattered string literals;
- provider-neutral, bounded observability commands/results with protocol versions and runtime validation;
- `workspaceId`/`integrationId`/exchange or content references across observability IPC, never plaintext credentials or an arbitrary provider execution payload;
- provider-specific DTOs kept wholly inside their Rust adapter crate/module and never exposed through IPC or the core observability domain.

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
  commercial frontend presentation/settings modules
  commercial Rust observability providers
  optional private protocol Tauri plugins
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

The private repo owns composition scaffolding plus commercial modules: its own `index.html`, Vite entry, package/Cargo manifests, `tauri.conf.json`, official branding, `main.rs`, private Rust observability providers or protocol adapters, frontend presentation/settings modules, module-owned services, and contributed UI. That shell and the commercial features are expected private source; no public feature, domain, persistence, shell, router, or workbench source is duplicated.

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

The precise Cargo relative path depends on whether the private manifest is at the root or under `src-tauri`; CI must use the same sibling checkout layout. The private app imports `createPurrApp`, compiled public styles, and `extension-api`, then supplies `commercialModules`. Those frontend modules may register integration presentation/settings, pages/navigation, private UI services, and extension document/protocol types through the same build-time call. Its `main.rs` augments `purr_lib::core_builder()` with private Rust observability providers and any private protocol plugins, then calls the public run helper with the private crate's `tauri::generate_context!()` result. Stable provider IDs link frontend presentation to native execution; they do not create a frontend provider dispatcher.

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

Status: DONE

Implemented in: Phase 9 working tree based on `cf80691`.

Started: 2026-09-16

Completed: 2026-09-16

Automated verification:
- [x] Add direct-save tests proving response content is written from a content ID without base64 returning to JavaScript.
- [x] Add byte-for-byte native request-body tests for large binary, multipart files, redirect replay, stale handle, and handle cleanup cases.
- [x] Run media/range protocol tests, request body/auth tests, UI tests, TypeScript checks, and Rust checks.

Manual verification:
- [x] Run `npm run fixture:responses`, send `/response/binary?size=104857600`, choose Download, and compare the saved file's SHA-256 with a direct fixture download; Purr must remain interactive while Rust writes the file.
- [x] Send `/media/image.svg`, `/media/audio.wav`, and `/media/video.mp4`; confirm the image renders, both players load, and seeking audio/video works. Inspect the media element URL if needed: it must start with the native `purr-content` protocol rather than `data:`.
- [x] Create a synthetic file, record its size and SHA-256, then POST it as Binary to `/upload/echo`; confirm the JSON `size` and `sha256` match.
- [x] Send the same file as a multipart file with a text field to `/upload/echo`; confirm `multipart` reports the exact field name, filename, content type, size, and hash.
- [x] POST the same Binary body separately to `/upload/redirect307` and `/upload/redirect308`; each final JSON must contain `redirectReplay.matches: true`, retain method `POST`, and complete without a stale-file error.
- [x] In one saved request, select a 32 MiB Binary file, switch to Form-Data, type in a text field, add another row, and toggle its type/enabled state; every edit must appear immediately while autosave keeps the inactive Binary selection.
- [x] Send that multipart request to `/upload/echo`; it must complete without a missing `media_type` error and report the expected text/file metadata, size, and SHA-256.
- [x] With the 32 MiB Binary selection still present, open Request Code/cURL; the dialog must open immediately and show only the filename/type/size summary, without reading or rendering the file bytes.
- [x] Quit and relaunch Purr with that 32 MiB inactive Binary selection. The workspace must open without a multi-second WebView stall; switching to the document and editing its active Form-Data fields must remain immediate.

Implementation notes:
- Native response references now save through `response_content_save`: the encrypted content worker decrypts bounded windows into a temporary destination file and atomically persists it without returning body bytes to JavaScript. Inline/browser compatibility downloads retain their existing path.
- Referenced image/audio/video responses use an allowlisted `purr-content` protocol with opaque IDs, ready-handle/media-type validation, `GET`/`HEAD`, and closed/open/suffix byte ranges. UI media elements receive the protocol URL; generic referenced binary responses expose metadata and direct save.
- Binary and file-bearing multipart bodies are staged from a Web `File` in 256 KiB raw IPC chunks, registered under random execution-scoped handles, and streamed/reopened by Reqwest. Transient files use owner-only Unix permissions. Rust rejects stale, incomplete, out-of-order, oversized, or metadata-mismatched handles; `executeRequest` releases handles after success, failure, or cancellation, TTL cleanup removes abandoned live-process entries, and startup removes crash leftovers.
- Added synthetic local image/audio/video range fixtures plus binary/multipart echo and 307/308 replay fixtures. Fixture responses expose byte counts and SHA-256 values and never persist uploaded data.
- Product-owner testing found two Phase 9 regressions: multipart text-part `mediaType` was not mapped to Rust `media_type`, and Request Code plus editor autosave could materialize/repeat a large inactive `File`. The Rust enum now accepts camel-case variant fields; Request Code selects a byte-free summary mode; working-copy files are stored once in encrypted immutable `attachments` rows and referenced from small draft/session records, with cooperative first encoding.
- Product-owner retesting confirmed multipart submission, Form-Data editing, and Request Code behavior, then exposed a 3–4 second workspace-open regression. Native persistence now returns attachment metadata instead of base64 during workspace load. The restored lazy `File` keeps its opaque workspace/attachment identity; native send decrypts and stages it entirely in Rust, while only explicit canonical save requests raw bytes.
- Product-owner verification on 2026-09-16 confirmed the metadata-only restart path: the workspace opens normally, the restored attachment remains usable, and the affected editor workflows remain responsive.
- Product-owner verification on 2026-09-16 also confirmed direct 100 MiB download integrity/responsiveness, native image/audio/video playback and seeking, and repeatable Binary request bodies across 307/308 redirects. All Phase 9 manual acceptance criteria are complete.
- Automated verification passed after the regression fixes: `npm test` (149), `npm run test:ui` (60), `npm run typecheck`, `npm run lint`, `npm run build`, `npm run check:repo`, `cargo fmt --all -- --check`, `cargo check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` (76), and `git diff --check`. The earlier fixture range/upload smoke result remains valid; exact tests cover the corrected multipart DTO, metadata-only native attachment restore/autosave, direct Rust staging, and byte-exact explicit attachment reads.

Deviations from plan:
- The response download/media and request-body changes are kept in one Phase 9 working-tree change set instead of two PRs because the shared port/composition contract must remain buildable throughout this branch. They remain separate adapters/modules and can be reviewed as two logical halves.

Known follow-ups:
- Small inline/text-only bodies intentionally keep the existing serializer. Browser development and legacy inline response downloads remain full-body compatibility paths because native handles are a desktop capability.
- Web file inputs do not expose a trusted native path, so selected request files cross into the native cache as bounded raw chunks. A future native file-picker/import handle can remove that staging time without changing `RequestBodyPort` or the Rust transport model.
- The JSON-based local persistence port still reads and encodes a newly selected working-copy file once. Cooperative encoding and immutable attachment references prevent event-loop monopolization and repeated draft/session copies; restored attachments no longer cross WebView memory during open or native send. A future native file-selection/local-attachment port could also remove the initial WebView copy without changing canonical assets or request transport handles.
- Full-body clipboard copy remains disabled for opaque large content; implementing it without reconstructing the body in JavaScript requires a separate bounded native clipboard capability and is not part of this phase's acceptance criteria.
- The checked-in Tauri CSP remains `null` as it was before this phase. The pre-public CSP task must explicitly allow `purr-content:`/its platform-mapped origin for `img-src` and `media-src`, then rerun the Phase 9 media scenarios.

- **Objective:** cover native download, media preview, and large request bodies with handles.
- **Files/modules affected:** current `downloads.rs`, response preview/download components, request body/file UI, `prepareWireRequest`, Rust `http/request_body.rs`, platform file/body port.
- **Changes:** save response directly from content ID; serve range-capable image/audio/video through a safe handle protocol; introduce scoped request file/body handles; keep small inline text bodies simple; stream native file and multipart parts into reqwest; make body sources repeatable for 307/308 redirects; clean abandoned handles.
- **Risk:** arbitrary path access, stale file handles, multipart incompatibility, redirect replay, media CSP. Handles are created only by approved file selection/import, contain no path in domain state, validate ownership/TTL, and have byte-for-byte transport fixtures.
- **Verification:** a large download does not cross WebView memory; media seek/range works; large binary/multipart upload avoids `arrayBuffer` and base64; small text/auth behavior remains identical.
- **Scope:** L, at least two PRs: response download/media then request bodies.

### Phase 10 — profile and isolate GraphQL analysis

Status: DONE

Implemented in: Phase 10 working tree based on `175ab8b`.

Started: 2026-09-16

Completed: 2026-09-16

Automated verification:
- [x] Record schema parse duration, UI long tasks, and memory for the Phase 0 small/large schema fixtures. The non-CI Node run records 40/1,200-type normalization at 1.9/15.6 ms, normalized-SDL parse at 1.5/18.0 ms, and process peak RSS at 81.6/138.8 MiB. Product-owner desktop profiling reported responsive/acceptable behavior and an approximately 10 ms UI-side schema parse; exact native/WebView RSS values were observed during acceptance but were not transcribed into the report.
- [x] Add worker request-ID/cancellation tests and regression tests for completion, hover, diagnostics, operation generation, and schema navigation. The worker client has deterministic stale-ID/abort coverage; the complete GraphQL UI suite covers existing editor and explorer semantics plus referenced introspection above 1 MiB.
- [x] Run GraphQL unit/UI tests, `npm run typecheck`, `npm run lint`, `npm run build`, and Rust checks if a native service is introduced. `npm test` passed 151 tests, `npm run test:ui` passed 61 tests, and typecheck/lint/build/repository policy passed. Although no native service was introduced, Rust fmt/check/clippy and all 76 Rust tests also passed.

Manual verification:
- [x] Start `npm run fixture:responses`, load `http://127.0.0.1:43119/graphql/introspection?types=1200` into a schema, and confirm the explorer becomes usable without freezing. Download that schema as SDL, import the downloaded synthetic file into another schema, and confirm both sources work.
- [x] With the 1,200-type schema linked, type a query, and verify completion, hover, diagnostics, operation generation, “Fill all fields,” and schema type/field search remain responsive. Web Inspector reported an approximately 10 ms UI-side schema parse and no product-visible responsiveness problem.
- [x] Link two requests to schemas with distinct root fields, switch between their tabs, and confirm completion, hover navigation, diagnostics, and schema navigation use only the active request's schema.
- [x] Introspect the 1,200-type fixture, pin the schema SDL, quit Purr and stop the fixture server, then restart Purr. Confirm the pinned explorer, search, completion, and hover work offline.
- [x] Start a schema reload and immediately close or switch away from the schema tab; confirm Purr remains responsive, no cancelled/stale schema replaces the previously installed schema, and returning to the tab allows Reload to succeed.

Implementation notes:
- Introspection/file source normalization now runs in a dedicated Web Worker. Each analysis receives a monotonically increasing request ID; replacement, abort, or component disposal terminates the active worker and stale responses cannot install a schema.
- Native introspection responses above the 1 MiB inline boundary are materialized through bounded `ResponseContentPort` reads, released immediately, and then sent to the worker. This removes the previous explicit large-introspection failure without adding a GraphQL-specific transport path.
- The main window records `purr.graphql.schema.worker-round-trip` and `purr.graphql.schema.parse` performance entries for desktop profiling. The benchmark separately records normalization and normalized-SDL parse, with no pass/fail timing threshold.
- The existing `GraphQLSchema` remains the one editor/explorer model. Completion, hover, diagnostics, operation generation, variable hints, and navigation retain their tested synchronous semantics.
- Automated verification completed on 2026-09-16: 151 TypeScript unit/integration tests, 61 Playwright tests, typecheck, lint, production build, repository policy, non-CI benchmark, Rust fmt/check/clippy, 76 Rust tests, and `git diff --check` passed.
- Product-owner verification on 2026-09-16 accepted every Phase 10 scenario. Large introspection/SDL loading, editor intelligence, active-schema isolation, offline pinned restoration, and cancellation all worked as expected; the captured UI-side parse measurement was approximately 10 ms.

Deviations from plan:
- The worker boundary is deliberately narrower than moving all language-service calls. Measurements show the 1,200-type normalized SDL parses in about 18 ms and the Phase 0 desktop baseline reported no editor responsiveness failure. Moving completion/hover/diagnostics would add replicated schema state and async editor races without evidence that it solves a current problem. Source JSON parse, schema construction/validation, and normalization—the large installation work—are isolated first as the plan's evidence-based rollout requires.

Known follow-ups:
- The worker still receives the complete introspection source and returns complete normalized SDL. Add Rust `graphql/*` with compact/paged explorer DTOs only if a future larger real-world schema demonstrates a responsiveness or memory failure; merely parsing in Rust and reconstructing the same full `GraphQLSchema` would not help.

- **Objective:** improve large-schema responsiveness based on evidence without duplicating GraphQL semantics.
- **Files/modules affected:** GraphQL model/editor/explorer and optional worker; Rust only if the second tier is justified.
- **Changes:** collect Phase 0 schema metrics; first move parse/validate/language-service work to a Web Worker with versioned request IDs and cancellation. If WebView memory is still above the agreed budget, design the narrower Rust `GraphqlSchemaService` described in B.5 and migrate explorer pages before editor hints.
- **Risk:** worker message copies and stale diagnostics; a Rust service could lose feature parity. Transfer compact results, discard stale request IDs, and keep the existing synchronous path for small schemas during rollout.
- **Verification:** no editor long task above the chosen budget on the large fixture; completions/hover/diagnostics/operation generation match current tests; no Rust GraphQL module is added if the worker solves the problem.
- **Scope:** M for profiling/worker; separate L project only if justified.

### Phase 11 — migrate the canonical integration envelope

Status: DONE

Implemented in: Phase 11 working tree based on `e721a5d`

Started: 2026-09-16

Completed: 2026-09-16

Automated verification:
- [x] Add canonical/YAML fixtures for legacy endpoint integrations, unknown provider config, disabled integrations, and secret refs.
- [x] Run projection/restore validation proving unknown config round-trips without mutation and cross-workspace secret refs fail.
- [x] Run persistence, import, TypeScript type/lint/build, and Rust checks.

Manual verification:
- [x] In a disposable workspace, load `tests/fixtures/projects/integration-legacy.yaml` after replacing its synthetic workspace ID; restart Purr and inspect the YAML to confirm `endpoint` migrated under `config` without losing credentials or unrelated fields.
- [x] Load `tests/fixtures/projects/integration-private.yaml` the same way; confirm Purr preserves its nested config, shows it as unavailable, and does not expose credential values.
- [x] Disable and re-enable the unavailable provider, restart Purr, and confirm its configuration remains intact.
- [x] Start deletion of the disposable unavailable integration, cancel once and confirm it remains; confirm deletion on the second attempt and verify only that integration YAML is removed.

Implementation notes:
- `integrationDefinitionSchema` now owns only the generic envelope: stable provider ID, enable state, positive config version, opaque JSON config, and explicit credential slots.
- Loading a legacy top-level `endpoint` schedules a canonical rewrite to `config.endpoint`; provider-owned config bypasses recursive core YAML compaction so unknown fields and values round-trip unchanged.
- Core checks workspace ownership only for credentials declared in the envelope. It does not interpret secret-shaped objects inside opaque provider config.
- Workspace settings expose unavailable integrations for enable/disable and confirmed deletion without rendering config or resolving credential values.
- Automated verification completed on 2026-09-16: 153 TypeScript unit/integration tests, 62 Playwright tests, typecheck, lint, production build, repository policy, Rust fmt/check/clippy, 76 Rust tests, and `git diff --check` passed.

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

Status: DONE

Implemented in: Phase 12 working tree based on `2f5e3b4`

Started: 2026-09-16

Completed: 2026-09-16

Automated verification:
- [x] Add conformance tests for a fake external module importing only documented public exports and contributing integration presentation metadata, a namespaced page/navigation entry, module-owned service, and extension document type.
- [x] Add boot tests for duplicate module/integration-presentation/page/document-type IDs, route collisions, incompatible API versions, registry freeze, and zero optional modules.
- [x] Add canonical/local-state tests proving an unknown extension document round-trips unchanged in OSS, shows an unavailable state, and becomes editable again when its module is restored.
- [x] Run package export/build tests plus TypeScript unit/UI/type/lint/build and Rust checks.

Manual verification:
- [x] Launch the OSS app with no optional module configured and confirm all existing workspace/request/GraphQL workflows still start normally.
- [x] Run the example external fake-module shell, open its contributed navigation entry/page, execute its module-owned sample action, and confirm no public source file imports that module.
- [x] Create and save its fake protocol/document, restart, remove the fake module and confirm the unavailable document remains renameable/moveable/deletable with config intact; restore the module and confirm the editor/config returns.
- [x] Attempt to load an intentionally incompatible/duplicate fake module and confirm startup reports the precise module conflict without partially registering it.

Implementation notes:
- `createPurrApp({ modules })` is the build-time frontend composition root. The OSS entry supplies zero optional modules and remains fully functional.
- `@purr/core/extension-api` exposes versioned module, integration-presentation, namespaced page/navigation, and opaque workspace-document contracts. Page/document factories receive constrained HTTP/response-content/logger capabilities rather than the runtime workspace, storage, router, or feature internals. Executable observability contracts are intentionally absent from the frontend API.
- Composition snapshots module manifests, validates API versions and stable IDs, rejects duplicate integration presentations/pages/routes/document types atomically, and freezes registry views before React renders. Captured registrars reject late writes.
- Extension documents use a strict core envelope (`extensionType`, `configVersion`, opaque JSON `config`) under `documents/`. Saved baselines remain canonical; dirty working copies remain encrypted local records. Unknown documents render an unavailable host while core rename/move/duplicate/delete behavior stays available.
- The external conformance fixture imports only `@purr/core/extension-api` and `@purr/core/ui`; its shell composes through `@purr/core/app` and exercises module-owned navigation, page logic, a document editor, module removal/restoration, and boot conflicts.
- Automated verification completed on 2026-09-16: 156 TypeScript unit/integration tests, 64 Playwright tests, typecheck, lint, production build, repository policy, Rust fmt/check/clippy, 76 Rust tests, and `git diff --check` passed.
- The Rust-only observability boundary correction was re-verified on 2026-09-16 with all 156 TypeScript unit/integration tests, the two extension Playwright tests, typecheck, lint, production build, repository policy, and `git diff --check`. Rust sources did not change; the phase's prior Rust fmt/check/clippy and 76-test result remains applicable.
- Product-owner manual verification accepted the zero-module OSS build, contributed page/action, extension-document removal/restoration lifecycle, and duplicate-module startup failure on 2026-09-16.

Deviations from plan:
- After product-owner verification, the executable frontend trace-provider and correlation-extractor seams were removed before Phase 13. They conflicted with the required Rust-only observability boundary. The integration registry now holds presentation metadata only; native provider/correlation registration is reserved for Phases 13–15. This narrows the API without changing the verified page/document/persistence behavior.

Known follow-ups:
- Keep settings embedded inside existing screens, response panels, workspace actions, and request-policy hooks out of the API until a concrete module needs each named surface.
- Phases 13–14 validate the Rust provider/observability API and connect it to the frontend presentation half with Jaeger.
- Package exports currently target reviewed source entry points inside this private migration package; Phase 15 still owns compiled distributable artifacts, Rust builder surfaces, and cross-repository consumption/versioning.

- **Objective:** provide the supported frontend build-time registration seam for integration presentation and independently owned feature modules; executable observability composition is native.
- **Files/modules affected:** `src/integrations/{contracts,registry}.ts`, `src/extension-api/*`, `src/app/composition/*`, `src/app/app-router.tsx`, generic extension document domain/host files, package exports, conformance tests.
- **Changes:** implement module, integration-presentation, page/navigation, and workspace-document-type registries; add the opaque extension-document envelope and unavailable host; validate IDs/API versions/routes/duplicates; freeze at startup; expose a curated barrel, public UI primitives, and test kit. Page/document factories receive constrained contexts. Do not export executable observability providers, runtime `Workspace`, raw storage/secrets, the router, or core feature components.
- **Risk:** the API becomes a dump of internals or a universal plugin framework. Keep page routes namespaced, document persistence opaque, services module-owned, and every cross-core hook named. Split presentation registries and page/document composition into two sequential PRs if review size grows.
- **Verification:** a fake external module registers integration presentation, a page, private service action, and document type without internal imports; an unknown document survives without the module; duplicates and incompatible API versions fail atomically; the app with zero optional modules is fully functional.
- **Scope:** L, preferably two sequential PRs: base/presentation registries, then page/document composition.

### Phase 13 — add provider-neutral observability use case and UI

Status: DONE

Implemented in: Phase 13 current working tree based on `44781e0`; implementation and product-owner verification complete.

Started: 2026-09-16

Completed: 2026-09-16

Automated verification:
- [x] Add Rust Trace/Span normalization and shared DTO fixture tests, a domain dependency guard, and duplicate-registry tests; the consuming builder exposes no post-build registration. Log models/API remain deferred to the first log use case, as specified below.
- [x] Add Rust service tests using two fake native providers and fake correlation extractors without provider-ID branches in core code, including scoped credentials, cache invalidation/TTL, pagination, cancellation, and oversized-result rejection.
- [x] Add IPC contract/UI tests proving the React side receives only bounded normalized DTOs and can cancel a native operation without receiving credentials, raw integration config, or vendor payloads.
- [x] Run `npm test` (159), full Playwright suite (66), typecheck, lint, build, repository policy, Rust fmt/check/clippy and tests (88 in each default/`observability-fixtures` build); repeat the two observability UI tests after final DTO changes.

Manual verification:
- [x] Configure two fake native provider integrations, send a request with a fixture `traceparent` or B3 header, and confirm the Trace tab shows the normalized trace from the selected integration.
- [x] Save a fake provider credential, restart Purr, and confirm trace lookup still succeeds while the integration YAML contains only its `SecretRef`, never the plaintext value.
- [x] Open a response with no correlation data and confirm the Trace tab explains that no trace was found rather than exposing a vendor-specific error.
- [x] Start a deliberately delayed fake trace lookup, cancel or navigate away, and confirm the response view remains usable with no stale trace result.
- [x] Use trace pagination/search fixtures and confirm service, operation, timestamps, status, and attributes render without provider field names leaking into the UI.
- [x] Change the selected integration config or credential after a successful lookup and confirm the next lookup does not reuse the stale cached result.

Implementation notes:
- Rust owns canonical integration loading/defaults, authoritative provider availability/config validation, declared-key credential resolution, W3C/B3 correlation, provider calls, normalized typed attributes, cache policy, span filtering/pagination, cancellation, and safe errors. React receives only summaries and versioned display pages through `ObservabilityPort`.
- Correlation reads the exact saved execution by workspace/document/start timestamp through a bounded, read-only encrypted metadata query. It never restores the response body or returns credentials to React. Native extractors may opt into a bounded 64 KiB content prefix; standard header extraction does not read content. Lookup tolerates the existing save debounce for up to one second and reports a retryable missing-save state. Ordinary request execution/display is unchanged.
- Limits: four concurrent lookups, 15-second deadline, at most 1,000 spans/64 KiB per normalized trace, 25 spans per page; memory cache has 32 entries and 60-second TTL. Config/credential changes alter its key, credentials are re-resolved before hits, and cursors bind the response/query/cache generation.
- `test.trace-alpha` and `test.trace-beta` are opt-in native fixtures behind `observability-fixtures`; the normal OSS build registers no concrete provider. No real Jaeger/network integration was started. Setup and owner scenarios: [Phase 13 verification](testing/phase-13-observability.md).
- Validation on 2026-09-16: all checks above passed. The first full UI run with seven workers had one failure in the existing GraphQL autocomplete test (`Fill all fields`); it passed in isolation and the complete suite passed 66/66 with two workers, without GraphQL code changes. Existing Vite chunk-size/annotation warnings remain non-blocking.

Deviations from plan:
- Search/pagination currently cover spans inside one response-linked trace, not provider-wide trace discovery. This follows the smallest usable Phase 13 slice; Phase 14 must validate any provider-side search contract against Jaeger. No speculative logs API was introduced.
- Synthetic credentials are provisioned with generated DevTools statements and canonical fixture YAML rather than a provider settings editor. The real editor remains in Phase 14. The fixture generator refuses an existing output directory and contains only synthetic data.

Known follow-ups:
- Keep persisted cache optional and bounded until Jaeger demonstrates the required lifecycle; the cache abstraction and ownership still belong to Rust from this phase.
- Phase 14 adds outbound propagation and separates injected/lookup/resolved trace identity before implementing native Jaeger HTTP/vendor parsing. It also validates the multi-capability provider descriptor while keeping logs unimplemented until a real log use case. Phase 15 exposes the resulting external Rust composition surface.
- The Phase 13 table is a contract-validation UI. Phase 14 replaces it with a useful provider-neutral hierarchy/details view; a sophisticated waterfall, cross-trace navigation and logs UI remain separate product work unless the Jaeger validation demonstrates that they are required for a usable first release.

- **Objective:** prove that Trace/Span/Log are vendor-independent while all observability execution and business policy stay in Rust.
- **Files/modules affected:** new `src-tauri/src/observability/{domain,registry,service,correlation,cache,credentials}.rs`, `commands/observability.rs`, native composition, `src/domain/observability.ts` as bounded display DTOs, `src/application/ports/observability.ts`, Tauri adapter/contracts, new observability UI components, response-tab extraction, fake native-provider tests.
- **Changes:** define the public Rust normalized models, provider/extractor traits, immutable registries, scoped credential capability, bounded cache contract, operation IDs/cancellation and provider-neutral errors. Add one `ObservabilityService` that owns integration loading, config validation/migration, credential resolution, correlation extraction, cache policy and provider calls. Expose bounded typed commands through a thin TS `ObservabilityPort`; replace the disabled Trace placeholder with provider-neutral UI driven by two fake Rust providers. Add logs only when the first real log use case requires them.
- **Risk:** duplicating the use case in TypeScript or designing broad contracts from hypothetical providers. TypeScript may coordinate UI state only. Start with response-linked trace lookup and the search/pagination needed by Jaeger; keep provider capabilities explicit and return handles/pages for potentially large data.
- **Verification:** Rust service tests use two fake providers with no provider-ID branches; IPC/UI tests prove only normalized bounded DTOs cross into React; credentials/config/raw vendor DTOs never cross IPC; cancellation and cache invalidation are native; the Rust domain imports no Tauri or vendor code.
- **Scope:** M–L, one or two PRs.

### Phase 14 — implement Jaeger as the public validation adapter

Status: DONE

Implemented in: `architecture-migration` uncommitted working tree based on `0bf5295`, reviewed 2026-09-17.

Started: 2026-09-16

Completed: 2026-09-17

Automated verification:
- [x] Add Rust contract tests for W3C/B3 outbound propagation, user-header conflict policy, and distinct injected/lookup/resolved trace IDs; prove a provider may return a valid resolved ID different from the lookup reference.
- [x] Add a shared provider descriptor and capability-specific native registration tests proving one integration ID can expose traces plus a fake second capability without creating a monolithic provider trait or frontend vendor branch.
- [x] Add Rust Jaeger adapter fixtures for configuration migration/validation, scoped credential resolution, correlation extraction, normalized trace/span mapping, bounded errors/results, cache behavior, pagination, and cancellation.
- [x] Run native registry and frontend presentation conformance tests with Jaeger plus a second fake provider, then remove both Jaeger halves from public composition in a build test.
- [x] Run OSS build, TypeScript tests/type/lint, and Rust checks.

Manual verification:
- [x] Prepare a local Jaeger instance or documented fixture endpoint containing a known trace and configure it through the new integration settings.
- [x] Enable Purr trace propagation, send requests using W3C and B3, and confirm the effective injected headers are visible in Request/Timeline without silently replacing an explicit user header.
- [x] Open the Trace tab and confirm it explains the injected/lookup/resolved identity when they differ, then verify spans, service names, duration, hierarchy and error status against Jaeger.
- [x] Confirm the provider-neutral hierarchy/details UI remains usable when switching integration, searching, paging and cancelling; no Jaeger field or label appears in core rendering logic.
- [x] Disable the Jaeger integration, restart Purr, and confirm the saved configuration persists while trace lookup becomes unavailable without breaking ordinary requests.
- [x] Run the OSS build with Jaeger removed from the core module list and confirm Purr still launches and sends HTTP/GraphQL requests.

Implementation notes:
- Native Jaeger Query API v3 adapter: bounded HTTP/OTLP JSON parsing, base-path support, none/bearer auth, scoped credential resolution, safe errors, no credential-bearing redirects. Standard W3C/B3 correlation remains provider-independent. Adapter config v1 supplies the backward-compatible auth default; unsupported versions fail explicitly.
- Split native `IntegrationDescriptor` from capability registration. One instance advertises capability labels; a fake second capability verifies composition without inventing a logs API. Propagators register independently from trace providers; missing custom formats fail explicitly.
- Added optional workspace/request `tracePropagation` preferences with saved-versus-working-copy round-trip coverage. Rust generates context immediately before transport, preserves explicit headers and returns injected header metadata. The existing redirect coordinator preserves generated context on same-origin hops and drops it on cross-origin hops. Generated IDs stay in encrypted execution metadata, not YAML.
- `TracePage` IPC v2 contains normalized correlation provenance and native ordered hierarchical rows. The viewer groups equal identity roles, separates row selection from details, retains ancestors during attribute search, and incrementally enriches one hierarchy. Query/provider/document changes cancel silently; explicit cancellation has a separate state. A future timeline column uses the same row/selection interface.
- The public frontend Jaeger module supplies presentation/settings only. Generic settings host calls native config validation and exposes a scoped write-only credential setter; no stored token is read back into React. Execution/config/cache policy remains native.
- Validation on 2026-09-17: `npm test` (162), full `npx playwright test --workers=2` (68), then the four observability UI tests after final presentation adjustments; `npm run typecheck`, `npm run lint`, `npm run check:repo`, `npm run build`; `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test --lib --quiet` in default, `--features observability-fixtures`, and `--no-default-features` variants (98/98/92 tests). Default/provider-free native builds and `VITE_PURR_JAEGER=disabled npm run build` verify adapter removal. Checked the synthetic `/echo` → Query v3 fixture and replacement-ID behavior directly; visually inspected the hierarchy/inspector screenshot from Playwright.
- During verification, corrected a URL-less TS test setup, ambiguous UI status selector, a synthetic TCP server that closed with unread request headers, and provider-free dead-code annotations. Required automated checks now pass; no unresolved automated failure is being hidden.
- Manual setup and expected results: [Phase 14 Jaeger verification](testing/phase-14-jaeger.md). The product owner completed the checklist on 2026-09-17 and additionally verified the adapter against a real test service with database/cache business spans. Trace hierarchy/details rendered the resulting trace, ordinary requests continued to work, and no secret value appeared outside secure storage.

Deviations from plan:
- Chose the documented stable Jaeger Query HTTP API v3 instead of its internal UI API; compatibility requires a query server exposing v3. One cohesive `providers/jaeger.rs` is sufficient, so no folder/crate split was introduced just for the adapter.
- Kept provider-wide trace discovery deferred: the validated use case is an execution-linked trace, with normalized span search. A standalone discovery endpoint/UI is not needed to satisfy this phase and must not be designed from hypothetical requirements.
- Propagation is opt-in (Off for existing projects) to preserve request behavior. This slice exposes workspace default + document override; the possible future folder override is not implemented. Stable format IDs and native registration preserve that extension path without moving generation or correlation into React.

Known follow-ups:
- Phase 15 exports the proven descriptor/capability/propagator/extractor composition surfaces. Other public/private providers must use them; no vendor branch belongs in the viewer. Custom propagation formats are registerable/preservable now; provider-contributed format choices can be exposed through bounded native metadata when an additional real format needs settings UI.
- Trace UX polish, a waterfall, events/links inspector, provider-wide discovery, logs, folder propagation UI and persisted trace cache remain product follow-ups. The current `not found` state has only user-triggered retry after the native one-second saved-execution wait; a future eventually-consistent-backend UX should use bounded cancellable polling and then expose an explicit Retry action.
- Integration authentication must remain provider-owned and Rust-executed. The current Jaeger editor validates the first concrete `none`/Bearer case; it must not freeze Bearer as a universal integration contract. Future providers may contribute provider-specific auth forms or reference a generic shared credential/auth profile, while reusing public auth UI primitives and `SecretRef`/scoped resolver contracts. OAuth/SSO token acquisition, refresh and enterprise credential providers remain native; stored secrets are never populated back into React fields. Phase 15 must preserve this extension path without exposing secure storage itself.
- The 4 MiB vendor payload and inherited 1,000-span/64 KiB normalized-trace budgets are explicit limits; do not silently truncate traces. No next migration phase was started.

- **Objective:** validate contracts, registry, configuration, credentials, normalized mapping, and UI end to end with a real public provider.
- **Files/modules affected:** `src-tauri/src/observability/providers/jaeger/*`, public Rust composition, `src/integrations/builtins/jaeger/*` for presentation/settings only, core frontend module composition, integration settings, observability IPC/tests/docs.
- **Changes:** first complete the native propagation/correlation identity split and capability descriptor required above. Then implement authoritative Jaeger configuration validation/migration, HTTP requests, scoped credential resolution, vendor parsing, trace mapping, correlation rules, bounded cache/results, errors/cancellation, and fixtures in Rust. Replace the validation table with a provider-neutral hierarchy/details view. The frontend half provides only label/icon/settings UI and submits config for native validation; it uses the public `ObservabilityPort` for execution.
- **Risk:** leaking Jaeger fields into core domain or widening the API for convenience. Keep raw DTOs under the adapter and change public contracts only when the use case cannot be expressed generically.
- **Verification:** Jaeger can be removed from both public frontend and Rust composition and the app still compiles; adding a second fake native provider changes no core UI/business files; no provider-specific IPC DTO exists; public standalone build works.
- **Scope:** L, several provider-focused PRs.

Phase 14 UX acceptance (owner clarification): the viewer is execution-centric, with provider selection as secondary context. Rust supplies reusable hierarchical rows, normalized correlation provenance, and search matches plus their ancestors. React owns row selection/collapse and a separate inspector; the row interface permits a future timeline column. Equal injected/lookup/resolved IDs collapse to one presentation; differences remain explicit. Changing document/provider/query silently cancels stale work; explicit cancellation has its own state. Incremental pages enrich the same trace hierarchy. Multi-capability integrations appear once with capability labels. Provider configuration/branding stays outside the normalized viewer.

### Phase 15 — expose reusable frontend and Rust composition surfaces

Status: DONE

Implemented in: Phase 15 working tree based on `d420e98`; existing `purr_lib` precursor.

Started: 2026-09-17

Completed: 2026-09-17

Automated verification:
- [x] Build the OSS app and the deterministic core JavaScript/type/CSS artifact from a clean checkout.
- [x] Build an example external shell through reviewed `./app`, `./extension-api`, `./ui`, and `./styles` exports, with one fake module contributing a page/navigation entry, module-owned service and extension document type, plus one fake native observability provider registered through the public Rust builder.
- [x] Run package export checks, React-singleton check, TypeScript tests/type/lint/build, and Rust fmt/clippy/test.

Manual verification:
- [x] Launch the normal OSS binary and verify existing workspaces, REST/GraphQL requests, persistence, downloads, and OAuth still work with the thin public `main.rs`.
- [x] Launch the example consumer shell using its own Tauri configuration/capabilities and confirm its page, navigation entry, fake protocol/document editor, module-owned action, and native-plugin call work without copying public source files.
- [x] Inspect the consumer build output and confirm public styles/assets load and no duplicate-React hook error occurs.
- [x] Remove the example consumer checkout and confirm the public OSS build remains independently runnable.

Implementation notes:
- `npm run build:core` emits deterministic ESM, declaration, CSS and GraphQL worker assets in `dist-core`; package exports no longer target source. React/React DOM are external peer dependencies. `check:core-package` validates exported paths, singleton resolution, unsupported deep imports and the external consumer; `check:core-determinism` compared 139 emitted files over two consecutive builds.
- `core_builder()` returns a constrained `PurrBuilder`: external shells may add typed Tauri plugins and normalized observability descriptors/providers/extractors/propagators before supplying their own `tauri::Context`. The command list, managed storage, SQLite and secret constructors remain private. `native_extension_api` exposes scoped read-only provider credentials and normalized trace contracts only.
- The OSS `main.rs` is a thin `run(generate_context!())` caller. The external fixture owns its frontend/native entries, Tauri config/capabilities/icon, dedicated native plugin, settings/presentation module, page/service/document type, and fake Rust trace provider without copying application source.
- The core library uses a relative asset base so a consuming Vite build relocates the GraphQL worker into its own output. External shells must declare `tauri-plugin-dialog` and `tauri-plugin-opener` directly so Tauri can resolve their ACL manifests while generating the final context.
- Automated verification on 2026-09-17: `npm test` (162), `npm run test:ui` (68), typecheck, lint, repository policy, OSS production/core builds, package/consumer check, two-build artifact determinism; Rust fmt, core and external-consumer clippy with warnings denied, 98 all-feature tests, and provider-free check all passed.
- Product-owner verification on 2026-09-17 accepted the external page/service/native-plugin action, extension document lifecycle, external trace provider, shared styles/single React runtime, and the independent OSS workspace/request/GraphQL/persistence/download/OAuth workflows.

Deviations from plan:
- The external module also imports the already approved `./ui` export from Phase 12, and the compiled package retains the approved `./test-kit` export. This preserves the existing extension contract rather than forcing consumers to duplicate Purr controls; neither export exposes executable core services.
- The fake native action is a dedicated Tauri plugin crate with its own generated permission instead of a public generic command-registration callback. This keeps the command dispatcher closed as required.

Known follow-ups:
- Phase 16 consumes these exports from the real private repository and pins compatible npm/Cargo core versions. It must retain direct final-shell dependencies for public Tauri plugin ACL discovery.

- **Objective:** make the exact public source consumable by the official shell.
- **Files/modules affected:** root package exports/build, `src/app/create-purr-app.tsx`, Rust `lib.rs`, `composition.rs`, `main.rs`, OSS Tauri config.
- **Changes:** expose `./app`, `./extension-api`, `./styles`; add the deterministic core library/CSS/type build; keep React a single peer instance; document supported imports; export `core_builder()`, native observability provider/extractor traits and a constrained registration method, plus a run helper that accepts the caller's Tauri context; make the OSS `main.rs` a thin caller; support adding Tauri plugins/providers before run. Keep public app build as the contract test. Do not expose raw secure storage, SQLite, or a generic command dispatcher to private providers.
- **Risk:** Vite/Tailwind asset resolution and Tauri context assumptions from a sibling dependency. Add an example consumer fixture inside public CI before creating the private repo.
- **Verification:** example shell composes one external presentation/page/document module and matching fake native provider without copying source; the frontend extension imports only public exports, the Rust provider uses only the public builder/provider API, and the OSS build remains identical in behavior.
- **Scope:** M, one PR.

### Phase 16 — create `purr-commercial` and official build composition

Status: PARTIALLY DONE

Implemented in: Local Git repository `../purr-commercial`, branch `main`; the exact public core revision is pinned in its `core-version.json`.

Started: 2026-09-17

Completed: —

Automated verification:
- [x] Run the private compatibility script against the exact public SHA/API versions in `core-version.json`.
- [x] Build/test the official shell with no private modules/providers/plugins; verify its frontend imports only the public app/styles exports and its Rust entry uses only `core_builder()`.
- [ ] Run the public OSS build in a checkout with no private sibling, then run official build/signing smoke checks with credentials injected only by CI/local secure configuration.

Manual verification:
- [ ] Prepare sibling `purr/` and `purr-commercial/` checkouts at the pinned revisions; launch OSS Purr from the public checkout and confirm it works with no private directory present.
- [ ] Launch the official shell and confirm there is no commercial navigation, extension header, private document type, private integration/provider, or fixture command.
- [ ] Open or reload a GraphQL schema in the official shell and confirm schema analysis, search, hover documentation and autocomplete work through the linked public-core worker.
- [ ] Send REST and GraphQL requests, save/reopen a workspace, and confirm the empty official shell behaves like OSS Purr.
- [ ] Inspect both build directories and confirm official composition did not modify/copy public application source or require public signing credentials.

Implementation notes:
- Created a local-only sibling Git repository, with no remote or hosted publication. It consumes public ESM/types/CSS through npm `file:../purr` and the native core through Cargo `../../purr/src-tauri`; only the synthetic Phase 15 shell/module examples were adapted, never core application source.
- Private shell owns only its config, capabilities and branding. `createPurrApp()` receives no extension modules and `core_builder()` receives no private providers or plugins. It uses the same visible product name, icon and macOS window chrome as OSS, while identifier `com.ihorpolishchuk.purr.official` keeps official local state isolated and prevents the removed fixture workspace from resurfacing.
- `core-version.json` pins the exact public SHA, npm/Rust versions and frontend API version. The compatibility script rejects mismatches, unsupported core imports and multiple React versions. Vite dedupes React; private React packages are pinned to the tested public versions. Final npm/Cargo locks belong to the private shell.
- Wrong-SHA and wrong-API probes failed as expected. After reducing the repository to an empty composition shell, `npm run check` passed exact-pin/import/React compatibility, typecheck, lint, linked-worker verification, frontend production build, native fmt/clippy and the Cargo test target; `npm run tauri -- build --debug --no-bundle` produced the arm64 macOS executable. Before the sibling existed, public `npm run build` and locked Cargo check passed. Public source remained unchanged by private builds.
- Local compatibility permits only an uncommitted edit of this public tracker, so owner verification can start immediately; all other public changes fail. Release compatibility requires an entirely clean public checkout. After committing public notes, explicitly review/update the private SHA pin.
- Private README contains bootstrap, ownership and parity checks for the empty official shell. `RELEASE.md` and `release:unsigned` define exact checkout, build/check, future signing/notarization and publish stages. No signing secret or CI destination was invented.
- Push-ready private CI checks out the commercial repository and exact pinned public SHA as sibling directories on macOS, installs both lockfiles, validates the minimal composition and builds an unsigned native executable. The public commit must exist on GitHub before this workflow can resolve the pin; signing/updater publication remains a separate release workflow.
- Manual testing found that Vite dev served the prebuilt GraphQL worker from the sibling public checkout as `403 Restricted`. The private Vite composition now explicitly allows the pinned sibling core root, and `verify-dev-assets.mjs` starts an isolated dev server and asserts that the transformed worker URL returns JavaScript rather than an HTML fallback. The check is part of `npm test`/`npm run check`; production asset relocation remains covered by the normal build.
- After the linked-worker correction, the full private `npm run check` passed again: compatibility, typecheck, lint, TypeScript tests, dev worker asset verification, production build, Rust fmt, clippy with warnings denied, and Rust tests.

Deviations from plan:
- Per owner request this is a local test repository, not a remote commercial deployment; no Datadog or paid integration is claimed.
- Per the subsequent owner decision, the synthetic commercial provider/page/document/plugin were removed from the private repository. The external extension boundary remains validated by the public Phase 15 consumer fixture; `purr-commercial` stays an empty official shell until the first real private feature is selected.
- Signing/notarization and publication were not executed because release identities, credentials and destination are not configured. The combined build/signing verification checkbox remains open even though the native executable and independent OSS builds passed.

Known follow-ups:
- The first real private module must add its own frontend/native contract tests and rerun unavailable-resource round trips without changing the composition boundary. Signing/notarization/publication and hosted CI remain future release work using this composed build; no source overlays.
- This phase stays PARTIALLY DONE pending owner acceptance and the explicitly deferred signing checks; `Completed` remains unset.

- **Objective:** establish the real repository boundary after the public API is proven.
- **Files/modules affected:** new private repo only, except public compatibility notes if defects are found.
- **Changes:** create thin frontend/Rust entries, sibling dependencies, `core-version.json`, compatibility validation, one private fake or real commercial Rust provider plus its frontend presentation module, private tests, and release-build skeleton without signing credentials committed. The provider registers through `core_builder()` and is invoked only through the public provider-neutral observability commands.
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
| Observability command DTOs | Risk of passing config/credentials or unbounded vendor payloads into React | Provider-neutral commands accept stable workspace/integration/exchange references and return bounded normalized pages; runtime-validated in TypeScript |
| Provider DTOs | Risk of leaking into core commands | Rust-adapter-owned DTOs mapped to the public native observability domain before IPC; never serialized to React |
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
- The Tauri app CSP is currently `null`. Define an explicit production CSP before public binaries are distributed; it must allow the Phase 9 `purr-content` protocol only for the required image/media sources.
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
- [ ] Set a restrictive production CSP, allow the `purr-content` protocol only in the required `img-src`/`media-src` directives, and test dialogs, editors, OAuth opener, image preview, and audio/video seeking under it.
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
- **Moving all secret handling to Rust:** rejected as a blanket goal. Cryptography and storage are already native; ordinary request UI editing/projection/template policy remains application logic. Observability is the explicit exception: its scoped credential resolution and final provider request injection are Rust-owned because providers execute natively and plaintext must not cross their IPC boundary.
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
- adding a trace provider requires a Rust adapter/registration, optional frontend presentation/settings contribution, and tests, but no vendor branches or provider execution in core React/TypeScript code;
- an external build-time module can add a namespaced navigation page, run module-owned application logic, and contribute a persisted workspace document/protocol type using only public exports and without replacing the router/workbench;
- removing that module leaves the OSS app runnable and preserves its opaque document/integration configuration in an explicit unavailable state; restoring the module restores the feature;
- protocol-specific UI, runtime types, native DTOs, and commands remain module-owned and do not expand core `RequestDraft`, `HttpExchange`, or Tauri command unions with vendor branches;
- Rust Trace/Span/Log domain files import no Tauri, reqwest, storage implementation, or vendor DTOs; TypeScript display DTOs import no React, Tauri API, storage, or vendor DTOs;
- provider HTTP, credential resolution, configuration validation/migration, correlation extraction, vendor parsing, normalization, caching, pagination, retry/error mapping, and cancellation are implemented in Rust and covered by native tests;
- observability IPC carries only stable IDs/references and bounded normalized results, never plaintext credentials, raw provider configuration for execution, or vendor response DTOs;
- Tauri commands are thin adapters and do not reconstruct `RequestDraft` or own workspace/auth policy;
- desktop response bodies no longer cross IPC as complete base64/text values;
- a 100 MiB response can reach first visible content, search, save, cancel, and persist/restore while WebView memory remains bounded by configured windows rather than body size;
- large query/pretty results remain handles/pages instead of unbounded IPC strings;
- response staging/persistence is encrypted at rest, chunk corruption fails closed, and abandoned content is cleaned;
- old canonical files and local execution records still open through an explicit migration/compatibility path;
- the extension and native API versions are pinned and checked by private CI;
- the architecture remains one public application, one public Rust crate, one thin private composition shell, explicit contracts, registries, and adapters.
