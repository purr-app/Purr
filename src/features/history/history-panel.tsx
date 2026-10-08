import { Check, History, Pin, PinOff, Search, Settings2, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useApplicationServices } from "../../app/application-services-context";
import type { HistoryPage, HistorySummary } from "../../application/ports/history";
import { Button } from "../../shared/components/ui/button";
import { Input } from "../../shared/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../shared/components/ui/popover";
import { cn } from "../../shared/lib/cn";
import { getHttpMethodStyle, type HttpMethod } from "../../shared/model/http-method";
import { formatPayloadSize } from "../request-workbench/model/request-body";
import { groupHistoryByDay, historyStatus, historyStatusClass } from "./history-presentation";
import { dynamicExecutionLabel } from "./dynamic-execution-badge";

export type HistoryPanelProps = {
  workspaceId: string;
  documentId?: string;
  selectedId?: string;
  selectedStartedAt?: number;
  onOpen: (id: string) => void;
  compact?: boolean;
};

type Confirmation = { kind: "entry"; entry: HistorySummary } | { kind: "clear" } | { kind: "retention"; days: number };
const noopSubscribe = () => () => {};
const emptySnapshot = () => 0;

export function HistoryPanel(props: HistoryPanelProps) {
  return <HistoryPanelContent key={`${props.workspaceId}/${props.documentId ?? "all"}`} {...props} />;
}

