# Purr Phase 0 baseline

Baseline date: 2026-09-15  
Code baseline: `10bf837` (`main`, performance tooling only); the Phase 0 branch contains no runtime behavior changes  
Fixture provenance: generated locally by `tests/performance/synthetic-fixtures.ts`; no external or production data

## Static representation inventory

The current native/TypeScript path retains or creates these complete response representations:

1. reqwest chunks collected into Rust `Vec<u8>`;
2. Rust base64 string serialized through Tauri JSON IPC;
3. JavaScript base64 string;
4. decoded `Uint8Array`;
5. decoded JavaScript text string;
6. parsed JSON object graph when the response is JSON;
7. formatted string for Pretty, Hex, or other derived modes;
8. CodeMirror document/state for textual display.

Media previews create base64 data URLs. Native download sends base64 back across IPC and decodes it again. This inventory is the comparison point for Phases 5–9.

## Automated Node baseline

Command: `npm run benchmark:responses`  
Generated: 2026-09-14T23:21:40.061Z  
Runtime: Node v24.18.0  
Platform: macOS/arm64

Values are observations and must not be used as CI thresholds. Every response size ran in a fresh process with explicit GC available.

| Body | Base64 | Pretty output | Peak RSS | Encode | Decode | JSON parse | Pretty | Query | Search |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.1 MiB | 0.1 MiB | 0.1 MiB | 91.6 MiB | 0.1 ms | 0.3 ms | 0.2 ms | 0.2 ms | 0.2 ms | 0 ms |
| 1 MiB | 1.3 MiB | 1 MiB | 88.5 MiB | 0.4 ms | 0.2 ms | 0.6 ms | 1.1 ms | 0.2 ms | 0 ms |
| 20 MiB | 26.7 MiB | 20 MiB | 265.4 MiB | 9.7 ms | 7.9 ms | 7.8 ms | 18.8 ms | 0.4 ms | 0 ms |
| 100 MiB | 133.3 MiB | 100 MiB | 912.5 MiB | 49.1 ms | 30.3 ms | 33.6 ms | 85.3 ms | 0.3 ms | 0 ms |

The peak includes the deliberately retained source, base64, decoded bytes/text, parsed JSON, and pretty output. It demonstrates the scaling shape; it is not a prediction for every WebView/runtime.

| Synthetic GraphQL types | Introspection JSON | Normalized SDL | Duration | Peak RSS |
| ---: | ---: | ---: | ---: | ---: |
| 40 | 0.1 MiB | less than 0.1 MiB | 1.6 ms | 80.2 MiB |
| 1,200 | 1 MiB | 0.1 MiB | 17.6 ms | 125.1 MiB |

## Phase 10 GraphQL analysis measurement

Command: `npm run benchmark:responses -- --json`

Generated: 2026-09-16T15:21:30.492Z

Runtime: Node v24.18.0 on macOS/arm64

These observations include the newly separated normalized-SDL parse used by the UI. They are not CI thresholds.

| Synthetic types | Introspection JSON | Normalized SDL | Normalize/validate | Parse normalized SDL | Peak RSS after both representations |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 40 | 55,610 B | 3,718 B | 1.9 ms | 1.5 ms | 81.6 MiB |
| 1,200 | 1,096,410 B | 114,198 B | 15.6 ms | 18.0 ms | 138.8 MiB |

The 1,200-type fixture crosses the native inline-response boundary. Phase 10 now reads that source in bounded windows and performs source normalization in a dedicated worker. The desktop acceptance result is recorded below.

### Phase 10 desktop acceptance

The product owner completed the large introspection/SDL, editor intelligence, active-schema isolation, offline pinned-schema, and cancellation scenarios on 2026-09-16. All remained responsive and worked as expected. Web Inspector reported an approximately 10 ms `purr.graphql.schema.parse` entry. The worker round-trip entry and process memory were inspected during acceptance, but their exact values were not separately captured in the report; no abnormal memory or long-task behavior was reported.

## Desktop/native baseline

The product owner ran these scenarios against the current pre-optimization desktop behavior using the local fixture server. Native and WebView RSS were recorded for the safe clean-state scenarios; earlier unsafe/hanging scenarios have no reliable RSS sample. “Crashed” below records the observed outcome; it does not yet distinguish a terminated process from an indefinitely unresponsive WebView/process.

| Scenario | Send to visible | Peak native RSS | Peak WebView RSS | Result/notes |
| --- | ---: | ---: | ---: | --- |
| Idle | — | 134.2 MiB | 218.0 MiB | Clean isolated test state after startup |
| 100 KiB JSON | Less than 100 ms by manual observation | 153.6 MiB | 279.0 MiB | No visible freeze; response completed normally |
| 1 MiB text | Approximately 1–2 s to recover | — | — | Purr was unresponsive while the request completed, then displayed the response |
| 1 MiB JSON with 1 s delayed headers | More than the configured 1 s header delay; exact duration not recorded | — | — | After approximately one second Purr became unresponsive, then eventually displayed the response |
| Exactly 20 MiB JSON | No usable response | — | — | UI stopped responding and the application could not be closed normally; reported as a crash |
| 20 MiB + 1 byte | — | — | — | Correctly returned `Response exceeds the 20 MB preview limit.` |
| 100 MiB NDJSON | — | — | — | Not repeated in desktop Purr: the 20 MiB + 1 byte limit path was already verified and exactly 20 MiB caused an unsafe hang/crash; the 100 MiB copy path remains covered by the non-CI Node baseline |
| Slow 20 MiB stream canceled after ~1 s | Cancellation returned the UI temporarily | — | — | Request appeared canceled and Purr worked briefly, then the application crashed. Fixture-server byte logs included other clients and cannot be attributed reliably to this request |
| GraphQL introspection, 40 generated types | Responsive; exact duration not recorded | 161.7 MiB | 543.3 MiB | Schema load, schema search, autocomplete, and hover information passed |
| GraphQL introspection, 1,200 generated types | — | — | — | The schema worked without a reported issue; explorer/completion/hover observations were not recorded separately |
| Completed JSON responses up to 1 MiB | — | — | — | Pretty, jq `.meta.fixture`, search for `purr-tail-marker`, and download all returned the expected payload/results |

