import type { ReactNode } from "react";
import { X, Info, CircleCheck, TriangleAlert, CircleAlert } from "lucide-react";
import { Button } from "./button";
import { cn } from "../../lib/cn";

/** Reusable dismissible notification; errors rise and fade, notices slide from the right. */
export function Notification({ title, children, actions, variant = "info", onClose }: {
  title: string; children?: ReactNode; actions?: ReactNode; variant?: "info" | "success" | "warning" | "error"; onClose: () => void;
}) {
  const Icon = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert }[variant];
  return <section role={variant === "error" ? "alert" : "status"} aria-live={variant === "error" ? "assertive" : "polite"}
    className={cn("ui-notification pointer-events-auto rounded-ui-lg border border-border bg-purr-overlay p-ui-4 font-ui text-ui-sm text-content-secondary shadow-popover", variant === "error" && "ui-notification-error")}>
    <div className="flex items-center justify-between gap-ui-3">
      <Icon aria-hidden="true" className={cn("size-ui-4 shrink-0", variant === "error" ? "text-accent-red" : variant === "success" ? "text-accent-emerald" : variant === "warning" ? "text-accent-orange" : "text-action-brand")} />
      <h2 className={cn("min-w-0 flex-1 break-words font-medium text-content-primary", variant === "error" && "text-accent-red")}>{title}</h2>
      <Button variant="ghost" size="icon" className="size-ui-5" aria-label={`Dismiss ${title}`} onClick={onClose}><X className="size-ui-4" /></Button>
    </div>
    {children && <div className="mt-ui-1 space-y-ui-2 break-words">{children}</div>}
    {actions && <div className="mt-ui-2 flex flex-wrap items-center gap-ui-2">{actions}</div>}
  </section>;
}
