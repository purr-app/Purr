import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// Synthetic instrumented service + Jaeger Query v3 endpoint for manual testing.
// Binds loopback only. Never proxies traffic or reads user workspace data.
const traces = new Map<string, unknown>();
function makeTrace(id: string) {
  return { result: { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "purr-synthetic-checkout" } }] },
    scopeSpans: [{ scope: { name: "purr-manual-fixture" }, spans: Array.from({ length: 60 }, (_, index) => ({
      traceId: id, spanId: (index + 1).toString(16).padStart(16, "0"),
      ...(index ? { parentSpanId: (index > 30 ? 2 : 1).toString(16).padStart(16, "0") } : {}),
      name: index ? `operation-${index}` : "GET /echo",
      startTimeUnixNano: (1700000000000000000n + BigInt(index) * 1000000n).toString(),
      endTimeUnixNano: (1700000000000000000n + BigInt(index) * 1000000n + (index ? 750000n : 100000000n)).toString(),
      status: { code: index === 59 ? 2 : 1 },
      attributes: [{ key: "fixture", value: { stringValue: "purr-synthetic" } }, { key: "step", value: { intValue: String(index) } },
        ...(index === 59 ? [{ key: "db.statement", value: { stringValue: "synthetic-tail-query" } }] : [])],
    })) }] }] } };
}
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  response.setHeader("Content-Type", "application/json");
  if (url.pathname === "/echo") {
    const context = String(request.headers.traceparent ?? request.headers.b3 ?? request.headers["x-b3-traceid"] ?? "");
    const candidate = request.headers.traceparent ? context.split("-")[1] : context.split("-")[0];
    const supplied = /^(?:[0-9a-f]{16}|[0-9a-f]{32})$/i.test(candidate ?? "") ? candidate.toLowerCase().padStart(32, "0") : null;
    const id = url.searchParams.has("replace") || !supplied ? randomBytes(16).toString("hex") : supplied;
    traces.set(id, makeTrace(id));
    if (traces.size > 32) traces.delete(traces.keys().next().value!);
    response.setHeader("traceparent", `00-${id}-0000000000000001-01`);
    response.end(JSON.stringify({ fixture: "purr-synthetic", receivedTraceId: supplied, recordedTraceId: id }));
    return;
  }
  const match = url.pathname.match(/^\/(?:slow\/)?api\/v3\/traces\/([0-9a-f]{16,32})$/i);
  if (match) {
    const value = traces.get(match[1].toLowerCase().padStart(32, "0"));
    const send = () => { if (response.destroyed) return; response.statusCode = value ? 200 : 404; response.end(JSON.stringify(value ?? { error: { code: 5 } })); };
    if (url.pathname.startsWith("/slow/")) { const timer = setTimeout(send, 3000); response.on("close", () => clearTimeout(timer)); } else send();
    return;
  }
  response.statusCode = 404; response.end(JSON.stringify({ fixture: "purr-synthetic", error: "not found" }));
});
server.listen(43120, "127.0.0.1", () => console.log("Synthetic service: http://127.0.0.1:43120/echo; Jaeger v3 endpoint: http://127.0.0.1:43120 (or /slow for cancellation)."));
