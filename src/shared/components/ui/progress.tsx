import { cn } from "../../lib/cn";

/** Compact brand progress; an omitted value denotes indeterminate progress. */
export function Progress({ label, value, max = 100 }: { label: string; value?: number; max?: number }) {
  const total = Number.isFinite(max) && max > 0 ? max : 100;
  const current = value !== undefined && Number.isFinite(value) ? Math.min(total, Math.max(0, value)) : undefined;
  return <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={current}
    className="h-ui-1 w-full overflow-hidden rounded-full bg-purr-highlight">
    <div className={cn("h-full rounded-full bg-action-brand", current === undefined && "ui-progress-indeterminate")}
      style={{ width: current === undefined ? "33%" : `${current / total * 100}%` }} />
  </div>;
}
