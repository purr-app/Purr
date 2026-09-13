import { useEffect, useState, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";

import { Button } from "../../../shared/components/ui/button";
import { Kbd } from "../../../shared/components/ui/kbd";
import { cn } from "../../../shared/lib/cn";

const responseLabels = ["Response", "Headers", "Cookie", "Timeline", "Trace", "Request"] as const;

function ResponseStateShell({ label, children, pending = false }: { label: string; children: ReactNode; pending?: boolean }) {
  return <section aria-label={label} className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-ui-xl bg-purr-surface shadow-panel">
    <div className="flex min-h-control-lg shrink-0 items-center gap-ui-1 bg-purr-elevated p-ui-2" role="tablist" aria-label="Response details">
      {pending ? responseLabels.map((item) => <Button key={item} type="button" role="tab" size="sm" variant="ghost" weight="normal" disabled aria-selected="false">{item}</Button>)
        : <Button type="button" role="tab" size="sm" variant="ghost" weight="normal" className="bg-purr-highlight text-accent-red" aria-selected="true">Error</Button>}
    </div>
    <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
  </section>;
}

export function ErrorResponse({ message }: { message: string }) {
  return <ResponseStateShell label="Request error">
    <div role="tabpanel" className="flex h-full min-h-0 items-start bg-purr-codefield p-ui-4">
      <div role="alert" className="flex min-w-0 items-start gap-ui-2 rounded-ui-lg border border-border-subtle bg-purr-surface p-ui-3">
        <CircleAlert className="mt-ui-1 size-ui-4 shrink-0 text-accent-red" aria-hidden="true" />
        <p className="m-ui-0 whitespace-pre-wrap break-words font-code text-ui-sm text-accent-red">{message}</p>
      </div>
    </div>
  </ResponseStateShell>;
}

export function PendingResponse({ graphql, onCancel }: { graphql: boolean; onCancel: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = performance.now();
    const timer = window.setInterval(() => setElapsed(performance.now() - started), 50);
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", cancel);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("keydown", cancel);
    };
  }, [onCancel]);
  return <ResponseStateShell label="Response pending" pending>
    <div role="status" className="flex h-full min-h-0 items-center justify-center bg-purr-codefield p-ui-6">
      <div className="flex flex-wrap items-center justify-center gap-ui-3 rounded-ui-xl border border-border-subtle bg-purr-surface px-ui-4 py-ui-2 font-code text-ui-sm shadow-button">
        <span data-pending-indicator className={cn("size-ui-2 animate-pulse rounded-full", graphql ? "bg-action-graphql" : "bg-action-emerald")} aria-hidden="true" />
        <span data-pending-message className="text-content-secondary">Waiting for response…</span>
        <span data-response-elapsed className={cn(graphql ? "text-action-graphql" : "text-action-emerald")}>{elapsed.toFixed(1)} ms</span>
        <span aria-hidden="true" className="text-content-quaternary">·</span>
        <span data-pending-hint className="inline-flex items-center gap-ui-1 text-content-tertiary">
          Press <Kbd>Esc</Kbd> to cancel
        </span>
      </div>
    </div>
  </ResponseStateShell>;
}
