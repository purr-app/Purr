import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "./button";
import { cn } from "../../lib/cn";

/** Reusable dismissible notification; errors rise and fade, notices slide from the right. */
export function Notification({ title, children, actions, variant = "info", onClose }: {
  title: string; children?: ReactNode; actions?: ReactNode; variant?: "info" | "error"; onClose: () => void;
}) {
  return <section role={variant === "error" ? "alert" : "status"} aria-live={variant === "error" ? "assertive" : "polite"}
    className={cn("ui-notification pointer-events-auto rounded-ui-lg border border-border bg-purr-overlay p-ui-4 font-ui text-ui-sm text-content-secondary shadow-popover", variant === "error" && "ui-notification-error")}>
    <div className="flex items-start justify-between gap-ui-3">
      <h2 className={cn("font-medium text-content-primary", variant === "error" && "text-accent-red")}>{title}</h2>
      <Button variant="ghost" size="icon" aria-label={`Dismiss ${title}`} onClick={onClose}><X className="size-ui-4" /></Button>
    </div>
    {children && <div className="mt-ui-2 space-y-ui-2">{children}</div>}
    {actions && <div className="mt-ui-4 flex flex-wrap items-center gap-ui-2">{actions}</div>}
  </section>;
}
