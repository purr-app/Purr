# Purr: migration plan for a public core, private extensions, and a modular native engine

Status: canonical architecture plan, execution tracker, and product-owner checklist; no refactoring is implemented by this document.
Code baseline reviewed: `f841397` (`main`) on 2026-09-14.

This plan is based on the current TypeScript and Rust code, tests, persistence format, and documented request/response lifecycle. It deliberately keeps Purr as one application and one Rust crate for now. The main decisions are:

1. `purr` remains a complete public application and also exposes a narrow build-time extension API.
2. `purr-commercial` contains only commercial modules and the official composition shell. It never copies the application source.
3. Frontend composition uses explicit contracts, registries, and an application composition root. It does not use a DI framework or a runtime plugin marketplace.
4. Rust becomes the bounded engine for native transport, encrypted content storage, large response decoding/search/format/query, large request-body streaming, imports, filesystem work, OAuth callbacks, and secure storage.
5. TypeScript keeps interactive request composition, canonical project schemas, UI state, GraphQL editor intelligence, and application policy. Moving those wholesale to Rust would create a second application model and a second request-building path.
6. Large response support is built around an opaque native content reference. Merely moving `JSON.parse` to Rust while still returning the complete formatted result to React would not solve the memory problem.
7. A second repository is the intended result, but creating it before the extension contract and one public vertical slice are proven would be premature. The split happens near the end of the migration, after Jaeger validates the boundary.

## Migration progress

This tracker reflects the repository state reviewed on 2026-09-15. `PARTIALLY DONE` identifies an existing precursor only; it does not mean the phase acceptance criteria or its verification checklist are complete. No phase is `DONE` until its scope, automated checks, manual checks, and completion protocol are all recorded.

| Phase | Name | Status | Implemented in | Automated verification | Manual verification |
| --- | --- | --- | --- | --- | --- |
| 0 | Freeze measurements and compatibility fixtures | DONE | `10bf837` (tooling on `main`) plus Phase 0 working tree based on merge `f86cd15` | PASS — unit/UI/Rust suites, typecheck, lint, build, fmt, clippy, benchmark, fixture smoke | COMPLETE — safe response/GraphQL/RSS scenarios and current failure modes recorded |
| 1 | Stabilize repository and dependency rules | PARTIALLY DONE | Existing npm/Cargo scripts and ignore rules predate this plan; no phase reference | Existing checks present; clean-install and OSS-build record missing | Not recorded |
| 2 | Split stable HTTP exchange contracts | TODO | — | Not run | Not run |
| 3 | Add frontend ports and OSS composition root | TODO | — | Not run | Not run |
| 4 | Mechanically modularize the Rust crate | TODO | — | Not run | Not run |
| 5 | Implement encrypted native response content storage | TODO | — | Not run | Not run |
| 6 | Switch native HTTP to response handles and real cancellation | TODO | — | Not run | Not run |
| 7 | Add bounded/virtualized response presentation | TODO | — | Not run | Not run |
| 8 | Move large response inspect/search/format/query to Rust | PARTIALLY DONE | Existing TypeScript response helpers and jq/JSONPath subset; no native phase reference | Existing response tests only; native conformance not run | Not recorded |
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
    app-router.tsx
    create-purr-app.tsx           # public app factory
    composition/
      core-modules.ts             # public built-ins only
      create-services.ts          # builds ports and immutable registries

  domain/
    project.ts                    # existing canonical project model
    http.ts                       # HttpExchange metadata + ResponseContentRef
    observability.ts              # Trace, Span, LogRecord, correlation refs
    integration.ts                # provider-neutral IDs/config envelope

  application/
    ports/
      http-transport.ts
      response-content.ts
      persistence.ts
      credentials.ts
      clock.ts                    # only if deterministic tests need it
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
    contracts.ts                  # factories and capability contracts
    registry.ts                   # duplicate-safe immutable registries
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
- full CodeMirror response document: at most 1 MiB;
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
- providers mutating global registries after app startup;
- provider adapters reading `Workspace`, `RequestDraft`, or `LocalRecord.value` directly;
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
- public built-ins such as Jaeger, Tempo, and Loki when each is actually implemented;
- public app entry, icons/config appropriate for the OSS build, CI, and release artifacts.

### D.2 Private `purr-commercial`

