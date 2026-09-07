import { Check, ChevronDown } from "lucide-react";
import { useId, useRef, useState } from "react";

import { cn } from "../../lib/cn";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

export type SelectFieldOption<Value extends string> = {
  value: Value;
  label: string;
};

type SelectFieldProps<Value extends string> = {
  value: Value;
  options: readonly SelectFieldOption<Value>[];
  onValueChange: (value: Value) => void;
  label: string;
  className?: string;
  muted?: boolean;
};

export function SelectField<Value extends string>({
  value,
  options,
  onValueChange,
  label,
  className,
  muted = false,
}: SelectFieldProps<Value>) {
  const [open, setOpen] = useState(false);
  const listboxId = useId();
  const optionRefs = useRef(new Map<Value, HTMLButtonElement>());
  const selected =
    options.find((option) => option.value === value) ?? options[0];

  const focusOption = (nextValue: Value) =>
    requestAnimationFrame(() => optionRefs.current.get(nextValue)?.focus());
  const moveSelection = (direction: -1 | 1) => {
    const currentIndex = Math.max(
      0,
      options.findIndex((option) => option.value === value),
    );
    const next =
      options[(currentIndex + direction + options.length) % options.length];
    setOpen(true);
    focusOption(next.value);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={listboxId}
          className={cn(
            "ui-focus-ring flex h-control-sm min-w-0 items-center justify-between gap-ui-1 rounded-ui-sm bg-purr-elevated px-ui-2 font-ui text-ui-sm text-content-secondary transition-colors duration-ui-fast hover:bg-purr-highlight hover:text-content-primary",
            muted && "opacity-ui-inactive",
            className,
          )}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              moveSelection(event.key === "ArrowDown" ? 1 : -1);
            }
          }}
        >
          <span className="truncate">{selected.label}</span>
          <ChevronDown
            className={cn(
              "size-ui-3 shrink-0 transition-transform duration-ui-fast",
              open && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="ui-popover-match-anchor z-50 overflow-hidden rounded-ui-md border border-border-default bg-purr-overlay p-ui-1 shadow-popover"
        side="bottom"
        align="start"
        sideOffset={4}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusOption(value);
        }}
      >
        <div id={listboxId} role="listbox" aria-label={label}>
          {options.map((option) => (
            <button
              key={option.value}
              ref={(node) => {
                if (node) optionRefs.current.set(option.value, node);
                else optionRefs.current.delete(option.value);
              }}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={cn(
                "ui-focus-ring flex h-control-sm w-full items-center justify-between rounded-ui-sm px-ui-2 font-ui text-ui-sm text-content-secondary transition-colors duration-ui-fast hover:bg-purr-highlight hover:text-content-primary",
                option.value === value &&
                  "bg-purr-highlight text-content-primary",
              )}
              onClick={() => {
                onValueChange(option.value);
                setOpen(false);
              }}
              onKeyDown={(event) => {
                const index = options.findIndex(
                  (entry) => entry.value === option.value,
                );
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const direction = event.key === "ArrowDown" ? 1 : -1;
                  focusOption(
                    options[
                      (index + direction + options.length) % options.length
                    ].value,
                  );
                }
                if (event.key === "Home" || event.key === "End") {
                  event.preventDefault();
                  focusOption(
                    options[event.key === "Home" ? 0 : options.length - 1]
                      .value,
                  );
                }
              }}
            >
              <span>{option.label}</span>
              {option.value === value ? (
                <Check
                  className="size-ui-3 text-action-brand"
                  aria-hidden="true"
                />
              ) : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
