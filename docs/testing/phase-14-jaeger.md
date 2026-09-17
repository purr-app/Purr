# Phase 14: Jaeger, propagation and trace UX verification

Use a disposable workspace. No production credentials or private data are needed. Automated coverage uses synthetic OTLP JSON, loopback HTTP, fake native providers and browser IPC/persistence mocks; it does not substitute for a native desktop check.

## Prepare

```sh
npm run fixture:traces
```

Keep this terminal running. It binds only `127.0.0.1:43120`, serves an instrumented synthetic `/echo` and a Jaeger-compatible Query API v3 endpoint. It retains at most 32 traces in memory. It is a fixture, not a Jaeger deployment. For a real Jaeger test, use a query server with `/api/v3/traces/{traceId}` and a service that exports spans to that server.

In another terminal launch the current working tree:

```sh
npm run tauri dev
```

## Owner checklist

- [ ] **Configure:** Workspace Settings → Integrations → Add Jaeger. Name it `Local traces`, endpoint `http://127.0.0.1:43120`, auth None, Save integration. It appears once with the `traces` capability. An invalid endpoint such as `file:///invalid` must be rejected without creating a definition.
- [ ] **W3C:** set Default trace propagation to W3C Trace Context. Send `GET http://127.0.0.1:43120/echo` from a request whose Settings inherit the workspace. Response JSON has identical `receivedTraceId` and `recordedTraceId`. The Request tab shows the generated `traceparent`. Opening Trace shows that ID only once, plus its response-header provenance.
- [ ] **B3 and overrides:** select B3 in request Settings and resend; Request shows generated `b3`. Add an enabled explicit `traceparent: 00-0123456789abcdef0123456789abcdef-0123456789abcdef-01` and resend: that exact value remains, and Purr does not also add B3. Remove the header, set request propagation Off and resend: fixture `receivedTraceId` is null even though the workspace default is W3C.
- [ ] **Hierarchy/details:** return to W3C, send `/echo`, open Trace. Expect 60 spans in total, first 25 loaded. Select `GET /echo` and inspect its service `purr-synthetic-checkout`, 100 ms duration and attributes. Collapse/expand its children. Load more spans twice: one tree grows to 60; the selected span remains selected. `operation-59` has error status and `db.statement: synthetic-tail-query`.
- [ ] **Search:** enter `synthetic-tail-query`. Expect `GET /echo → operation-1 → operation-59`, preserving ancestors; select the last span and inspect its attribute. Clear search and load more again. No separate page replaces the previous hierarchy.
- [ ] **Different identity:** send `GET http://127.0.0.1:43120/echo?replace=1`. Trace shows the sent ID separately from the new combined Lookup / Resolved ID. The returned trace belongs to the recorded ID, not an assumed copy of the sent ID.
- [ ] **Cancellation:** add a second integration `Slow traces` at `http://127.0.0.1:43120/slow`. Send a fresh `/echo` request, open Trace → Source, select Slow traces. During its three-second lookup switch document or change search/source; no late trace or cancellation error appears in the new context. Use a fresh execution to avoid the 60-second cache. Explicit Cancel trace lookup must display `Trace lookup cancelled.` and allow another load.
- [ ] **Credentials/restart:** edit Local traces to Bearer token and enter only `purr-synthetic-token` (the fixture accepts it). Save, wait for normal workspace save, restart Purr while the fixture stays running, and open the saved response's Trace. It loads without token re-entry. Reopening settings shows an empty token field; integration YAML contains `kind: secret` and the scoped `ref`, never the token value. Disable that integration, save/restart: it stays disabled and cannot execute.
- [ ] **Ordinary requests:** with propagation Off, send existing HTTP and GraphQL requests. Status/body/headers, cancellation and saved request state behave as before. Opening/closing Trace does not delay normal response display.

## Remove Jaeger from composition

Stop the existing dev process, then launch:

```sh
VITE_PURR_JAEGER=disabled npm run tauri dev -- --no-default-features
```

- [ ] Existing integrations remain in Workspace Settings with `Provider unavailable`; Add Jaeger is absent. Trace cannot execute them. HTTP/GraphQL requests, saved workspaces and the rest of the application remain usable.

Stop this process and resume `npm run tauri dev` to restore the default adapter. No source files are copied or edited for either variant. Automated build checks exercise the same frontend flag and native Cargo feature independently.

## Intentional limits

One response-linked trace; standard W3C/B3 correlation or manual ID; 4 MiB vendor payload; 1,000 spans / 64 KiB normalized trace; 25 spans per incremental read; 60-second bounded memory cache. Large traces receive a safe limit message. There is no provider-wide trace discovery, log execution, waterfall, custom-header configuration editor, folder propagation override or automatic cache refresh yet. A future timeline column can use the existing hierarchy/selection model. Real-server compatibility verification is separate from the synthetic fixture check.
