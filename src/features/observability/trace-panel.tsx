import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceIntegrations } from "../../integrations/workspace-integrations";
import { prepareIntegrationConnection } from "../../integrations/prepare-connection";
import { useApplicationServices } from "../../app/application-services-context";
import { useTabState } from "../../shared/state/tab-state";
import type { TracePage } from "../../domain/observability";
import { Button } from "../../shared/components/ui/button";
import { Input } from "../../shared/components/ui/input";
import { TraceHierarchy } from "./trace-hierarchy";
import { CorrelationSummary } from "./correlation-summary";

const errors: Record<string, string> = {
  unavailable: "This integration is unavailable in this build.", disabled: "This integration is disabled.",
  invalid_config: "Review this integration’s settings.", credential_unavailable: "The integration credential is missing or outside its permitted scope.",
  response_pending: "This response has not been saved yet. Retry after saving completes.",
  invalid_query: "This execution does not contain a valid trace ID.",
  invalid_cursor: "The trace changed. Reload it to continue.", limit_exceeded: "This trace exceeds the supported size. Try a smaller trace or open it in your provider.",
  busy: "Too many trace lookups are running. Try again shortly.", storage_unavailable: "The saved integration or response cannot be read.",
  provider_failed: "The trace provider could not complete this lookup.",
};

export function TracePanel({ workspaceId, documentId, startedAtMs, integrationId }: {
  workspaceId: string; documentId: string; startedAtMs: number; integrationId: string;
}) {
  const services = useApplicationServices();
  const connections = useWorkspaceIntegrations();
  const connectionRef = useRef(connections); connectionRef.current = connections;
  const prefix = `trace.${startedAtMs}.${integrationId}`;
  const [search, setSearch] = useTabState(`${prefix}.search`, "");
  const [snapshot, setSnapshot] = useTabState<{ search: string; page: TracePage } | null>(`${prefix}.page`, null);
  const page = snapshot?.search === search ? snapshot.page : null;
  const [error, setError] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "cancelled" | "error">("idle");
  const active = useRef<AbortController | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const stop = useCallback(() => { active.current?.abort(); active.current = null; }, []);
  const lookup = useCallback(async (cursor: string | null = null) => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setStatus("loading"); setError("");
    try {
      const definition = connectionRef.current.definitions.find((item) => item.id === integrationId);
      const connection = definition ? await prepareIntegrationConnection(definition, workspaceId, connectionRef.current.authContext, services, controller.signal) : undefined;
      const result = await services.observability.trace({ connection, workspaceId, documentId, startedAtMs, integrationId,
        manualTraceId: null, search, cursor }, controller.signal);
      if (active.current !== controller || controller.signal.aborted) return;
      setSnapshot((previous) => ({ search, page: cursor && previous?.search === search && previous.page.traceId === result.traceId
        ? { ...result, spans: [...previous.page.spans, ...result.spans], rows: [...previous.page.rows, ...result.rows] } : result }));
      setStatus("ready");
    } catch (cause) {
      if (active.current === controller && !controller.signal.aborted) {
        setError(errors[String(cause)] ?? (cause instanceof Error && cause.name !== "ZodError" ? cause.message : "The trace lookup failed.")); setStatus("error");
      }
    } finally { if (active.current === controller) active.current = null; }
  }, [services, workspaceId, documentId, startedAtMs, integrationId, search, setSnapshot]);
  const available = connections.traces.some((item) => item.id === integrationId && item.enabled && item.available);
  const loaded = Boolean(page);
  useEffect(() => {
    if (loaded || !available) return;
    const timer = setTimeout(() => void lookup(), 200);
    return () => { clearTimeout(timer); stop(); };
  }, [lookup, stop, available, loaded]);
  useEffect(() => stop, [stop]);
  useEffect(() => {
    const find = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault(); event.stopPropagation(); searchRef.current?.focus(); searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", find, true);
    return () => window.removeEventListener("keydown", find, true);
  }, []);
  const source = connections.traces.find((item) => item.id === integrationId);
  return <section aria-label="Trace lookup" className="flex h-full min-h-0 flex-col font-ui text-ui-md text-content-primary">
    <div className="flex shrink-0 flex-wrap items-center gap-ui-3 border-b border-border-subtle p-ui-3">
      <div className="min-w-0 flex-1"><p className="m-ui-0 font-medium">Trace for this execution</p>
        <p className="m-ui-0 text-ui-sm text-content-tertiary">{source?.name} · {new Date(startedAtMs).toLocaleTimeString()}{page ? ` · ${page.total} spans` : ""}</p></div>
      <Input ref={searchRef} aria-label="Search trace spans" placeholder="Search spans and attributes" value={search} maxLength={128}
        onKeyDown={(event) => { if (event.key === "Escape") { stop(); setSearch(""); searchRef.current?.blur(); } }}
        onChange={(event) => { stop(); setStatus("idle"); setError(""); setSearch(event.target.value); }} className="h-control-md w-auto rounded-ui-md text-ui-md" />
      {status === "loading" ? <Button variant="brand" onClick={() => { stop(); setStatus("cancelled"); }}>Cancel</Button>
        : <Button variant="brand" disabled={!available} onClick={() => { stop(); void lookup(); }}>Load trace</Button>}
    </div>
    {page ? <CorrelationSummary value={page.correlation} /> : null}
    {status === "loading" && !page ? <p role="status" className="px-ui-3 text-content-tertiary">Finding this execution’s trace…</p> : null}
    {status === "cancelled" ? <p role="status" className="px-ui-3 text-content-secondary">Trace lookup cancelled.</p> : null}
    {error ? <p role="alert" className="px-ui-3 text-accent-red">{error}</p> : null}
    {!available ? <p className="p-ui-3 text-content-secondary">This request’s tracing provider is unavailable or disabled.</p> : null}
    {page?.traceId ? <TraceHierarchy key={`${prefix}:${search}:${page.traceId}`} stateKey={`${prefix}:${search}:${page.traceId}`} spans={page.spans} rows={page.rows} startedAtUs={page.timing?.startedAtUs} durationUs={page.timing?.durationUs}
      hasMore={Boolean(page.nextCursor)} loading={status === "loading"} onLoadMore={status === "error" || status === "cancelled" ? undefined : () => void lookup(page.nextCursor)} /> : null}
    {page && !page.traceId && status !== "loading" ? <p className="p-ui-3">No trace was found. The service may not have recorded it yet; try loading it again.</p> : null}
    {page?.nextCursor ? <div className="flex shrink-0 items-center justify-between gap-ui-3 border-t border-border-subtle px-ui-3 py-ui-2"><span role="status" className="text-ui-sm text-content-tertiary">{page.rows.length} of {page.total} spans loaded{status === "loading" ? " · Loading more…" : ""}</span><Button size="sm" variant="brand" disabled={status === "loading"} onClick={() => void lookup(page.nextCursor)}>Load more spans</Button></div> : null}
  </section>;
}
