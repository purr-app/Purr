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
