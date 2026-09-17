import type { ObservabilityPort } from "../../application/ports/observability";
import type { TracePage, TraceQuery } from "../../domain/observability";

/** Publish a complete snapshot so virtual scroll geometry never changes during loading. */
export async function loadTraceSnapshot(port: ObservabilityPort, query: TraceQuery, signal: AbortSignal, onProgress: (loaded: number, total: number) => void): Promise<TracePage> {
  let snapshot: TracePage | undefined;
  const cursors = new Set<string>();
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const page = await port.trace({ ...query, cursor }, signal);
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (snapshot && (snapshot.traceId !== page.traceId || snapshot.total !== page.total)) throw new Error("invalid_cursor");
    if (page.spans.some((span) => ids.has(span.id))) throw new Error("invalid_cursor");
    page.spans.forEach((span) => ids.add(span.id));
    if (ids.size > 50000 || ids.size > page.total) throw new Error("limit_exceeded");
    if (snapshot) { snapshot.spans.push(...page.spans); snapshot.rows.push(...page.rows); snapshot.nextCursor = page.nextCursor; }
    else snapshot = { ...page, spans: [...page.spans], rows: [...page.rows] };
    onProgress(ids.size, page.total);
    cursor = page.nextCursor;
    if (cursor && (!page.spans.length || cursors.has(cursor))) throw new Error("invalid_cursor");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (snapshot.spans.length !== snapshot.total) throw new Error("invalid_cursor");
  return snapshot;
}
