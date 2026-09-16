import { useEffect, useRef, useState } from "react";
import { useApplicationServices } from "../../app/application-services-context";
import type { IntegrationSummary, TracePage } from "../../domain/observability";
import { Button } from "../../shared/components/ui/button";
import { Input } from "../../shared/components/ui/input";
import { SelectField } from "../../shared/components/ui/select-field";

const errors: Record<string, string> = {
  unavailable: "This integration is unavailable in this build.", disabled: "This integration is disabled.",
  invalid_config: "The integration configuration is invalid or needs a supported version.",
  credential_unavailable: "The integration credential is missing or outside its permitted scope.",
  response_pending: "This response has not been saved yet. Retry after saving completes.",
  invalid_query: "Enter a valid trace ID (16 or 32 hexadecimal characters).",
  invalid_cursor: "The integration changed. Load the trace again to restart pagination.",
  limit_exceeded: "This trace exceeds the current preview limit.",
  busy: "Too many trace lookups are running. Try again shortly.",
  storage_unavailable: "The saved integration or response cannot be read.",
  provider_failed: "The trace provider could not complete this lookup.",
};

export function TracePanel({ workspaceId, documentId, startedAtMs }: {
  workspaceId: string; documentId: string; startedAtMs: number;
}) {
  const { observability } = useApplicationServices();
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [selected, setSelected] = useState("");
  const [manualTraceId, setManualTraceId] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<TracePage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const active = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    observability.integrations(workspaceId).then((items) => {
      if (live) { setIntegrations(items); setSelected(items.find((item) => item.available && item.enabled)?.id ?? ""); }
    }).catch(() => { if (live) setError("The integration list could not be loaded."); });
    return () => { live = false; active.current?.abort(); };
  }, [observability, workspaceId]);

  function reset() { active.current?.abort(); active.current = null; setLoading(false); setPage(null); setError(""); }
  async function lookup(cursor: string | null = null) {
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setLoading(true); setError("");
    try {
      const result = await observability.trace({ workspaceId, documentId, startedAtMs, integrationId: selected,
        manualTraceId: manualTraceId.trim() || null, search, cursor }, controller.signal);
      if (active.current === controller && !controller.signal.aborted) setPage(result);
    } catch (cause) {
      if (active.current === controller && !controller.signal.aborted) {
        setPage(null); setError(errors[String(cause)] ?? "The trace lookup failed.");
      }
    } finally { if (active.current === controller) setLoading(false); }
  }

  return <section aria-label="Trace lookup" className="h-full overflow-auto p-ui-4 font-ui text-ui-sm text-content-primary">
    <div className="flex flex-wrap items-center gap-ui-2">
      <SelectField label="Trace integration" value={selected} onValueChange={(value) => { reset(); setSelected(value); }}
        options={[{ value: "", label: "Select integration" }, ...integrations.map((item) => ({ value: item.id,
          label: `${item.name}${!item.available ? " (unavailable)" : !item.enabled ? " (disabled)" : ""}` }))]} />
      <Input aria-label="Manual trace ID" placeholder="Trace ID (optional)" value={manualTraceId} maxLength={32}
        onChange={(event) => { reset(); setManualTraceId(event.target.value); }}
        className="w-auto font-code" />
      <Input aria-label="Search trace spans" placeholder="Service or operation" value={search} maxLength={128}
        onChange={(event) => { reset(); setSearch(event.target.value); }}
        className="w-auto" />
      <Button size="sm" disabled={!integrations.some((item) => item.id === selected && item.enabled && item.available) || loading} onClick={() => void lookup()}>Load trace</Button>
      {loading ? <Button size="sm" variant="secondary" onClick={reset}>Cancel trace lookup</Button> : null}
    </div>
    {!integrations.length ? <p>No trace integrations are configured or available. Configure a provider before looking up a trace.</p> : null}
    {loading ? <p role="status">Loading trace…</p> : null}
    {error ? <p role="alert" className="text-accent-red">{error}</p> : null}
    {page && !loading ? page.traceId ? <div className="mt-ui-4">
      <p className="font-code">Trace {page.traceId} · {page.total} spans{page.cached ? " · cached" : ""}</p>
      <table className="w-full text-left text-ui-sm"><thead><tr><th>Service / operation</th><th>Start (µs)</th><th>Duration</th><th>Status</th></tr></thead>
        <tbody>{page.spans.map((span) => <tr key={span.id} className="border-t border-border-subtle align-top">
          <td className="py-ui-2"><span>{span.service} / {span.operation}</span><details className="text-ui-xs text-content-tertiary"><summary>Span details</summary>
            <div className="font-code">ID: {span.id}<br />Parent: {span.parentSpanId ?? "root"}
              {Object.entries(span.attributes).map(([key, value]) => <div key={key}>{key}: {typeof value === "string" ? value : JSON.stringify(value)}</div>)}
            </div></details></td><td className="font-code">{span.startedAtUs}</td><td className="font-code">{span.durationUs} µs</td><td>{span.status}</td>
        </tr>)}</tbody></table>
      {page.nextCursor ? <Button size="sm" variant="secondary" onClick={() => void lookup(page.nextCursor)}>Next spans</Button> : null}
    </div> : <p>No trace was found. Check the response correlation headers or enter a trace ID.</p> : null}
  </section>;
}
