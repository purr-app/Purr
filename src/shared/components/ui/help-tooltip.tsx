import { CircleHelp } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "./button";
import { Popover, PopoverAnchor, PopoverContent } from "./popover";

/** Supplementary help available to pointer, keyboard and touch users. */
export function HelpTooltip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const focused = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const show = () => { clearTimeout(closeTimer.current); setOpen(true); };
  const closeAfterHover = () => {
    clearTimeout(closeTimer.current);
    if (!focused.current) closeTimer.current = setTimeout(() => setOpen(false), 200);
  };
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverAnchor asChild>
      <Button type="button" variant="ghost" size="icon" aria-label={label} aria-describedby={open ? id : undefined}
        onPointerEnter={show} onPointerLeave={closeAfterHover}
        onFocus={() => { focused.current = true; show(); }} onBlur={() => { focused.current = false; closeAfterHover(); }} onClick={show}>
        <CircleHelp aria-hidden="true" className="size-ui-4" />
      </Button>
    </PopoverAnchor>
    <PopoverContent id={id} role="tooltip" align="start"
      onOpenAutoFocus={(event) => event.preventDefault()} onCloseAutoFocus={(event) => event.preventDefault()}
      onPointerEnter={show} onPointerLeave={closeAfterHover}
      className="max-w-validation-popover rounded-ui-lg border border-border-default bg-purr-elevated p-ui-3 font-ui text-ui-sm font-normal text-content-secondary shadow-panel">
      {children}
    </PopoverContent>
  </Popover>;
}
