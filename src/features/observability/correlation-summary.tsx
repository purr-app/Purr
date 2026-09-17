import type { TracePage } from "../../domain/observability";
export function CorrelationSummary({ value }: { value: TracePage["correlation"] }) {
  const entries = [["Sent", value.injectedTraceId], ["Lookup", value.lookupReference?.id], ["Resolved", value.resolvedTraceId]] as const;
  const ids = new Set(entries.map(([, id]) => id).filter(Boolean));
  if (!ids.size) return null;
  return <div aria-label="Trace correlation" className="flex flex-wrap items-center gap-x-ui-4 gap-y-ui-1 text-ui-sm text-content-secondary">
    {ids.size === 1 ? <div>Trace ID <span className="font-code select-text">{[...ids][0]}</span></div>
      : [...ids].map((id) => <div key={id}>{entries.filter(([, value]) => value === id).map(([label]) => label).join(" / ")}: <span className="font-code select-text">{id}</span></div>)}
    {value.lookupReference ? <span className="text-content-tertiary">Correlation: {value.lookupReference.source} · {value.lookupReference.format}</span> : null}
  </div>;
}
