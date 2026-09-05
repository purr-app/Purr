import { ListFilter } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import { useState } from "react";

import { keyboardShortcuts } from "../../config/keyboard-shortcuts";
import { cn } from "../../lib/cn";
import { getHttpMethodShortcut, getHttpMethodStyle, httpMethodDefinitions, httpMethodShortcutKeys, type HttpMethod } from "../../model/http-method";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

type HttpMethodPickerProps = {
  value: HttpMethod;
  onValueChange: (method: HttpMethod) => void;
  onCustomMethod?: () => void;
  className?: string;
};

export function HttpMethodPicker({ value, onValueChange, onCustomMethod, className }: HttpMethodPickerProps) {
  const [open, setOpen] = useState(false);

  const selectMethod = (method: HttpMethod) => {
    onValueChange(method);
    setOpen(false);
  };

  useHotkeys(keyboardShortcuts.openMethodSelector.hotkey, () => setOpen(true), { enableOnFormTags: true, preventDefault: true });

  useHotkeys(
    httpMethodShortcutKeys,
    (event) => {
      const method = httpMethodDefinitions.find((item) => getHttpMethodShortcut(item.value).hotkey === event.key.toLowerCase());
      if (method) selectMethod(method.value);
    },
    { enabled: open, enableOnFormTags: true, preventDefault: true },
    [open, onValueChange],
  );

  useHotkeys(
    keyboardShortcuts.dismissPopover.hotkey,
    () => setOpen(false),
    { enabled: open, enableOnFormTags: true, preventDefault: true },
    [open],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "ui-focus-ring flex h-control-lg shrink-0 items-center rounded-ui-md border border-purr-elevated bg-purr-elevated px-ui-3 font-code text-ui-sm font-semibold transition-colors duration-ui-fast hover:bg-purr-highlight",
            getHttpMethodStyle(value).text,
            className,
          )}
          type="button"
          aria-label="Choose HTTP method"
        >
          {value}
        </button>
      </PopoverTrigger>

      <PopoverContent
        className="z-50 mt-ui-2 w-method-popover rounded-ui-md border border-border-default bg-purr-overlay p-ui-1 shadow-popover"
        side="bottom"
        align="start"
      >
        <div role="menu" aria-label="HTTP methods" className="space-y-ui-1-5">
          {httpMethodDefinitions.map((method) => {
            const isSelected = method.value === value;
            const methodStyle = getHttpMethodStyle(method.value);

            return (
              <button
                key={method.value}
                className={cn(
                  "ui-focus-ring flex h-control-sm w-full items-center justify-between rounded-ui-sm px-ui-1-5 text-left transition-colors duration-ui-fast",
                  isSelected ? "bg-purr-highlight" : "hover:bg-purr-elevated",
                )}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                onClick={() => selectMethod(method.value)}
              >
                <span
                  className={cn(
                    "min-w-method-badge rounded-ui-sm px-ui-1 py-ui-1 text-center font-code text-ui-xs font-medium leading-none",
                    methodStyle.badge,
                  )}
                >
                  {method.value}
                </span>
                <span className="font-code text-ui-2xs font-normal text-content-tertiary" aria-hidden="true">
                  {getHttpMethodShortcut(method.value).keys[0]}
                </span>
              </button>
            );
          })}
        </div>

        {onCustomMethod ? (
          <button
            className="ui-focus-ring mt-ui-1 flex h-control-sm w-full items-center gap-ui-2 rounded-ui-sm border-t border-border-subtle px-ui-1-5 pt-ui-1 font-ui text-ui-2xs text-content-tertiary transition-colors duration-ui-fast hover:text-content-primary"
            type="button"
            onClick={onCustomMethod}
          >
            <ListFilter className="size-ui-3-5" aria-hidden="true" />
            Custom HTTP method
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
