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

  useHotkeys("esc", () => setOpen(false), { enabled: open, enableOnFormTags: true, preventDefault: true }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "focus-ring flex h-10 shrink-0 items-center rounded-md border border-transparent bg-surface-strong px-3 font-mono text-body-sm font-semibold hover:bg-surface-hover",
            getHttpMethodStyle(value).text,
            className,
          )}
          type="button"
          aria-label="Choose HTTP method (Command Shift M)"
        >
          {value}
        </button>
      </PopoverTrigger>

      <PopoverContent
          className="z-50 w-36 rounded-md border border-border-strong bg-surface-raised p-1 shadow-[0_14px_32px_rgba(0,0,0,0.36)]"
          side="bottom"
          align="start"
          sideOffset={10}
        >
          <div role="menu" aria-label="HTTP methods" className="space-y-1">
            {httpMethodDefinitions.map((method) => {
              const isSelected = method.value === value;
              const methodStyle = getHttpMethodStyle(method.value);

              return (
                <button
                  key={method.value}
                  className={cn(
                    "focus-ring flex h-7 w-full items-center justify-between rounded px-1.5 text-left transition-colors",
                    isSelected ? "bg-surface-hover" : "hover:bg-surface-strong",
                  )}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isSelected}
                  onClick={() => selectMethod(method.value)}
                >
                  <span
                    className={cn("min-w-14 rounded px-1 py-1 text-center font-mono text-sm  leading-none", methodStyle.badge)}
                    title={method.title}
                  >
                    {method.value}
                  </span>
                  <span className="font-mono text-[10px] font-normal text-muted-foreground" aria-hidden="true">
                    {getHttpMethodShortcut(method.value).keys[0]}
                  </span>
                </button>
              );
            })}
          </div>

          {onCustomMethod ? (
            <button
              className="focus-ring mt-1 flex h-7 w-full items-center gap-2 rounded border-t border-border px-1.5 pt-1 text-[10px] text-muted-foreground hover:text-foreground"
              type="button"
              onClick={onCustomMethod}
            >
              <ListFilter className="size-3.5" aria-hidden="true" />
              Custom HTTP method
            </button>
          ) : null}
      </PopoverContent>
    </Popover>
  );
}
