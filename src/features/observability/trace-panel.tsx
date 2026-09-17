import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import { useWorkspaceIntegrations } from "../../integrations/workspace-integrations";
import { prepareIntegrationConnection } from "../../integrations/prepare-connection";
import { integrationTraceUrl } from "../../integrations/trace-url";
import { useExtensionRegistry } from "../../extension-api/extension-context";
import { useApplicationServices } from "../../app/application-services-context";
import { useTabState } from "../../shared/state/tab-state";
import type { TracePage } from "../../domain/observability";
import { Button } from "../../shared/components/ui/button";
import { Input } from "../../shared/components/ui/input";
import { TraceHierarchy, traceDuration } from "./trace-hierarchy";
import { CorrelationSummary } from "./correlation-summary";
import { loadTraceSnapshot } from "./load-trace";

const errors: Record<string, string> = {
  unavailable: "This integration is unavailable in this build.", disabled: "This integration is disabled.",
  invalid_config: "Review this integration’s settings.", credential_unavailable: "The integration credential is missing or outside its permitted scope.",
  response_pending: "This response has not been saved yet. Retry after saving completes.",
  invalid_query: "This execution does not contain a valid trace ID.",
  invalid_cursor: "The trace changed. Reload it to continue.", limit_exceeded: "This trace exceeds the supported size. Try a smaller trace or open it in your provider.",
  busy: "Too many trace lookups are running. Try again shortly.", storage_unavailable: "The saved integration or response cannot be read.",
  provider_failed: "The trace provider could not complete this lookup.",
};

