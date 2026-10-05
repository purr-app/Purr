import { Check, Circle, History, LoaderCircle, RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "../../../shared/components/ui/button";
import type { DynamicExecutionStep } from "../services/dynamic-variable-resolver";

const labels: Record<DynamicExecutionStep["state"], string> = {
  pending: "Dependency", running: "Running", resolved: "Resolved", cached: "Cached",
  failed: "Failed", blocked: "Not sent", cycle: "Cycle",
};

/** The indentation represents 'requires'; children execute before their parent. */
export function DynamicDependencyChain({ steps, onOpenHistory, onOpenVariable, onOpenRequest, rootName, failed = false }: {
  steps: readonly DynamicExecutionStep[];
  onOpenHistory?: (id: string) => void;
  onOpenVariable?: (id: string) => void;
  onOpenRequest?: (id: string) => void;
  rootName?: string;
  failed?: boolean;
}) {
  const render = (parentId?: string) => steps.filter((step) => step.parentId === parentId).map((step) => {
    const Icon = step.state === "running" ? LoaderCircle : step.state === "resolved" ? Check : step.state === "cached" ? RotateCcw
      : ["failed", "blocked", "cycle"].includes(step.state) ? TriangleAlert : Circle;
    return <li key={step.id} className="min-w-0 space-y-ui-1">
      <div className="rounded-ui-md bg-purr-elevated px-ui-2 py-ui-2">
        <div className="flex min-w-0 items-center gap-ui-2 text-ui-sm">
          <Icon aria-hidden="true" className={`size-ui-3-5 shrink-0 ${step.state === "running" ? "animate-spin text-action-brand" : step.error ? "text-accent-red" : "text-content-tertiary"}`} />
          <Button size="sm" variant="ghost" className="h-auto min-w-0 justify-start truncate p-ui-0" disabled={!step.historyEntryId && !onOpenRequest}
            title={step.name} onClick={() => step.historyEntryId && onOpenHistory ? onOpenHistory(step.historyEntryId) : onOpenRequest?.(step.documentId)}>{step.name}</Button>
          <span className="ml-auto shrink-0 text-ui-xs text-content-tertiary">{step.status !== undefined ? `HTTP ${step.status} · ` : ""}{labels[step.state]}</span>
          {step.historyEntryId && onOpenHistory ? <Button size="icon" variant="ghost" aria-label={`Open execution of ${step.name}`} onClick={() => onOpenHistory(step.historyEntryId!)}><History className="size-ui-3-5" /></Button> : null}
        </div>
        <div className="mt-ui-1 flex flex-wrap items-center gap-ui-1 text-ui-xs text-content-tertiary">
          Provides <Button variant="ghost" size="sm" className="h-auto p-ui-0 font-code italic text-accent-orange" disabled={!onOpenVariable} onClick={() => onOpenVariable?.(step.variableId)}>{`{{${step.variableName}}}`}</Button>
          <span>using <code className="font-code">{step.expression || (step.language === "jq" ? "." : "$")}</code></span>
        </div>
        {step.error ? <p className="mb-ui-0 mt-ui-1 break-words text-ui-xs text-accent-red">{step.error.startsWith("Dynamic variable dependency cycle:") ? "Circular dependency: this request is already required earlier in the chain." : step.error}</p> : null}
      </div>
      {steps.some((item) => item.parentId === step.id) ? <div className="ml-ui-3 border-l border-border pl-ui-3"><p className="mb-ui-1 mt-ui-1 text-ui-xs text-content-tertiary">Requires</p><ol className="m-ui-0 list-none space-y-ui-1 p-ui-0">{render(step.id)}</ol></div> : null}
    </li>;
  });
  return <section aria-label="Dynamic request dependencies" className="space-y-ui-2 rounded-ui-lg border border-border-subtle bg-purr-codefield p-ui-3">
    <div className="flex items-center gap-ui-2"><h3 className="m-ui-0 text-ui-sm font-medium text-content-primary">{rootName ? `${rootName} · Dependencies` : "Dependencies"}</h3>{failed && rootName ? <span className="ml-auto text-ui-xs text-content-tertiary">Not sent</span> : null}</div>
    <p className="m-ui-0 text-ui-xs text-content-tertiary">Nested requests run first. Cached values do not send a request.</p>
    <ol className="m-ui-0 list-none space-y-ui-2 p-ui-0">{render()}</ol>
    {!steps.length ? <p className="m-ui-0 text-ui-xs text-content-tertiary">No dependencies.</p> : null}
  </section>;
}