Private code may contain:

- Datadog, CloudWatch, New Relic, Splunk, SaaS, and enterprise provider adapters;
- licensing, entitlement, organization/team policy, enterprise auth, and credential-provider modules;
- private UI components attached through declared public slots/contracts;
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
}
```

Only implement registrar properties when a real use case arrives. The initial implementation needs integration, trace, and correlation registrations for Jaeger; do not create empty registries for every possible product idea.

Registration occurs once in `createPurrApp()`. The builder rejects duplicate module/provider IDs, validates API versions, and freezes registries before rendering. No module discovery, dynamic loading, service locator, or global singleton is needed.

Separate non-React provider contracts from optional React UI contributions. A provider manifest supplies label/icon/capabilities and a config validator. An optional settings editor receives typed form state and public UI primitives through documented imports; domain and application services never import that component.

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

The private repo owns only composition scaffolding: its own `index.html`, Vite entry, package/Cargo manifests, `tauri.conf.json`, official branding, and `main.rs`. That small shell is expected duplication; no feature, domain, persistence, or workbench source is duplicated.

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

The precise Cargo relative path depends on whether the private manifest is at the root or under `src-tauri`; CI must use the same sibling checkout layout. The private app imports `createPurrApp`, compiled public styles, and `extension-api`, then supplies `commercialModules`. Its `main.rs` augments `purr_lib::core_builder()` with private Tauri plugins and calls the public run helper with the private crate's `tauri::generate_context!()` result.

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
- one package manager and committed lockfiles;
- separate OSS and official bundle identifiers, updater endpoints/public keys, branding, and release channels;
- no signing identity or signing key committed in `tauri.conf.json`; CI injects release credentials;
- no copy/overlay step in the official build. Both repositories are normal dependency inputs checked out side-by-side.

Public PRs cannot normally run private CI without exposing private credentials/code. Breaking extension changes therefore require an explicit public API version bump, migration notes, and a coordinated private compatibility branch. Private CI should run on every supported public release candidate and on a scheduled check against public `main`.

## I. Incremental migration plan

Each phase is intended to be one reviewable PR unless explicitly split. Every PR must keep the OSS application working. Pure file moves should not be mixed with behavior changes, which reduces conflicts with ongoing feature development.

### Phase 0 — freeze measurements and compatibility fixtures

Status: DONE

Implemented in: `10bf837` (performance tooling committed on `main`) plus the Phase 0 working tree based on merge `f86cd15`.

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

Status: PARTIALLY DONE

Implemented in: Existing npm/Cargo scripts, `.gitignore`, and test commands predate this plan; no dedicated phase commit/reference.

Started: Pre-plan

Completed: —

Automated verification:
- [ ] Run a clean npm install using the selected package manager and verify the lockfile is unchanged.
- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `cargo fmt --check`, `cargo clippy`, and `cargo test`.
- [ ] Run an OSS Tauri development/build smoke check using only public configuration.

Manual verification:
- [ ] Clone the repository into a new directory, install dependencies with the selected package manager, and launch the OSS build without a sibling private checkout.
- [ ] Open an existing workspace, send one REST request and one GraphQL request, then restart Purr and confirm the workspace still restores.
- [ ] Inspect the public Tauri configuration used by the build and confirm it contains no developer signing identity or release credential.

Implementation notes:
- The repository currently contains both npm and Yarn artifacts, and Tauri development invokes Yarn; import restrictions, public package exports, and OSS CI are not in place.

Deviations from plan:
- None.

Known follow-ups:
- Keep package-manager conversion isolated from dependency upgrades.

- **Objective:** make the public repo a deterministic dependency before introducing extension code.
- **Files/modules affected:** `package.json`, lockfiles, `src-tauri/tauri.conf.json`, ESLint config, CI skeleton, architecture docs.
- **Changes:** choose npm, update Tauri build commands to npm, remove Yarn state/lock/config after a clean install comparison, add import restrictions, remove template `greet`, move developer signing identity out of checked-in config, define OSS package name/version/export intent.
- **Risk:** lockfile changes can update transitive packages. Pin existing resolved versions first; do dependency upgrades separately.
- **Verification:** clean clone install, unit/typecheck/lint/build, `cargo test`, OSS `tauri dev` and build smoke test.
- **Scope:** S, one PR.

### Phase 2 — split stable HTTP exchange contracts from feature services

Status: TODO

Implemented in: —

Started: —

Completed: —

Automated verification:
- [ ] Run response, GraphQL, dynamic-variable, persistence, and UI tests using both v1 inline and v2 response-reference fixtures.
- [ ] Run `npm run typecheck`, `npm run lint`, and `npm run build` after removing service-owned HTTP types from public runtime exports.
- [ ] Add restore fixtures proving a pre-migration local execution opens without data loss.

Manual verification:
- [ ] Launch Purr with a workspace created before the phase, open its last response/history entry, and confirm status, headers, body, and timeline match the previous behavior.
- [ ] Send a JSON REST request, use Pretty/Raw/Hex/Base64 views, then restart Purr and verify the saved response is still available.
- [ ] Run a GraphQL request that returns top-level `data`, `errors`, and `extensions`; confirm the Response, Errors, and Extensions tabs remain unchanged.

Implementation notes:
- None yet.

Deviations from plan:
- None.

Known follow-ups:
- The transitional inline adapter remains until Phase 6 replaces desktop body IPC.

- **Objective:** stop treating `services/http-client.ts` and `HttpResult` as the public data model.
- **Files/modules affected:** new `src/domain/http.ts`; `http-client.ts`; request-workbench response consumers; project projection/history tests.
- **Changes:** introduce provider-neutral HTTP metadata/timeline types and a transitional `ResponseContentRef`. Keep a compatibility adapter that can wrap the existing inline `{text, bodyBase64}` response, so no UI changes are required yet. Remove service-layer types from runtime model exports.
- **Risk:** response history and tests construct `HttpResult` directly. Use fixture builders and tolerate both v1 inline and v2 ref descriptors while migrating.
- **Verification:** existing response, GraphQL, dynamic-variable, persistence, and UI tests pass unchanged in behavior; old local state restores.
- **Scope:** M, one PR.

### Phase 3 — add frontend ports and the OSS composition root

Status: TODO

Implemented in: —

Started: —

Completed: —

Automated verification:
- [ ] Add import-boundary tests proving feature/domain modules do not import `@tauri-apps/*`.
- [ ] Run browser tests with memory/browser adapters injected through the composition root.
- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and Rust tests.

Manual verification:
- [ ] Launch the browser development build and create, save, reopen, and delete a workspace using the browser persistence adapter.
- [ ] Launch desktop Purr, open an existing workspace, switch environment, send a request, and verify cookies and response history still behave as before.
- [ ] Start OAuth authorization for a test provider/local callback, cancel it, and confirm the app returns to the request editor without a stuck authorization state.

Implementation notes:
- None yet.

Deviations from plan:
- None.

Known follow-ups:
- Keep direct platform calls behind adapters before adding optional modules.

- **Objective:** centralize platform selection and make private composition possible without adding private code.
- **Files/modules affected:** `src/app/create-purr-app.tsx`, `src/app/composition/*`, `src/application/ports/*`, `src/platform/{tauri,browser}/*`, current `src/storage/native-backend.ts`, direct Tauri callers.
- **Changes:** define `HttpTransportPort`, `ResponseContentPort`, `PersistencePort`, `CredentialResolver/SecureStore`, OAuth/import/download ports; adapt existing implementations; pass a service object through app context/hooks. Move Tauri command strings and DTOs into one platform boundary. `App.tsx` calls the public factory with core modules.
- **Risk:** a giant prop-drilling refactor. Use one typed application-services context at the shell, not a DI container and not service parameters on every leaf.
- **Verification:** browser tests inject memory adapters; a guard test fails if feature/domain code imports `@tauri-apps/*`; desktop behavior remains unchanged.
- **Scope:** M–L; split into platform centralization and shell wiring if the diff exceeds a comfortable review.

### Phase 4 — mechanically modularize the Rust crate

Status: TODO

Implemented in: —

Started: —

Completed: —

Automated verification:
- [ ] Compare the registered Tauri command list before and after the moves.
- [ ] Run `cargo fmt --check`, `cargo clippy`, `cargo test`, and the TypeScript build/test suite.
- [ ] Run regression fixtures for HTTP transport, OpenAPI import, encrypted persistence, legacy migration, OAuth callback validation, and safe project-file paths.

Manual verification:
- [ ] Launch Purr, open an existing workspace, send a REST request, and confirm headers, cookies, redirects, and response download behavior are unchanged.
- [ ] Import an OpenAPI file, folder, URL, and pasted text fixture; confirm the resulting workspace opens and persists normally.
- [ ] Attach or open a project directory, edit a request, save it, modify it outside Purr, and confirm the existing reload/change behavior still works.
- [ ] Start and cancel an OAuth authorization attempt and confirm the loopback callback workflow remains available.

Implementation notes:
- None yet.

Deviations from plan:
- None.

Known follow-ups:
- Behavior changes to HTTP/content storage belong to Phases 5–9, not to mechanical move commits.

- **Objective:** create cohesive native boundaries before adding the content engine.
- **Files/modules affected:** all current `src-tauri/src/*.rs` modules, without intentional behavior/schema changes.
- **Changes:** move HTTP, import, persistence, project-files, legacy, and security code into the target capability modules; make commands thin; keep `oauth.rs` flat; preserve command names and serde shapes. Split `importing.rs` and persistence files along the mapping in section J.
- **Risk:** noisy moves collide with feature work and hide logic changes. Use move-only commits followed by visibility/import cleanup; do not combine with new response behavior.
- **Verification:** identical registered command list, all 36+ Rust tests pass, `cargo fmt --check`, `cargo clippy`, desktop smoke test.
- **Scope:** L mechanically, preferably 3 sequential PRs: import split, persistence/security split, command/composition split.

### Phase 5 — implement encrypted native response content storage

Status: TODO

Implemented in: —

Started: —

Completed: —

Automated verification:
- [ ] Run Rust migration tests for v1 response bodies, staging/adoption, cleanup, quota/TTL, and chunk reads across boundaries.
- [ ] Run tamper, reordering, and corruption tests proving encrypted chunks fail closed.
- [ ] Run persistence/history TypeScript tests plus `cargo fmt --check`, `cargo clippy`, `cargo test`, `npm run typecheck`, and `npm run build`.

Manual verification:
- [ ] Open a workspace created before the migration, open a saved response/history entry, restart Purr, and confirm the body is still readable.
- [ ] Use a delayed local fixture response, quit or force-close Purr during capture, restart it, and confirm no incomplete response appears as a valid history body.
- [ ] Delete an execution/history entry and then the workspace; confirm its response body is no longer available while another workspace's history remains available.
- [ ] Verify an encrypted local database does not expose a recognizable response string from a prepared fixture when inspected outside Purr.

Implementation notes:
- None yet.

Deviations from plan:
- None.

Known follow-ups:
- Phase 6 switches transport to these references; preserve the current preview limit until that isolated transport change is verified.

- **Objective:** make Rust able to own a response incrementally without a complete in-memory body.
- **Files/modules affected:** new Rust `content/*`, `persistence/response_bodies.rs`, `security/cipher.rs`, DB migration, thin response commands, TS `ResponseContentPort` adapter.
- **Changes:** add content metadata/chunk tables, a response-content HKDF key, 256 KiB independently encrypted chunks, staging/adopt/release/cleanup lifecycle, range and line-page reads, quota/TTL state, and typed DTO validation. Preserve current `response_bodies` reads and migrate lazily or transactionally; never make v1 data prevent startup.
- **Risk:** migration correctness, SQLite write contention, WAL growth, crash cleanup, corrupted individual chunks. Use WAL-aware bounded transactions, foreign keys, per-chunk AAD, explicit `state`, and corruption tests. Do not delete v1 data until v2 has verified reads.
- **Verification:** interrupted writes leave no readable partial result; tampered/reordered chunks fail closed; staging cleanup is deterministic; ranges cross chunk boundaries correctly; old execution bodies load; no plaintext body appears in DB or temporary files.
- **Scope:** L, likely two PRs: store/migration then application adapter.

### Phase 6 — switch native HTTP to response handles and real cancellation

Status: TODO

Implemented in: —

Started: —

Completed: —

Automated verification:
- [ ] Add native transport tests proving completion IPC contains metadata/content reference and no complete `bodyBase64`.
- [ ] Add cancellation race tests for cancel-before-headers, cancel-during-download, complete-while-canceling, and redirect cleanup.
- [ ] Run HTTP, cookie/redirect, binary payload, persistence, TypeScript build/type/lint, and Rust fmt/clippy/test checks.

Manual verification:
- [ ] Prepare a local endpoint that streams chunks slowly; send it in desktop Purr, observe progress, cancel mid-download, and confirm the UI returns to idle without a new completed history entry.
- [ ] Send a request that redirects across origins and verify the final request still masks sensitive headers/query values and preserves the existing cookie behavior.
- [ ] Send a binary response with repeated `Set-Cookie` headers; verify response metadata, cookies, duration, and download action remain correct.
- [ ] Restart Purr after a completed request and confirm the response/history remains accessible through its new content reference.

Implementation notes:
- None yet.

Deviations from plan:
- None.

Known follow-ups:
- Progressive large-body rendering is activated in Phase 7; this phase retains the current capture limit.

- **Objective:** remove response base64 from desktop IPC and stop network work when the user cancels.
- **Files/modules affected:** Rust `http/*`, `commands/http.rs`, `commands/response.rs`; TS Tauri HTTP adapter and execute flow.
- **Changes:** add request operation ID, `start_http`/`cancel_http`, cancellation token map, header/progress/completion channel, encrypted chunk append, `ResponseContentRef` completion result, and release of intermediate redirect bodies. Keep redirect/cookie/security policy in the TypeScript execute use case. Preserve the 20 MiB cap in this phase to isolate the contract change.
- **Risk:** races between completion/cancel/release, leaked handles, redirects retaining bodies, progress flooding. Make operation state transitions idempotent, coalesce progress, and give the content store sole ownership of cleanup.
- **Verification:** desktop response IPC contains no `bodyBase64`; cancel aborts reqwest and chunk writes; redirect bodies are released; repeated headers/timings/binary bytes remain correct; memory no longer scales by multiple full-body copies.
- **Scope:** L, one focused PR after Phase 5.

### Phase 7 — add bounded/virtualized response presentation

Status: TODO

Implemented in: —

Started: —

Completed: —

Automated verification:
- [ ] Add UI tests for the small CodeMirror path and the large virtualized line/byte viewer path.
- [ ] Run a 100 MiB fixture regression proving page reads, search navigation, and scrolling do not create a full-body JavaScript string.
- [ ] Run response, GraphQL, dynamic-variable, browser-adapter, typecheck, lint, build, and Rust checks.

Manual verification:
- [ ] Prepare a 100 MiB text fixture with identifiable first, middle, and last lines; open it and confirm each location can be reached without the app freezing.
- [ ] Use find/next/previous on a repeated marker near the start and end of that fixture; confirm match navigation remains correct while scrolling.
- [ ] Send a small JSON response and confirm Pretty, Raw, copy, field context actions, GraphQL Errors, and Extensions still use the familiar presentation.
- [ ] Open the same large response after restarting Purr and confirm the viewer loads only visible content while its metadata/history stays usable.

Implementation notes:
- None yet.

Deviations from plan:
- None.

Known follow-ups:
- Native search/format/query operations replace remaining full-content helpers in Phase 8.

- **Objective:** keep WebView memory proportional to the visible response rather than total content.
- **Files/modules affected:** split `response-viewer.tsx`; `response-code-viewer.tsx`; new response content hooks/viewer; GraphQL response panels; dynamic variable resolver.
- **Changes:** retain CodeMirror for content up to 1 MiB; use a read-only line/byte virtualized viewer above it; request pages through `ResponseContentPort`; show loading/progress/complete state; make Copy full body an explicit streamed native/clipboard operation or disable it above a safe limit with a clear action. GraphQL errors/extensions use bounded/native extraction for large bodies. Dynamic variables query through the response port when their dependency returns a native ref.
- **Risk:** cursor/search/context-menu behavior differs between viewers. Define shared line/match/field-action models and e2e tests before replacing the large path.
- **Verification:** 100 MiB text can show first/last pages without a 100 MiB JS string; scrolling does not grow unbounded; small-body visual behavior remains the same; browser/mock adapter passes tests.
- **Scope:** L, split into viewer extraction and large-viewer activation.

### Phase 8 — move large response inspect/search/format/query to Rust

Status: PARTIALLY DONE

Implemented in: Existing TypeScript `model/response.ts` implements response inspection, formatting, and the documented jq/JSONPath subset; no native phase commit/reference.

Started: Pre-plan

Completed: —

Automated verification:
- [ ] Run the shared jq/JSONPath conformance fixtures against both TypeScript and Rust implementations.
- [ ] Add bounded-operation tests for search cancellation, invalid encoding, oversized query results, recursive selectors, JSON/XML/NDJSON formatting, and derived-content lifecycle.
- [ ] Run response/UI/persistence tests plus `npm run typecheck`, `npm run lint`, `npm run build`, `cargo fmt --check`, `cargo clippy`, and `cargo test`.

Manual verification:
- [ ] Prepare JSON and NDJSON fixtures larger than the full-tree parse tier; run supported jq and JSONPath expressions and confirm results/pages are correct without an app freeze.
- [ ] Use text and regex search on a large response, cancel a long-running search, and confirm the previous response view stays usable.
- [ ] Format a large JSON and XML response, switch between Pretty/Raw/Hex/Base64 windows, and confirm only the requested portion is shown.
- [ ] Trigger an unsupported large recursive expression and confirm Purr shows a clear bounded-operation error rather than hanging or exhausting memory.

Implementation notes:
- Existing TypeScript behavior is a semantic reference only; it does not satisfy native bounded processing or cross-runtime conformance.

Deviations from plan:
- None.

Known follow-ups:
- Do not advertise full jq/JSONPath compatibility while only the existing subset is implemented.

- **Objective:** provide useful large-response tools without reconstructing full content in JS.
- **Files/modules affected:** Rust `response/*`; TypeScript `model/response.ts` becomes small-value helpers plus port calls; search/query UI.
- **Changes:** implement prefix-based content inspection, bounded decoding, line index, literal/regex search with limits, range hex/base64, JSON/XML/NDJSON formatting, and exact current jq/JSONPath subset. Return scalar/page/content-ref results. Cache derived pretty content with dependency/lifecycle metadata.
- **Risk:** semantic drift and unbounded recursive JSON work. Reuse Phase 0 fixtures, set explicit parse limits, stream supported large expressions, and reject unsupported large expressions rather than loading them blindly.
- **Verification:** TypeScript and Rust conformance results match; large searches can cancel; query result larger than the IPC limit is another handle; invalid encoding/data produces a typed error, not process failure.
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
- [ ] Add conformance tests for a fake external module importing only documented public exports.
- [ ] Add boot tests for duplicate module/provider IDs, incompatible API versions, registry freeze, and zero optional modules.
- [ ] Run package export/build tests plus TypeScript unit/UI/type/lint/build and Rust checks.

Manual verification:
- [ ] Launch the OSS app with no optional module configured and confirm all existing workspace/request/GraphQL workflows still start normally.
- [ ] Run the example external fake-module shell, open its integration settings surface, and confirm only its declared provider contribution appears.
- [ ] Attempt to load an intentionally incompatible/duplicate fake module and confirm startup reports the precise module conflict without partially registering it.

Implementation notes:
- The import registry demonstrates a registry pattern but is not an extension boundary and must not be treated as completion of this phase.

Deviations from plan:
- None.

Known follow-ups:
- Keep the exported API limited to the real Jaeger/observability use case in Phases 13–14.

- **Objective:** provide the single supported build-time registration seam.
- **Files/modules affected:** `src/integrations/{contracts,registry}.ts`, `src/extension-api/*`, `src/app/composition/*`, package exports, conformance tests.
- **Changes:** implement only module, integration-provider, trace-provider, and correlation registries needed for the next phase; validate IDs/API versions/duplicates; freeze at startup; expose a curated barrel and test kit. Do not export runtime `Workspace` or feature components.
- **Risk:** the API becomes a dump of internals. Every export needs a real external use case and an ownership/versioning note.
- **Verification:** fake external module registers without internal imports; duplicates and incompatible API versions fail at boot; app with zero optional modules is fully functional.
- **Scope:** M, one PR.

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
- [ ] Run an example external shell that imports only `./app`, `./extension-api`, and `./styles`, with one fake frontend module and one test native plugin.
- [ ] Run package export checks, React-singleton check, TypeScript tests/type/lint/build, and Rust fmt/clippy/test.

Manual verification:
- [ ] Launch the normal OSS binary and verify existing workspaces, REST/GraphQL requests, persistence, downloads, and OAuth still work with the thin public `main.rs`.
- [ ] Launch the example consumer shell using its own Tauri configuration/capabilities and confirm it renders Purr with the fake module but without copying public source files.
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
- **Verification:** example shell composes one external fake module and a test native plugin without copying source; OSS build remains identical in behavior.
- **Scope:** M, one PR.

### Phase 16 — create `purr-commercial` and official build composition

Status: TODO

Implemented in: —

Started: —

Completed: —

Automated verification:
- [ ] Run the private compatibility script against the exact public SHA/API versions in `core-version.json`.
- [ ] Build/test the official shell with a commercial provider and verify imports are limited to documented public exports/APIs.
- [ ] Run the public OSS build in a checkout with no private sibling, then run official build/signing smoke checks with credentials injected only by CI/local secure configuration.

Manual verification:
- [ ] Prepare sibling `purr/` and `purr-commercial/` checkouts at the pinned revisions; launch OSS Purr from the public checkout and confirm it works with no private directory present.
- [ ] Launch the official shell and verify its commercial provider is available while the same provider is absent from the OSS build.
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
| `src/App.tsx`, `src/app/app-router.tsx` | Mount and route the whole app | Keep; call `app/create-purr-app.tsx` | Small | Public and official entries need one reusable app factory |
| `features/workspaces/workspace-workbench.tsx` | Workspace UI plus top-level request/schema/import/navigation orchestration | Keep UI; extract use cases/composition calls | Yes, incremental | It is the highest-conflict frontend composition point |
| `features/workspaces/model/workspace.ts` | Mutable runtime aggregate, documents, layout, response/cache state | Keep internal to feature runtime | Small | Useful runtime model, unsuitable stable extension API |
| `features/workspaces/hooks/use-workspaces.ts` | Load/autosave/flush/failure handling | Keep; depend on `PersistencePort` | Small | Existing lifecycle is sound; remove platform construction |
| `src/domain/project.ts` | Canonical schemas and cross-resource validation | Keep; add integration-envelope migration | Small–medium | Already correct portable boundary |
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
| `src/shared/` | UI system, theme, general utilities | Keep | No broad change | Existing shared boundary is useful; do not turn it into a miscellaneous SDK |

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
- **Logs, metrics, traces, and events in one generic telemetry interface:** avoid. Trace/Span/Log are related but have different query and presentation semantics. Add metrics/events only with real use cases.
- **Generic arbitrary UI slots:** postpone. Add named settings/response/observability contributions when the first provider needs them; unrestricted React injection would make the SDK unstable.
- **Licensing hooks in public core:** postpone and keep private unless a generic OSS capability policy becomes a real requirement.
- **Immediate creation of `purr-commercial`:** postpone until Phases 12–15 prove the public API and builder through Jaeger plus an example consumer. This avoids designing the public API around only hypothetical private needs.

## Architecture acceptance criteria

The migration is complete only when all of these are mechanically verifiable:

- a clean public checkout compiles, tests, and produces a useful OSS binary with no private repository;
- the official build checks out public and private repositories side-by-side and performs no source copy/overlay;
- public imports and Cargo dependencies contain no private module/provider/licensing reference;
- private modules import only declared public package exports and public Rust builder/plugin APIs;
- adding a trace provider requires an adapter, registration, configuration contribution, and tests, but no vendor branches in core UI/application code;
- Trace/Span/Log domain files import no React, Tauri, reqwest, storage, or vendor DTOs;
- Tauri commands are thin adapters and do not reconstruct `RequestDraft` or own workspace/auth policy;
- desktop response bodies no longer cross IPC as complete base64/text values;
- a 100 MiB response can reach first visible content, search, save, cancel, and persist/restore while WebView memory remains bounded by configured windows rather than body size;
- large query/pretty results remain handles/pages instead of unbounded IPC strings;
- response staging/persistence is encrypted at rest, chunk corruption fails closed, and abandoned content is cleaned;
- old canonical files and local execution records still open through an explicit migration/compatibility path;
- the extension and native API versions are pinned and checked by private CI;
- the architecture remains one public application, one public Rust crate, one thin private composition shell, explicit contracts, registries, and adapters.
