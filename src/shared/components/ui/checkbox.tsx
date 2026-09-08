import { Check } from "lucide-react";
import { cn } from "../../lib/cn";

export function Checkbox({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  className,
  hideLabel = false,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
  hideLabel?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "ui-focus-ring inline-flex items-center gap-ui-2 rounded-ui-md text-ui-sm text-content-secondary hover:text-content-primary disabled:cursor-not-allowed disabled:opacity-ui-disabled",
        className,
      )}
    >
      <span
        className={cn(
          "flex size-control-xs shrink-0 items-center justify-center rounded-ui-md border",
          checked
            ? "border-action-brand bg-action-brand text-content-primary"
            : "border-border bg-purr-surface text-transparent",
        )}
      >
        <Check className="size-ui-3-5" aria-hidden="true" />
      </span>
      <span className={hideLabel ? "sr-only" : undefined}>{label}</span>
    </button>
  );
}
