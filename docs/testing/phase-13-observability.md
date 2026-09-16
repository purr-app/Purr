# Phase 13: native observability verification

These are synthetic providers, not Jaeger or commercial integrations. Use a disposable workspace. The normal build has no concrete trace provider; the fixture feature is explicit:

```sh
npm run tauri dev -- --features observability-fixtures
```

1. Create/open a disposable workspace and obtain its `id` from its `purr.yaml` (workspace menu → open workspace folder). Generate fixtures outside the workspace, using that actual ID:

   ```sh
   node scripts/performance/create-observability-fixtures.mjs YOUR_WORKSPACE_ID /tmp/purr-phase13-fixtures
   ```

   The output directory must not already exist. This command does not edit the workspace. Copy `trace-alpha.yaml` and `trace-beta.yaml` into the workspace's `integrations/` directory. Restart/reopen Purr so the canonical definitions have been read.

2. Open Purr DevTools → Console and run the two statements in the generated `credentials.dev-console.js`. They write only `purr-synthetic-token` through the existing secure-store command. Do not paste real credentials. This temporary provisioning step replaces a provider settings editor, which belongs to Phase 14. Workspace Settings → Integrations should show both providers as available only in the fixture build.

3. Start the existing fixture server (`npm run fixture:responses`). Send `GET http://127.0.0.1:43119/response/json?size=1024` with this enabled request header:

   ```text
   traceparent: 00-0123456789abcdef0123456789abcdef-0123456789abcdef-01
   ```

   Open **Trace**, select **Synthetic alpha**, then **Load trace**. Expect the same trace ID, 60 spans, service `synthetic-alpha`, root/parent IDs in Span details, one error span, and a maximum of 25 visible rows. **Next spans** reaches 26–50 then 51–60. Search `operation-59` and Load trace returns exactly one span. Clear search and load again to return to the first page. Repeating the lookup displays `cached`.

4. Select **Synthetic beta** and load. Expect service `synthetic-beta` after its synthetic delay. Cancel a lookup, leave the Trace tab, switch documents, or resend the request while it is pending. Expect no late result in the new view. For a reliably delayed repeat, change `delayMs` in `trace-beta.yaml` to `3000`, then load after the file is saved; changing config creates a fresh native cache key.

5. Send a response with the header removed. Expect **No trace was found**. Enter the trace ID manually and load; expect a trace. An invalid manual ID produces a safe validation message. Test the alternative enabled header `x-b3-traceid: 0123456789abcdef0123456789abcdef` as well.

6. Restart Purr and load a trace from the saved response. Expect credentials to resolve without re-entering the token and no token value in either integration YAML. Change the synthetic token through the generated Console command to another nonempty synthetic value; the next lookup must not show `cached`. Delete that one token with `secure_delete` using the same reference and expect a missing-credential error even if a trace was previously cached; restore it afterward.

7. Disable the integration in Workspace Settings, wait for saving, return to Trace, and confirm it cannot execute. Restart without `--features observability-fixtures`: both definitions are preserved but unavailable; ordinary REST/GraphQL requests continue to work.

The native service reads only the exact saved execution's metadata, identified by workspace/document/start timestamp. It tolerates the normal save debounce for up to one second; a failed/unfinished save reports **Response not saved yet**, with a retry after saving. It never blocks the ordinary request display or sends a body back from React for correlation.

Current deliberate limits: one correlated trace per lookup (first valid response-header match, then request-header match; manual input takes precedence), 1,000 spans and 64 KiB normalized data per trace, 25 spans/page, 32 cache entries with 60-second TTL, four concurrent lookups and a 15-second timeout. The cache is memory-only; credentials are re-resolved before cache reuse. Provider-side trace search, full trace trees/waterfalls, persistent cache, and real vendor adapters are later work. No logs provider/API is created speculatively.