export function TracePanel({ workspaceId, documentId, startedAtMs, integrationId, findQuery = "", findMatchIndex = 0, onFindMatchCount, onOpenFind }: {
  workspaceId: string; documentId: string; startedAtMs: number; integrationId: string;
  findQuery?: string; findMatchIndex?: number; onFindMatchCount?: (count: number) => void; onOpenFind?: () => void;
}) {
  const services = useApplicationServices();
  const extensions = useExtensionRegistry();
  const connections = useWorkspaceIntegrations();
  const connectionRef = useRef(connections); connectionRef.current = connections;
  const prefix = `trace.${startedAtMs}.${integrationId}`;
  const [traceId, setTraceId] = useTabState(`${prefix}.traceId`, "");
  const [page, setPage] = useTabState<TracePage | null>(`${prefix}.snapshot`, null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "cancelled" | "error">("idle");
  const active = useRef<AbortController | null>(null);
  const stop = useCallback(() => { active.current?.abort(); active.current = null; }, []);
  const lookup = useCallback(async (manualTraceId: string | null = null) => {
    if (active.current) return;
    if (manualTraceId && (!/^(?:[a-f0-9]{16}|[a-f0-9]{32})$/i.test(manualTraceId) || /^0+$/.test(manualTraceId))) {
      setError("Enter a nonzero trace ID with 16 or 32 hexadecimal characters."); return;
    }
    const controller = new AbortController(); active.current = controller;
    setStatus("loading"); setError(""); setProgress(null);
    try {
      const definition = connectionRef.current.definitions.find((item) => item.id === integrationId);
      const connection = definition ? await prepareIntegrationConnection(definition, workspaceId, connectionRef.current.authContext, services, controller.signal) : undefined;
      const result = await loadTraceSnapshot(services.observability, { connection, workspaceId, documentId, startedAtMs, integrationId,
        manualTraceId, search: "", cursor: null }, controller.signal, (loaded, total) => {
          if (active.current === controller) setProgress({ loaded, total });
        });
      if (active.current !== controller || controller.signal.aborted) return;
      setPage(result); setStatus("ready");
    } catch (cause) {
      if (active.current === controller && !controller.signal.aborted) {
        const code = cause instanceof Error ? cause.message : String(cause);
        setError(errors[code] ?? (cause instanceof Error && cause.name !== "ZodError" ? cause.message : "The trace lookup failed.")); setStatus("error");
      }
    } finally { if (active.current === controller) active.current = null; }
  }, [services, workspaceId, documentId, startedAtMs, integrationId, setPage]);
  const available = connections.traces.some((item) => item.id === integrationId && item.enabled && item.available);
  const loaded = Boolean(page);
  useEffect(() => {
    if (loaded || !available) return;
    const timer = setTimeout(() => void lookup(), 200);
    return () => { clearTimeout(timer); stop(); };
  }, [lookup, stop, available, loaded]);
  useEffect(() => stop, [stop]);
  const summary = useMemo(() => {
    if (!page?.traceId) return null;
    let start = Infinity, end = 0, depth = 0;
    for (const span of page.spans) { start = Math.min(start, span.startedAtUs); end = Math.max(end, span.startedAtUs + span.durationUs); }
    for (const row of page.rows) depth = Math.max(depth, row.depth + 1);
    return { start: page.timing?.startedAtUs ?? (Number.isFinite(start) ? start : startedAtMs * 1000), duration: page.timing?.durationUs ?? Math.max(0, end - start), services: new Set(page.spans.map((span) => span.service)).size, depth };
  }, [page, startedAtMs]);
  const source = connections.traces.find((item) => item.id === integrationId);
  const definition = connections.definitions.find((item) => item.id === integrationId);
  const provider = definition ? extensions.integration(definition.provider) : undefined;
  const openInBrowser = async () => {
    if (!definition || !provider || !page?.traceId) return;
    try { await services.workspaceShell.openExternalUrl(integrationTraceUrl(definition, provider, page.traceId, connections.authContext.variables)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open this trace in the browser."); }
  };
  return <section aria-label="Trace lookup" className="flex h-full min-h-0 flex-col font-ui text-ui-md text-content-primary">
    <header className="shrink-0 space-y-ui-2 border-b border-border-subtle p-ui-3">
      <div className="flex flex-wrap items-center gap-ui-3">
        <div className="min-w-0 flex-1"><p className="m-ui-0 font-medium">Trace for this execution</p><p className="m-ui-0 text-ui-sm text-content-tertiary">{source?.name}</p></div>
        <Input aria-label="Trace ID" placeholder="Trace ID (optional)" value={traceId} maxLength={32} spellCheck={false}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void lookup(traceId.trim() || null); } }}
          onChange={(event) => setTraceId(event.target.value)} className="ui-focus-ring h-control-md w-auto rounded-ui-md font-code text-ui-md" />
        {status === "loading" ? <Button variant="ghost" onClick={() => { stop(); setStatus("cancelled"); }}>Cancel</Button>
          : <Button variant="brand" disabled={!available} onClick={() => void lookup(traceId.trim() || null)}>Load trace</Button>}
        {provider?.traceUrl ? <Button variant="ghost" disabled={!page?.traceId} onClick={() => void openInBrowser()}><ExternalLink className="size-ui-4" />Open in browser</Button> : null}
        <Button size="icon" variant="ghost" aria-label="Find in trace" onClick={onOpenFind}><Search className="size-ui-4" /></Button>
      </div>
      {page ? <CorrelationSummary value={page.correlation} /> : null}
      {summary ? <dl aria-label="Trace statistics" className="m-ui-0 flex flex-wrap gap-x-ui-4 gap-y-ui-1 text-ui-sm">
        <Statistic label="Trace Start" value={formatTraceStart(summary.start)} />
        <Statistic label="Duration" value={traceDuration(summary.duration)} /><Statistic label="Services" value={summary.services} /><Statistic label="Depth" value={summary.depth} /><Statistic label="Total Spans" value={page!.total} />
      </dl> : null}
    </header>
    {status === "loading" ? <p role="status" className="px-ui-3 text-content-tertiary">{progress ? `Loading spans… ${progress.loaded} / ${progress.total}` : "Finding this execution’s trace…"}</p> : null}
    {status === "cancelled" ? <p role="status" className="px-ui-3 text-content-secondary">Trace lookup cancelled.</p> : null}
    {error ? <p role="alert" className="px-ui-3 text-accent-red">{error}</p> : null}
    {!available ? <p className="p-ui-3 text-content-secondary">This request’s tracing provider is unavailable or disabled.</p> : null}
    {page?.traceId ? <TraceHierarchy key={`${prefix}:${page.traceId}`} stateKey={`${prefix}:${page.traceId}`} spans={page.spans} rows={page.rows} startedAtUs={page.timing?.startedAtUs} durationUs={page.timing?.durationUs}
      findQuery={findQuery} findMatchIndex={findMatchIndex} onFindMatchCount={onFindMatchCount} /> : null}
    {page && !page.traceId && status !== "loading" ? <p className="p-ui-3">No trace was found. The service may not have recorded it yet; try loading it again.</p> : null}
  </section>;
}
function Statistic({ label, value }: { label: string; value: string | number }) {
  return <div className="flex gap-ui-1"><dt className="text-content-tertiary">{label}</dt><dd className="m-ui-0 font-medium">{value}</dd></div>;
}

function formatTraceStart(startedAtUs: number) {
  const date = new Date(startedAtUs / 1000);
  return `${date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}
