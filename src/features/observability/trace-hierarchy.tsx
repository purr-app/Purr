import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { TraceRow, TraceSpan } from "../../domain/observability";
import { Button } from "../../shared/components/ui/button";

// Rows are projected/ordered in Rust. React owns only selection and folding.
// A future timeline column consumes the same row/span and inspector selection.
export function TraceHierarchy({ spans, rows, timelineColumn }: {
  spans: TraceSpan[]; rows: TraceRow[]; timelineColumn?: (span: TraceSpan) => ReactNode;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const byId = new Map(spans.map((span) => [span.id, span]));
  const inspected = selected ? byId.get(selected) : undefined;
  let hiddenBelow: number | null = null;
  const visible = rows.filter((row) => {
    if (hiddenBelow !== null && row.depth > hiddenBelow) return false;
    hiddenBelow = collapsed.has(row.spanId) ? row.depth : null;
    return true;
  });
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
    <div role="tree" aria-label="Trace spans" className="min-h-0 min-w-0 flex-1 overflow-auto p-ui-2">
      {visible.map((row) => {
        const span = byId.get(row.spanId); if (!span) return null;
        return <div key={row.spanId} role="treeitem" aria-level={row.depth + 1} aria-selected={selected === span.id}
          aria-expanded={row.hasChildren ? !collapsed.has(span.id) : undefined}
          className={`flex items-center gap-ui-2 rounded-ui-md border-b border-border-subtle py-ui-2 ${selected === span.id ? "bg-purr-elevated" : ""}`}>
          <div className="flex shrink-0" aria-hidden="true">{Array.from({ length: Math.min(row.depth, 12) }, (_, index) => <span key={index} className="w-ui-3 border-r border-border-subtle" />)}</div>
          {row.hasChildren ? <Button size="icon" variant="ghost" aria-label={`${collapsed.has(span.id) ? "Expand" : "Collapse"} ${span.operation}`} onClick={() => setCollapsed((previous) => { const next = new Set(previous); if (next.has(span.id)) next.delete(span.id); else next.add(span.id); return next; })}>
            {collapsed.has(span.id) ? <ChevronRight className="size-ui-3" /> : <ChevronDown className="size-ui-3" />}</Button> : <span className="w-control-sm shrink-0" />}
          <button className="ui-focus-ring min-w-0 flex-1 rounded-ui-sm text-left" onClick={() => setSelected(span.id)}>
            <span className={`block truncate text-ui-sm ${row.matchesSearch ? "text-content-primary" : "text-content-tertiary"}`}>{span.operation}</span>
            <span className="text-ui-xs text-content-tertiary">{span.service}</span>
          </button>
          {timelineColumn?.(span)}
          <span className={`shrink-0 font-code text-ui-xs ${span.status === "error" ? "text-accent-red" : "text-content-secondary"}`}>{(span.durationUs / 1000).toLocaleString()} ms · {span.status}</span>
        </div>;
      })}
      {!rows.length ? <p className="p-ui-3 text-content-tertiary">No spans match this search.</p> : null}
    </div>
    <aside aria-label="Span details" className="min-h-0 flex-1 overflow-auto border-l border-border-subtle p-ui-4">
      {inspected ? <><h3 className="m-ui-0 text-ui-md font-medium">{inspected.operation}</h3><p className="text-content-secondary">{inspected.service}</p>
        <dl className="space-y-ui-2 text-ui-xs">
          {[["Span ID", inspected.id], ["Parent", inspected.parentSpanId ?? "Root"], ["Started (µs)", inspected.startedAtUs], ["Duration (µs)", inspected.durationUs], ["Status", inspected.status],
            ...Object.entries(inspected.attributes).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)])].map(([key, value], index) => <div key={index}><dt className="text-content-tertiary">{key}</dt><dd className="m-ui-0 break-all font-code select-text">{value}</dd></div>)}
        </dl></> : <p className="text-content-tertiary">Select a span to inspect its timing and attributes.</p>}
    </aside>
  </div>;
}