## Manual baseline findings

- The current UI already has a user-visible 1–2 second main-thread stall for a 1 MiB response.
- The nominal 20 MiB accepted boundary is not practically usable on the tested machine: exactly 20 MiB left the UI unresponsive, while 20 MiB + 1 byte followed the intended limit-error path.
- Delayed headers do not produce an incremental UI state; response completion was followed by a visible stall before rendering.
- UI cancellation is not sufficient isolation from the in-flight native work: the request appeared canceled, but the application later crashed.
- Small completed JSON response operations and the 1,200-type synthetic GraphQL schema remained functional; detailed editor-operation timings were not recorded.
- The clean 100 KiB response completed in under 100 ms by manual observation with no visible freeze. Native RSS rose from 134.2 MiB idle to 153.6 MiB and WebView RSS from 218.0 MiB to 279.0 MiB.
- The 40-type GraphQL scenario passed schema load, schema search, autocomplete, and hover checks. At observation time native RSS was 161.7 MiB and WebView RSS was 543.3 MiB.
- Workspace loading was noticeably prolonged after the earlier large-response/crash tests. This is an observed correlation only; Phase 0 did not isolate whether history, local state, WebView recovery, or another path caused it.
- After the stress run, saving a document or variable stalled the UI for several seconds in every workspace. Renaming the complete application-data directory and starting with clean state restored responsive saves and workspace loading.
- Fixture-server logs contained Yaak/other-client traffic, so no sent-byte value from that log is recorded or treated as Purr cancellation evidence.
- These observations establish the starting behavior. Phase 0 does not attempt to diagnose or fix it.

## Phase 7 product-owner observations before request-stage diagnostics

Recorded on 2026-09-16 after the bounded viewer and first corrective pass, before the background-write/timing instrumentation added later in Phase 7:

- the progress loader showed finite downloaded/total values;
- the 100 MiB Last action opened the tail page and search for `purr-tail-marker` navigated to the correct page without a freeze;
- `/response/json?size=1048576` completed without a UI freeze and the response tools remained functional; the compact scalar presentation was visually ambiguous because the shortened value resembled original response content;
- the first small GraphQL query could take up to about one second, while subsequent runs were around 200 ms;
- ordinary local requests still felt slow and averaged roughly 400 ms to become visible, while the compared clients reported the same local responses in under 20 ms;
- the response time displayed by Purr did not clearly distinguish network time from native storage and frontend work.

The next Phase 7 retest must use the Timeline processing diagnostics rather than infer the bottleneck from one aggregate duration. These values remain observational and are not CI thresholds.

## Phase 7 exact-boundary diagnostics

Recorded on 2026-09-16 after background response writes and request-stage diagnostics were added:

| Stage | Exact 1 MiB text response |
| --- | ---: |
| Native setup | 0.0 ms |
| Network | 4.0 ms |
| Encryption | 7.5 ms |
| SQLite write | 2.4 ms |
| Storage backpressure | 9.9 ms |
| Tauri IPC | 5.0 ms |
| Read/decrypt + decode | 22.0 ms |
| Response ready | 42.0 ms |

The response summary reported 3 ms and the connection/download breakdown reported 1 ms/2 ms. Despite this bounded native and IPC time, `/response/text?size=1048576` visibly froze the WebView at the loader and froze it again for about one second whenever the Response tab was reopened. The fixture is nearly one million characters on one line. Code inspection confirmed that the exact threshold was still materialized (`> 1 MiB` selected the bounded path) and then passed to line-wrapped CodeMirror, which must synchronously measure the pathological line. The Phase 7 correction makes 1 MiB an exclusive inline limit: exact 1 MiB native responses use the existing 192 KiB byte-window viewer. This observation remains a manual diagnostic and does not create a CI timing threshold.

## Persistence amplification hypothesis

Code inspection after the manual run found a plausible amplification path, but Phase 0 did not profile it sufficiently to claim a single root cause:

1. every workspace-store change schedules `WorkspacePersistence.save()` after 180 ms;
2. `save()` calls `persist()` for every loaded workspace;
3. restored persistence snapshots contain response `text` and `bodyBase64`, and in-session snapshots retain previous `request_executions` records;
4. `persist()` performs synchronous `JSON.stringify` comparisons over local records before deciding whether a record needs a native commit;
5. changed executions are additionally serialized, encrypted, and stored in SQLite, while workspace loading decrypts and reconstructs the latest response body per document.

The multi-workspace UI stall can therefore occur even when a document/variable edit does not logically change an old response: the WebView may still serialize large retained response values while calculating the change set. SQLite size, response decryption/restoration, and journal/write costs may add latency, but were not isolated. Phases 5–9 must profile this path and replace full bodies in frontend persistence snapshots with lightweight native content references.

## Interpretation rules

- Compare the same fixture, build mode, and machine across phases.
- Record native and WebView memory separately.
- Treat time and RSS as observations; functional compatibility checks remain deterministic tests.
- The baseline is complete for Phase 0. Unsafe crash scenarios are not repeated solely to fill unavailable timing/RSS fields, and ambiguous multi-client fixture logs are not treated as measurements.
