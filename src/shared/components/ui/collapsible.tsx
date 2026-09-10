import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

export function Collapsible({
  open,
  orientation = "vertical",
  children,
  className,
}: {
  open: boolean;
  orientation?: "vertical" | "horizontal";
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-open={open ? "true" : "false"}
      data-orientation={orientation}
      aria-hidden={!open}
      inert={!open}
      className={cn("ui-collapsible motion-reduce:transition-none", className)}
    >
      <div className="ui-collapsible-content">{children}</div>
    </div>
  );
}
