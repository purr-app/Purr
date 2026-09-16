import { useCallback, useEffect, useRef, useState } from "react";
import { useApplicationServices } from "../../app/application-services-context";
import type { IntegrationSummary, TracePage } from "../../domain/observability";
import { Button } from "../../shared/components/ui/button";
import { Input } from "../../shared/components/ui/input";
import { SelectField } from "../../shared/components/ui/select-field";
import { TraceHierarchy } from "./trace-hierarchy";
import { CorrelationSummary } from "./correlation-summary";

const errors: Record<string, string> = {
  unavailable: "This integration is unavailable in this build.", disabled: "This integration is disabled.",
  invalid_config: "Review this integration’s settings.", credential_unavailable: "The integration credential is missing or outside its permitted scope.",
  response_pending: "This response has not been saved yet. Retry after saving completes.",
  invalid_query: "Enter a valid trace ID (16 or 32 hexadecimal characters).",
  invalid_cursor: "The trace changed. Reload it to continue.", limit_exceeded: "This trace exceeds the current preview limit.",
  busy: "Too many trace lookups are running. Try again shortly.", storage_unavailable: "The saved integration or response cannot be read.",
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
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "cancelled" | "error">("idle");
  const active = useRef<AbortController | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    let live = true;
    observability.integrations(workspaceId).then((items) => {
      if (live) { setIntegrations(items); setSelected(items.find((item) => item.available && item.enabled && item.capabilities.includes("traces"))?.id ?? ""); }
    }).catch(() => { if (live) { setError("The integration list could not be loaded."); setStatus("error"); } });
    return () => { live = false; active.current?.abort(); };
  }, [observability, workspaceId]);
  const stop = useCallback(() => { clearTimeout(pending.current); pending.current = undefined; active.current?.abort(); active.current = null; }, []);
  const lookup = useCallback(async (cursor: string | null = null) => {
    stop();
    const controller = new AbortController(); active.current = controller;
    setStatus("loading"); setError("");
    try {
      const result = await observability.trace({ workspaceId, documentId, startedAtMs, integrationId: selected,
        manualTraceId: manualTraceId.trim() || null, search, cursor }, controller.signal);
      if (active.current !== controller || controller.signal.aborted) return;
      setPage((previous) => cursor && previous && previous.traceId === result.traceId
        ? { ...result, spans: [...previous.spans, ...result.spans], rows: [...previous.rows, ...result.rows] } : result);
      setStatus("ready");
    } catch (cause) {
      if (active.current === controller && !controller.signal.aborted) {
        setError(errors[String(cause)] ?? "The trace lookup failed."); setStatus("error");
      }
    } finally {
      if (active.current === controller) active.current = null;
    }
  }, [stop, observability, workspaceId, documentId, startedAtMs, selected, manualTraceId, search]);
  const available = integrations.some((item) => item.id === selected && item.enabled && item.available && item.capabilities.includes("traces"));
  useEffect(() => {
    stop(); setPage(null); setError(""); setStatus("idle");
    pending.current = available ? setTimeout(() => void lookup(), 200) : undefined;
    return stop;
  }, [lookup, stop, available]);
  function change(action: () => void) { stop(); setPage(null); setStatus("idle"); action(); }
  return <section aria-label="Trace lookup" className="flex h-full min-h-0 flex-col font-ui text-ui-sm text-content-primary">
    <div className="flex flex-wrap items-center gap-ui-3 border-b border-border-subtle p-ui-3">
      <div className="min-w-0 flex-1"><p className="m-ui-0 font-medium">Trace for this execution</p>
        <p className="m-ui-0 text-ui-xs text-content-tertiary">{new Date(startedAtMs).toLocaleTimeString()}{page ? ` · ${page.total} spans${page.cached ? " · cached" : ""}` : ""}</p></div>
      <Input aria-label="Search trace spans" placeholder="Search spans and attributes" value={search} maxLength={128}
        onChange={(event) => change(() => setSearch(event.target.value))} className="h-control-sm w-auto rounded-ui-md text-ui-sm" />
      {status === "loading" ? <Button size="sm" variant="secondary" onClick={() => { stop(); setStatus("cancelled"); }}>Cancel trace lookup</Button>
        : <Button size="sm" disabled={!available} onClick={() => { setPage(null); void lookup(); }}>Load trace</Button>}
    </div>
    <details className="border-b border-border-subtle px-ui-3 py-ui-2 text-ui-xs text-content-secondary">
      <summary className="cursor-pointer ui-focus-ring">Source: {integrations.find((item) => item.id === selected)?.name ?? "No trace integration"}</summary>
      <div className="mt-ui-2 flex flex-wrap items-center gap-ui-2">
        <SelectField label="Trace integration" value={selected} onValueChange={(value) => change(() => setSelected(value))}
          options={[{ value: "", label: "Select integration" }, ...integrations.map((item) => ({ value: item.id,
            label: `${item.name} · ${item.capabilities.join(", ") || "unavailable"}${!item.enabled ? " (disabled)" : ""}` }))]} />
        <Input aria-label="Manual trace ID" placeholder="Trace ID override (optional)" value={manualTraceId} maxLength={32}
          onChange={(event) => change(() => setManualTraceId(event.target.value))} className="w-auto font-code" />
      </div>
    </details>
    {page ? <CorrelationSummary value={page.correlation} /> : null}
    {!integrations.length ? <p className="p-ui-3">Add a trace integration in Workspace Settings to inspect this execution.</p> : null}
    {status === "loading" ? <p role="status" className="px-ui-3 text-content-tertiary">{page ? "Loading more spans…" : "Finding this execution’s trace…"}</p> : null}
    {status === "cancelled" ? <p role="status" className="px-ui-3 text-content-secondary">Trace lookup cancelled.</p> : null}
    {error ? <p role="alert" className="px-ui-3 text-accent-red">{error}</p> : null}
    {page?.traceId ? <TraceHierarchy key={`${selected}:${search}:${page.traceId}`} spans={page.spans} rows={page.rows} /> : null}
    {page && !page.traceId && status !== "loading" ? <p className="p-ui-3">No trace was found. The service may not have recorded it yet; retry or supply a trace ID.</p> : null}
    {page?.nextCursor ? <div className="border-t border-border-subtle p-ui-2"><Button size="sm" variant="secondary" disabled={status === "loading"} onClick={() => void lookup(page.nextCursor)}>Load more spans</Button><span className="ml-ui-2 text-ui-xs text-content-tertiary">{page.rows.length} of {page.total} loaded</span></div> : null}
  </section>;
}
