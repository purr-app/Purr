import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { loadTraceSnapshot } from "../src/features/observability/load-trace";
import type { ObservabilityPort } from "../src/application/ports/observability";
import type { TracePage, TraceQuery } from "../src/domain/observability";

const fixture: TracePage = JSON.parse(readFileSync(new URL("./fixtures/observability/trace-page.json", import.meta.url), "utf8"));
const query: TraceQuery = { workspaceId: "workspace", documentId: "document", integrationId: "integration", startedAtMs: 0, manualTraceId: null, search: "", cursor: null };
function port(trace: ObservabilityPort["trace"]): ObservabilityPort {
  return { trace, integrations: async () => [], validateConfig: async (_provider, _version, config) => config };
}
function page(index: number, nextCursor: string | null): TracePage {
  const id = String(index);
  return { ...fixture, total: 2, spans: [{ ...fixture.spans[0], id }], rows: [{ ...fixture.rows[0], spanId: id }], nextCursor };
}
test("trace snapshots collect every page once before publication", async () => {
  const calls: Array<string | null> = []; const progress: number[] = [];
  const result = await loadTraceSnapshot(port(async (input) => { calls.push(input.cursor); return page(input.cursor ? 2 : 1, input.cursor ? null : "second"); }), query, new AbortController().signal, (loaded) => progress.push(loaded));
  assert.deepEqual(calls, [null, "second"]); assert.deepEqual(progress, [1, 2]);
  assert.equal(result.nextCursor, null); assert.equal(result.spans.length, 2);
});
test("trace snapshots reject repeated cursors, mixed snapshots and incomplete results", async () => {
  for (const failure of ["repeated", "changed", "incomplete"]) {
    let calls = 0;
    await assert.rejects(loadTraceSnapshot(port(async () => {
      calls++;
      if (failure === "incomplete") return page(1, null);
      if (calls === 1) return page(1, "next");
      return { ...page(2, failure === "repeated" ? "next" : null), total: failure === "changed" ? 3 : 2 };
    }), query, new AbortController().signal, () => {}), /invalid_cursor/);
  }
});
test("cancelling between pages stops collection without publishing a partial tree", async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(loadTraceSnapshot(port(async () => { calls++; return page(1, "next"); }), query, controller.signal, () => controller.abort()), { name: "AbortError" });
  assert.equal(calls, 1);
});
