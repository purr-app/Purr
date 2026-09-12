import { cn } from "../../lib/cn";

export function Switch({ checked, onCheckedChange, label, disabled = false, className }: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
    className={cn("ui-focus-ring flex h-control-xs w-control-lg shrink-0 items-center rounded-ui-lg border p-ui-0 transition-colors duration-ui-fast disabled:cursor-not-allowed disabled:opacity-ui-disabled",
      checked ? "justify-end border-action-brand bg-action-brand" : "justify-start border-border bg-purr-muted", className)}
    onClick={() => onCheckedChange(!checked)}>
    <span className="size-ui-4 rounded-full bg-content-primary shadow-button" aria-hidden="true" />
  </button>;
}