function HistoryPanelContent({ workspaceId, documentId, selectedId, selectedStartedAt, onOpen, compact = false }: HistoryPanelProps) {
  const history = useApplicationServices().persistence.history;
  const revision = useSyncExternalStore(history?.subscribe ?? noopSubscribe, history?.getSnapshot ?? emptySnapshot);
  const [items, setItems] = useState<HistorySummary[]>([]);
  const [cursor, setCursor] = useState<HistoryPage["cursor"]>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [retention, setRetention] = useState(30);
  const [retentionInput, setRetentionInput] = useState("30");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const isSelected = (item: HistorySummary) => selectedId ? item.id === selectedId : selectedStartedAt === item.startedAt;
  const pages = useRef(1);
  const generation = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => { pages.current = 1; setSearch(query.trim()); }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!history) { setLoading(false); return; }
    let active = true;
    void history.settings(workspaceId).then(({ retentionDays }) => {
      if (active) { setRetention(retentionDays); setRetentionInput(String(retentionDays)); }
    }).catch((cause: unknown) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [history, workspaceId]);

  useEffect(() => {
    const request = ++generation.current;
    if (!history) return;
    setLoading(true);
    setError("");
    void (async () => {
      let next: HistoryPage["cursor"] = null;
      const loaded: HistorySummary[] = [];
      for (let page = 0; page < pages.current; page++) {
        const result = await history.list(workspaceId, { documentId, search, limit: 50, cursor: next ?? undefined });
        loaded.push(...result.items);
        next = result.cursor;
        if (!next || request !== generation.current) break;
      }
      if (request === generation.current) { setItems(loaded); setCursor(next); }
    })().catch((cause: unknown) => {
      if (request === generation.current) setError(String(cause));
    }).finally(() => { if (request === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [history, workspaceId, documentId, search, revision, refresh]);

  const mutate = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try { await action(); setConfirmation(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }, []);

  const confirm = () => {
    if (!history || !confirmation) return;
    if (confirmation.kind === "entry") void mutate(() => history.remove(workspaceId, { id: confirmation.entry.id }));
    else if (confirmation.kind === "clear") void mutate(() => history.remove(workspaceId, { documentId }));
    else {
      const days = confirmation.days;
      void mutate(async () => {
        await history.settings(workspaceId, days);
        setRetention(days);
        setSettingsOpen(false);
      });
    }
  };

  const updateRetention = () => {
    const days = Number(retentionInput);
    if (!Number.isInteger(days) || days < 1 || days > 36500) {
      setError("Enter a whole number of days between 1 and 36500.");
      return;
    }
    if (days < retention) setConfirmation({ kind: "retention", days });
    else if (history) void mutate(async () => {
      await history.settings(workspaceId, days);
      setRetention(days);
      setSettingsOpen(false);
    });
  };

  return <section aria-label={documentId ? "Document request history" : "Workspace request history"}
    className={cn("flex min-h-0 min-w-0 flex-col font-ui", compact ? "max-h-ui-palette bg-purr-surface" : "h-full")}>
    <div className="flex items-center justify-between gap-ui-2 px-ui-3 py-ui-2">
      <h2 className="truncate text-ui-sm font-medium text-content-primary">History</h2>
      <div className="flex shrink-0 items-center gap-ui-1">
        {!compact && <Button variant="ghost" size="icon" title="History retention" aria-label="History retention" aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}><Settings2 className="size-ui-3-5" /></Button>}
        <Button variant="ghost" size="icon" title={documentId ? "Clear document history" : "Clear workspace history"}
          aria-label={documentId ? "Clear document history" : "Clear workspace history"} disabled={busy || !history}
          onClick={() => setConfirmation({ kind: "clear" })}><Trash2 className="size-ui-3-5" /></Button>
      </div>
    </div>
    {!compact && <div className="relative px-ui-2 pb-ui-2">
      <Search aria-hidden="true" className="pointer-events-none absolute left-ui-4 top-ui-2 size-ui-3-5 text-content-tertiary" />
      <Input aria-label="Search request history" placeholder="URL, name, method, status…" title="Search request name, URL, HTTP method, status code or outcome (error/cancelled). Request and response bodies are not searched." value={query} onChange={(event) => setQuery(event.target.value)}
        className="ui-focus-ring h-control-sm pl-ui-7 text-ui-sm" />
    </div>}
    {settingsOpen && <form className="space-y-ui-2 border-y border-border-subtle p-ui-3 text-ui-sm" onSubmit={(event) => { event.preventDefault(); updateRetention(); }}>
      <label className="block text-content-secondary" htmlFor="history-retention-days">Keep history for (days)</label>
      <div className="flex gap-ui-2">
        <Input id="history-retention-days" type="number" min={1} max={36500} step={1} value={retentionInput}
          onChange={(event) => setRetentionInput(event.target.value)} className="ui-focus-ring h-control-sm" />
        <Button type="submit" variant="secondary" size="sm" disabled={busy}>Save</Button>
      </div>
      <p className="text-ui-xs text-content-tertiary">Applies to this workspace. Pinned entries are kept until you delete them.</p>
    </form>}
    {confirmation && <div role="alertdialog" aria-label="Confirm history change" className="space-y-ui-2 border-y border-border-subtle p-ui-3 text-ui-sm">
      <p className="text-content-secondary">{confirmation.kind === "entry" ? "Delete this execution and its response? This cannot be undone."
        : confirmation.kind === "clear" ? `Delete all ${documentId ? "executions for this document" : "workspace history"}, including pinned entries? This cannot be undone.`
          : `Delete unpinned entries older than ${confirmation.days} days? This cannot be undone.`}</p>
      <div className="flex gap-ui-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={confirm}>{confirmation.kind === "retention" ? "Apply retention" : "Delete"}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</Button>
      </div>
    </div>}
    {error && <div role="alert" className="px-ui-3 py-ui-2 text-ui-sm text-status-server-error">
      {error}<Button variant="ghost" size="xs" onClick={() => setRefresh((value) => value + 1)}>Retry</Button>
    </div>}
    <div className="ui-subtle-scrollbar min-h-0 flex-1 overflow-y-auto px-ui-2 pb-ui-2" aria-busy={loading}>
      {!history ? <p className="p-ui-3 text-ui-sm text-content-tertiary">History is unavailable in this host.</p>
        : items.length === 0 && !loading && !error ? <p className="p-ui-3 text-ui-sm text-content-tertiary">{search ? "No matching requests." : "No requests yet. Sent requests appear here."}</p> : null}
      {groupHistoryByDay(items).map((group) => <section key={group.key} aria-label={group.label}>
        <h3 className={cn("sticky top-0 z-10 px-ui-2 py-ui-2 text-ui-xs font-medium text-content-tertiary", compact ? "bg-purr-surface" : "bg-purr-base")}>{group.label}</h3>
        <ul className="space-y-ui-1">
          {group.items.map((item) => <li key={item.id} className={cn("group relative flex min-w-0 items-center rounded-ui-md hover:bg-purr-elevated", isSelected(item) && "bg-purr-highlight")}>
            <button type="button" className="ui-focus-ring flex h-control-sm min-w-0 flex-1 items-center gap-ui-2 rounded-ui-md px-ui-2 text-left font-code text-ui-xs" aria-current={isSelected(item) ? "true" : undefined}
              title={`${item.name || item.url}\n${item.method} ${item.url}\n${new Date(item.startedAt).toLocaleString()} · ${historyStatus(item)} · ${Math.round(item.durationMs)} ms${item.outcome === "response" ? ` · ${formatPayloadSize(item.size)}` : ""}${item.pinned ? "\nPinned" : ""}`} onClick={() => onOpen(item.id)}>
              {compact ? <>
                <span className="w-ui-3 shrink-0">{isSelected(item) && <Check className="size-ui-3 text-content-secondary" aria-label="Selected execution" />}</span>
                <span className={cn("shrink-0", historyStatusClass(item))}>{historyStatus(item)}</span>
                <span className="truncate text-content-tertiary">{Math.round(item.durationMs)} ms{item.outcome === "response" && ` · ${formatPayloadSize(item.size)}`}</span>
              </> : <>
                <span className={cn("w-ui-8 shrink-0 text-ui-2xs", item.kind === "graphql" ? "text-action-graphql" : getHttpMethodStyle(item.method as HttpMethod).text)}>{item.kind === "graphql" ? "GQL" : item.method}</span>
                <span className="min-w-0 flex-1 truncate text-content-primary">{item.url || item.name || "Untitled request"}</span>
                <span className="sr-only">{historyStatus(item)}</span>
              </>}
              {item.dynamicExecution && <span title={dynamicExecutionLabel(item.dynamicExecution)} className="shrink-0">
                <Zap className={cn("size-ui-3", item.dynamicExecution.extraction?.status === "error" ? "text-accent-orange" : "text-content-tertiary")}
                  aria-label={dynamicExecutionLabel(item.dynamicExecution)} />
              </span>}
              {item.pinned && <Pin className="size-ui-3 shrink-0 text-action-brand" aria-label="Pinned execution" />}
              <time className="ml-auto w-ui-16 shrink-0 text-right text-ui-2xs tabular-nums text-content-tertiary group-hover:opacity-0 group-focus-within:opacity-0" dateTime={new Date(item.startedAt).toISOString()}>
                {new Date(item.startedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
              </time>
            </button>
            <div className="pointer-events-none absolute right-ui-1 flex items-center opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
              <Button variant="ghost" size="icon" className={cn("size-ui-6", item.pinned && "text-action-brand")}
                title={item.pinned ? "Unpin execution" : "Pin execution to keep it"} aria-label={item.pinned ? "Unpin execution" : "Pin execution"} aria-pressed={item.pinned} disabled={busy || !history}
                onClick={() => { if (history) void mutate(() => history.pin(workspaceId, item.id, !item.pinned)); }}>
                {item.pinned ? <PinOff className="size-ui-3" /> : <Pin className="size-ui-3" />}
              </Button>
              <Button variant="ghost" size="icon" className="size-ui-6" title="Delete execution" aria-label="Delete execution" disabled={busy}
                onClick={() => setConfirmation({ kind: "entry", entry: item })}><Trash2 className="size-ui-3" /></Button>
            </div>
          </li>)}
        </ul>
      </section>)}
      {loading && <p role="status" className="px-ui-2 py-ui-3 text-ui-xs text-content-tertiary">Loading history…</p>}
      {cursor && <Button variant="ghost" size="sm" className="mt-ui-2 w-full" disabled={loading} onClick={() => { pages.current++; setRefresh((value) => value + 1); }}>Load more requests</Button>}
    </div>
  </section>;
}

export function HistoryPopover({ historicalStartedAt, onReturnCurrent, ...props }: HistoryPanelProps & { historicalStartedAt?: number; onReturnCurrent?: () => void }) {
  const [open, setOpen] = useState(false);
  const historicalDate = historicalStartedAt !== undefined && Number.isFinite(historicalStartedAt) ? new Date(historicalStartedAt) : null;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button variant="ghost" size="icon" aria-label="Show response history" aria-pressed={Boolean(props.selectedId)}
      className={cn(historicalDate && "h-control-sm w-auto gap-ui-1 bg-action-brand-surface px-ui-2 text-action-brand")}
      title={historicalDate ? `Historical response · ${historicalDate.toLocaleString()}` : "Show response history"}>
      <History className="size-ui-3-5 shrink-0" />
      {historicalDate && <time dateTime={historicalDate.toISOString()} aria-label="Historical response date" className="whitespace-nowrap font-code text-ui-2xs">
        {historicalDate.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
      </time>}
    </Button></PopoverTrigger>
    <PopoverContent align="end" side="bottom" sideOffset={4} className="w-ui-history-popover overflow-hidden rounded-ui-lg border border-border bg-purr-surface shadow-popover">
      {onReturnCurrent && <div className="border-b border-border-subtle p-ui-1"><Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => { onReturnCurrent(); setOpen(false); }}>Return to current</Button></div>}
      <HistoryPanel {...props} compact onOpen={(id) => { props.onOpen(id); setOpen(false); }} />
    </PopoverContent>
  </Popover>;
}
