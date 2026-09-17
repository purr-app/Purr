import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import type { TraceRow, TraceSpan } from "../../domain/observability";
import { Button } from "../../shared/components/ui/button";
import { useTabState } from "../../shared/state/tab-state";

export function traceDuration(value: number) {
  return value < 1000 ? `${Number(value.toFixed(1))} µs` : value < 1_000_000 ? `${Number((value / 1000).toFixed(2))} ms` : `${Number((value / 1_000_000).toFixed(2))} s`;
}
const colors = ["bg-accent-cyan", "bg-accent-orange", "bg-accent-violet", "bg-accent-emerald", "bg-accent-magenta", "bg-accent-blue", "bg-accent-slate"];
function spanDescription(span: TraceSpan) {
  const detail = ["db.query.text", "db.statement", "http.route", "url.full", "dns.question.name", "server.address"].map((key) => span.attributes[key]).find((value) => typeof value === "string" && value !== span.operation);
  return `${traceDuration(span.durationUs)} | ${span.service}::${span.operation}${detail ? ` · ${detail}` : ""}`;
}

// Parent-first rows and global timing bounds come from native projection.
export function TraceHierarchy({ spans, rows, stateKey = "trace", startedAtUs, durationUs, findQuery = "", findMatchIndex = 0, onFindMatchCount }: {
  spans: TraceSpan[]; rows: TraceRow[]; stateKey?: string;
  findQuery?: string; findMatchIndex?: number; onFindMatchCount?: (count: number) => void;
  startedAtUs?: number; durationUs?: number;
}) {
  const [selected, setSelected] = useTabState<string | null>(`${stateKey}.selected`, null);
  const [collapsed, setCollapsed] = useTabState<Set<string>>(`${stateKey}.collapsed`, () => new Set());
  const [scrollOffset, setScrollOffset] = useTabState(`${stateKey}.scroll`, 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => new Map(spans.map((span) => [span.id, span])), [spans]);
  const inspected = selected ? byId.get(selected) : undefined;
  const serviceColors = useMemo(() => new Map([...new Set(spans.map((span) => span.service))].sort().map((service, index) => [service, colors[index % colors.length]])), [spans]);
  const serviceColor = (service: string) => serviceColors.get(service) ?? colors[0];
  const matches = useMemo(() => {
    const query = findQuery.trim().toLocaleLowerCase();
    if (!query) return [];
    return rows.filter((row) => {
      const span = byId.get(row.spanId);
      return span && `${span.service} ${span.operation} ${span.id} ${span.status} ${JSON.stringify(span.attributes)}`.toLocaleLowerCase().includes(query);
    }).map((row) => row.spanId);
  }, [rows, byId, findQuery]);
  const matchIds = useMemo(() => new Set(matches), [matches]);
  const activeMatch = matches[findMatchIndex % matches.length];
  const findAncestors = useMemo(() => {
    const ancestors = new Set<string>();
    let parent = activeMatch ? byId.get(activeMatch)?.parentSpanId : null;
    while (parent && !ancestors.has(parent)) { ancestors.add(parent); parent = byId.get(parent)?.parentSpanId; }
    return ancestors;
  }, [activeMatch, byId]);
  useEffect(() => { onFindMatchCount?.(matches.length); }, [matches.length, onFindMatchCount]);
  const visible = useMemo(() => {
    let hiddenBelow: number | null = null;
    return rows.filter((row) => {
      if (hiddenBelow !== null && row.depth > hiddenBelow) return false;
      hiddenBelow = collapsed.has(row.spanId) && !findAncestors.has(row.spanId) ? row.depth : null;
      return true;
    });
  }, [rows, collapsed, findAncestors]);
  const bounds = useMemo(() => {
    let start = Infinity; let end = 0;
    for (const span of spans) { start = Math.min(start, span.startedAtUs); end = Math.max(end, span.startedAtUs + span.durationUs); }
    return { start: startedAtUs ?? (Number.isFinite(start) ? start : 0), duration: Math.max(1, durationUs ?? end - start) };
  }, [spans, startedAtUs, durationUs]);
  const virtualizer = useVirtualizer({ count: visible.length, getScrollElement: () => scrollRef.current,
    estimateSize: () => Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--trace-row-height")),
    overscan: 12, initialOffset: scrollOffset, getItemKey: (index) => visible[index].spanId });
  const items = virtualizer.getVirtualItems();
  useEffect(() => {
    if (!activeMatch) return;
    const index = visible.findIndex((row) => row.spanId === activeMatch);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
  }, [activeMatch, visible, virtualizer]);
  function fold(id: string) {
    setCollapsed((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  return <div className="flex min-h-0 flex-1 overflow-hidden">
    <div ref={scrollRef} role="tree" aria-label="Trace spans" className="min-h-0 min-w-0 flex-1 overflow-auto" onScroll={(event) => setScrollOffset(event.currentTarget.scrollTop)}>
      <div className="ui-trace-table">
        <div className="ui-trace-grid sticky top-0 z-10 border-b border-border-subtle bg-purr-elevated text-ui-md">
          <div className="px-ui-3 py-ui-3 text-content-secondary">Service &amp; operation</div>
          <div className="relative flex items-center justify-between border-l border-border-subtle px-ui-2 font-code text-content-tertiary">
            {[0, 0.25, 0.5, 0.75, 1].map((fraction) => <span key={fraction}>{traceDuration(bounds.duration * fraction)}</span>)}
          </div>
          <div className="flex items-center justify-end px-ui-2 text-content-tertiary">Duration</div>
        </div>
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const row = visible[item.index]; const span = byId.get(row.spanId); if (!span) return null;
            const left = Math.max(0, Math.min(100, (span.startedAtUs - bounds.start) / bounds.duration * 100));
            const width = Math.max(0, Math.min(100 - left, span.durationUs / bounds.duration * 100));
            return <div key={item.key} data-index={item.index} role="treeitem" aria-level={row.depth + 1} aria-selected={selected === span.id}
              aria-expanded={row.hasChildren ? !collapsed.has(span.id) || findAncestors.has(span.id) : undefined}
              className={`group ui-trace-grid ui-trace-row absolute left-0 top-0 w-full border-b border-border-subtle ${activeMatch === span.id ? "bg-action-brand-surface" : selected === span.id ? "bg-purr-highlight" : "hover:bg-purr-elevated"}`}
              style={{ transform: `translateY(${item.start}px)` }}>
              <div className="flex min-w-0 items-center gap-ui-1 px-ui-2">
                <span className="flex shrink-0" aria-hidden="true">{Array.from({ length: Math.min(row.depth, 8) }, (_, index) => <span key={index} className="h-ui-5 w-ui-2 border-r border-border-subtle" />)}</span>
                {row.hasChildren ? <Button size="icon" variant="ghost" className="text-action-brand" aria-label={`${collapsed.has(span.id) && !findAncestors.has(span.id) ? "Expand" : "Collapse"} ${span.operation}`} onClick={() => fold(span.id)}>
                  {collapsed.has(span.id) && !findAncestors.has(span.id) ? <ChevronRight className="size-ui-4" /> : <ChevronDown className="size-ui-4" />}</Button> : <span className="w-control-sm shrink-0" />}
                <button className="ui-focus-ring min-w-0 flex-1 rounded-ui-sm text-left text-ui-md" title={spanDescription(span)} onClick={() => setSelected(span.id)}>
                  <span className="flex items-center gap-ui-2"><span className={`size-ui-2 shrink-0 rounded-full ${serviceColor(span.service)}`} /><span className="truncate font-medium text-content-primary">{span.service}</span></span>
                  <span className={`block truncate font-code ${matchIds.has(span.id) ? "text-action-brand" : "text-content-secondary"}`}>{span.operation}</span>
                </button>
              </div>
              <button type="button" aria-label={`${span.operation}: ${traceDuration(span.durationUs)}`} title={spanDescription(span)} onClick={() => setSelected(span.id)} className="ui-focus-ring relative min-w-0 overflow-hidden border-l border-border-subtle text-left font-code text-ui-md">
                {[0.25, 0.5, 0.75].map((fraction) => <span key={fraction} aria-hidden="true" className="absolute inset-y-0 border-l border-border-subtle" style={{ left: `${fraction * 100}%` }} />)}
                <span className={`ui-trace-bar absolute top-1/2 -translate-y-1/2 rounded-ui-sm ${span.status === "error" ? "bg-accent-red" : serviceColor(span.service)}`} style={{ left: `${left}%`, width: `${width}%` }} />
                <span className="pointer-events-none absolute inset-x-ui-2 bottom-0 truncate text-ui-xs text-content-primary opacity-ui-hidden group-hover:opacity-ui-visible group-focus-within:opacity-ui-visible">{spanDescription(span)}</span>
              </button>
              <button type="button" aria-label={`Inspect ${span.operation}`} onClick={() => setSelected(span.id)} className="ui-focus-ring px-ui-2 text-right font-code text-ui-md text-content-primary">{traceDuration(span.durationUs)}</button>
            </div>;
          })}
        </div>
        {!rows.length ? <p className="p-ui-3 text-ui-md text-content-tertiary">No spans match this search.</p> : null}
      </div>
    </div>
    {inspected ? <aside aria-label="Span details" className="ui-trace-inspector min-h-0 shrink-0 overflow-auto border-l border-border-subtle bg-purr-surface p-ui-4 text-ui-code">
      <div className="flex items-start gap-ui-3"><div className="min-w-0 flex-1"><p className="m-ui-0 text-ui-md text-content-secondary">{inspected.service}</p><h3 className="mb-ui-0 mt-ui-1 break-words font-code text-ui-code font-medium">{inspected.operation}</h3></div><Button size="icon" variant="ghost" aria-label="Close span details" onClick={() => setSelected(null)}><X className="size-ui-4" /></Button></div>
      <section className="mt-ui-5 border-t border-border-subtle pt-ui-4"><h4 className="mb-ui-3 mt-ui-0 font-ui text-ui-md font-medium text-content-secondary">Timing</h4><dl className="space-y-ui-3">
        <Detail label="Duration" value={traceDuration(inspected.durationUs)} /><Detail label="Start offset" value={traceDuration(inspected.startedAtUs - bounds.start)} /><Detail label="Status" value={inspected.status} />
      </dl></section>
      <section className="mt-ui-5 border-t border-border-subtle pt-ui-4"><h4 className="mb-ui-3 mt-ui-0 font-ui text-ui-md font-medium text-content-secondary">Identity</h4><dl className="space-y-ui-3"><Detail label="Span ID" value={inspected.id} /><Detail label="Parent span" value={inspected.parentSpanId ?? "Root"} /></dl></section>
      <section className="mt-ui-5 border-t border-border-subtle pt-ui-4"><h4 className="mb-ui-3 mt-ui-0 font-ui text-ui-md font-medium text-content-secondary">Attributes</h4><dl className="space-y-ui-4">{Object.entries(inspected.attributes).map(([key, value]) => <Detail key={key} label={key} value={typeof value === "string" ? value : JSON.stringify(value)} />)}</dl>{!Object.keys(inspected.attributes).length ? <p className="font-code text-content-tertiary">No attributes</p> : null}</section>
    </aside> : null}
  </div>;
}
function Detail({ label, value }: { label: string; value: string }) {
  return <div><dt className="break-words font-code text-content-tertiary">{label}</dt><dd className="m-ui-0 mt-ui-1 select-text break-words font-code text-content-primary">{value}</dd></div>;
}
