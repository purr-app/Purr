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
| Set a local test cookie | `/cookies/set` |
| Confirm request cookie propagation | `/cookies/echo` |

Every response endpoint accepts `size`, `chunkSize`, `delayMs`, and `headersDelayMs`. The server caps bodies at 128 MiB and logs requested/sent bytes. If Purr truly aborts a request, the log shows fewer sent bytes; current UI cancellation is expected to let the native request continue.

## Desktop measurements

Use a release-like desktop build when comparing phases. Record the Purr process and its WebKit WebContent process separately in Activity Monitor or an equivalent process tool. Use the same build mode and close unrelated Purr windows before every run.

1. Record idle native RSS and WebView RSS after opening an empty workspace.
2. Send each JSON/text fixture once and record time from Send to visible response, peak native RSS, peak WebView RSS, and RSS after closing the response tab.
3. For the delayed-header endpoint, record that the current UI exposes no separate headers/TTFB state before the complete body arrives.
4. For exactly 20 MiB, record whether the response opens. For 20 MiB + 1 byte, record the expected `Response exceeds the 20 MB preview limit.` error.
5. Send the slow stream, press Escape after approximately one second, and compare the idle UI with server `sent` output. The current expected baseline is that the UI discards completion while native download continues.
6. For a completed response, record Pretty, jq `.meta.fixture`, search for `purr-tail-marker`, and download duration.
7. Load small and large GraphQL introspection endpoints into schema documents; record time to usable explorer and subjective editor responsiveness while requesting completion/hover.

Record results in `tests/performance/baseline-current.md`. Do not add absolute performance thresholds to normal CI from a single-machine run.
