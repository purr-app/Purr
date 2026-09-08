import { Check, X } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "../../lib/cn";
import { Input } from "./input";
import { Popover, PopoverAnchor, PopoverContent } from "./popover";

export function AutocompleteInput({
  value,
  onValueChange,
  options,
  label,
  placeholder,
  icon,
  className,
  inputClassName,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly string[];
  label: string;
  placeholder?: string;
  icon?: ReactNode;
  className?: string;
  inputClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusFrame = useRef<number | undefined>(undefined);
  const listboxId = useId();
  useEffect(
    () => () => {
      if (focusFrame.current !== undefined)
        cancelAnimationFrame(focusFrame.current);
    },
    [],
  );
  const suggestions = useMemo(() => {
    const needle = value.trim().toLowerCase();
    return options
      .filter((option) => option !== value)
      .map((option) => ({
        option,
        rank: !needle
          ? 0
          : option.toLowerCase().startsWith(needle)
            ? 0
            : option.toLowerCase().includes(needle)
              ? 1
              : 2,
      }))
      .filter((entry) => !needle || entry.rank < 2)
      .sort((left, right) => left.rank - right.rank)
      .slice(0, 10)
      .map((entry) => entry.option);
  }, [options, value]);
  const showSuggestions = open && suggestions.length > 0;

  const choose = (option: string) => {
    onValueChange(option);
    setOpen(false);
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!showSuggestions) {
        setOpen(true);
        setActiveIndex(0);
        return;
      }
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex(
        (activeIndex + direction + suggestions.length) % suggestions.length,
      );
    } else if (event.key === "Enter" && showSuggestions) {
      event.preventDefault();
      choose(suggestions[activeIndex] ?? suggestions[0]);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <Popover
      open={showSuggestions}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setOpen(false);
      }}
    >
      <PopoverAnchor asChild>
        <div className={cn("relative min-w-0", className)}>
          {icon ? (
            <span className="pointer-events-none absolute left-ui-2 top-1/2 z-10 flex -translate-y-1/2 text-content-tertiary">
              {icon}
            </span>
          ) : null}
          <Input
            ref={inputRef}
            role="combobox"
            aria-label={label}
            aria-autocomplete="list"
            aria-expanded={showSuggestions}
            aria-controls={listboxId}
            aria-activedescendant={
              showSuggestions ? `${listboxId}-${activeIndex}` : undefined
            }
            value={value}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            className={cn(
              inputClassName,
              icon && "pl-ui-7",
              value && "pr-ui-8",
            )}
            onFocus={() => {
              if (focusFrame.current !== undefined)
                cancelAnimationFrame(focusFrame.current);
              focusFrame.current = requestAnimationFrame(() => {
                if (document.activeElement === inputRef.current) {
                  setOpen(true);
                  setActiveIndex(0);
                }
              });
            }}
            onChange={(event) => {
              onValueChange(event.target.value);
              setOpen(true);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
          {value ? (
            <button
              type="button"
              aria-label={`Clear ${label}`}
              className="ui-focus-ring absolute right-ui-1 top-1/2 z-10 flex size-control-xs -translate-y-1/2 items-center justify-center rounded-ui-sm text-content-tertiary hover:bg-purr-highlight hover:text-content-primary"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                onValueChange("");
                setOpen(true);
                setActiveIndex(0);
                inputRef.current?.focus();
              }}
            >
              <X className="size-ui-3" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        className="ui-popover-match-anchor overflow-hidden rounded-ui-md border border-border-default bg-purr-overlay p-ui-1 shadow-popover"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (inputRef.current?.contains(event.target as Node))
            event.preventDefault();
        }}
      >
        <div id={listboxId} role="listbox" aria-label={`${label} suggestions`}>
          {suggestions.map((option, index) => (
            <button
              key={option}
              id={`${listboxId}-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={cn(
                "ui-focus-ring flex h-control-sm w-full items-center justify-between gap-ui-2 rounded-ui-sm px-ui-2 font-code text-ui-sm text-content-secondary hover:bg-purr-highlight hover:text-content-primary",
                index === activeIndex &&
                  "bg-purr-highlight text-content-primary",
              )}
              onPointerDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(option)}
            >
              <span className="truncate">{option}</span>
              {option === value ? (
                <Check
                  className="size-ui-3 shrink-0 text-action-brand"
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
