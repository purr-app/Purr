import { Check } from "lucide-react";
import { useRef } from "react";
import { Button } from "./button";
import { cn } from "../../lib/cn";

export function SegmentedTabs<Value extends string>({
  value,
  options,
  onValueChange,
  label,
  id,
  panelId,
}: {
  value: Value;
  options: readonly { value: Value; label: string }[];
  onValueChange: (value: Value) => void;
  label: string;
  id: string;
  panelId: string;
}) {
  const refs = useRef(new Map<Value, HTMLButtonElement>());
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex min-w-0 max-w-full gap-ui-1 overflow-x-auto rounded-ui-md bg-purr-surface p-ui-1"
    >
      {options.map((option, index) => (
        <Button
          key={option.value}
          id={`${id}-${option.value}`}
          role="tab"
          type="button"
          variant="ghost"
          size="sm"
          weight="normal"
          ref={(node) => {
            if (node) refs.current.set(option.value, node);
            else refs.current.delete(option.value);
          }}
          aria-selected={value === option.value}
          aria-controls={panelId}
          tabIndex={value === option.value ? 0 : -1}
          className={cn(
            "gap-ui-1",
            value === option.value
              ? "bg-purr-highlight text-action-brand"
              : "text-content-tertiary",
          )}
          onClick={() => onValueChange(option.value)}
          onKeyDown={(event) => {
            let next = index;
            if (event.key === "ArrowRight") next = (index + 1) % options.length;
            else if (event.key === "ArrowLeft")
              next = (index + options.length - 1) % options.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = options.length - 1;
            else return;
            event.preventDefault();
            refs.current.get(options[next].value)?.focus();
            onValueChange(options[next].value);
          }}
        >
          {option.label}
          {value === option.value ? (
            <Check className="size-ui-3" aria-hidden="true" />
          ) : null}
        </Button>
      ))}
    </div>
  );
}
