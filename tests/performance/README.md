# Phase 0 performance baseline procedure

These fixtures are synthetic. They contain repeated deterministic bytes, generated GraphQL types, and `purr-synthetic` markers only. Large files are generated at runtime and are not committed.

The benchmark is intentionally outside `npm test` and has no pass/fail timing or RSS thresholds:

```bash
npm run benchmark:responses
```

It measures the current TypeScript response representation path in a fresh Node process per size: JSON source, base64, decoded bytes/text, parsed object, pretty output, jq-subset lookup, and text search. It also records GraphQL introspection normalization for 40 and 1,200 generated types. Results vary by machine and are evidence for later comparisons, not CI assertions.

Start the local fixture service for native/UI measurements:

```bash
npm run fixture:responses
```

The default base URL is `http://127.0.0.1:43119`. Override the port with `PURR_FIXTURE_PORT`. Useful endpoints are:

| Scenario | URL |
| --- | --- |
| 100 KiB JSON | `/response/json?size=102400` |
| 1 MiB text | `/response/text?size=1048576` |
| Exactly 20 MiB JSON | `/response/json?size=20971520` |
| One byte over the current limit | `/response/json?size=20971521` |
| 100 MiB NDJSON | `/response/ndjson?size=104857600` |
| Slow 20 MiB stream | `/response/json?size=20971520&chunkSize=65536&delayMs=25` |
| Delayed headers | `/response/json?size=1048576&headersDelayMs=1000` |
| Small GraphQL introspection | `/graphql/introspection?types=40` |
| Large GraphQL introspection | `/graphql/introspection?types=1200` |
| GraphQL response tabs | `/graphql/result` |
| Synthetic OAuth token response | `/oauth/token` |
| Set a local test cookie | `/cookies/set` |
| Confirm request cookie propagation | `/cookies/echo` |
| Cross-origin redirect security fixture | `/redirect/cross-origin` |
| Binary with repeated cookies | `/response/binary?size=102400&cookies=repeated` |
| Synthetic SVG with a long metadata line | `/media/image.svg` |
| Synthetic two-second WAV | `/media/audio.wav` |
| Synthetic two-second MP4 padded with a valid `free` box above 1 MiB | `/media/video.mp4` |
| Binary/multipart upload hash echo | `POST /upload/echo` |
| Repeatable upload body through redirect | `POST /upload/redirect307` or `/upload/redirect308` |

Every response endpoint accepts `size`, `chunkSize`, `delayMs`, and `headersDelayMs`. The server caps bodies at 128 MiB and logs requested/sent bytes. After Phase 6, cancelling a native request should log fewer sent bytes.

The three `/media/*` endpoints support `HEAD` and one closed, open, or suffix `Range` request and contain generated shapes/silence/pixels only. The checked-in 11 KiB MP4 core was generated from synthetic color frames; the server appends a valid zero-filled `free` box at runtime so the native response stays above the opaque-content threshold without committing a large binary fixture.

Phase 9 upload checks can use any synthetic file. `POST /upload/echo` returns the whole-body byte count and SHA-256; for multipart it also returns each part's name, filename, content type, byte count, and SHA-256. The 307/308 endpoints hash the first body, redirect to the echo endpoint, and return `redirectReplay.matches: true` only when the repeated body is byte-identical. No uploaded bytes are persisted by the fixture server.

For Phase 7, use `/response/text?size=104857600` as the 100 MiB bounded-viewer case. It contains `purr-synthetic-start`, `purr-middle-marker`, and `purr-tail-marker` at deterministic positions. Confirm first/previous/position/next/last navigation and search for the tail marker. The 100 KiB case covers the small-response CodeMirror path; exact 1 MiB native responses cover the lower boundary of the bounded viewer. The capture limit is now 128 MiB. The 20 MiB limit observations below are the frozen Phase 0 baseline, not the current expected behavior.

`tauri dev` uses an optimized Rust dev profile for its network, encryption, SQLite, and Purr hot loops while retaining debug information. This keeps local measurements representative enough for interactive testing; final release comparisons should still use the signed/release profile.

## Desktop measurements

Use a release-like desktop build when comparing phases. Record the Purr process and its WebKit WebContent process separately in Activity Monitor or an equivalent process tool. Use the same build mode and close unrelated Purr windows before every run.

1. Record idle native RSS and WebView RSS after opening an empty workspace.
2. Send each JSON/text fixture once and record time from Send to visible response, peak native RSS, peak WebView RSS, and RSS after closing the response tab.
3. For the delayed-header endpoint, record time to headers and first visible response state.
4. For the Phase 0 baseline, retain the recorded 20 MiB and 20 MiB + 1 byte results. For current Phase 7 behavior, open the 100 MiB bounded-viewer fixture and record first-page latency and responsiveness while jumping to the middle and end.
5. Send the slow stream, press Escape after approximately one second, and compare the idle UI with server `sent` output. The current expected behavior is that native download and chunk writes stop.
6. For a completed response, record Pretty, jq `.meta.fixture`, search for `purr-tail-marker`, and download duration.
7. Load small and large GraphQL introspection endpoints into schema documents; record time to usable explorer and subjective editor responsiveness while requesting completion/hover.
8. Open the response Timeline and record the available processing diagnostics: Native setup, Network, Encryption, SQLite write, Storage backpressure, Tauri IPC, Read/decrypt + decode, and Response ready. `Read/decrypt + decode` appears for the inline response path below 1 MiB; bounded responses do not materialize the full body. These stages can overlap and are diagnostic; do not add hard timing assertions to CI.

Record results in `tests/performance/baseline-current.md`. Do not add absolute performance thresholds to normal CI from a single-machine run.
