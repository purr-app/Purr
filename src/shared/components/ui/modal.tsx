import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "./button";
import { PopoverPortalProvider } from "./popover";
import { cn } from "../../lib/cn";

export function Modal({ title, children, onClose, className, initialFocus = "first-field" }: {
  title: string; children: ReactNode; onClose: () => void; className?: string;
  initialFocus?: "first-field" | "dialog";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLDialogElement | null>(null);
  const setDialogRef = useCallback((node: HTMLDialogElement | null) => {
    ref.current = node;
    setPortalContainer(node);
  }, []);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    requestAnimationFrame(() => {
      if (initialFocus === "dialog") dialog.focus({ preventScroll: true });
      else dialog.querySelector<HTMLElement>("[autofocus], input:not([disabled]), textarea:not([disabled]), [contenteditable='true']")?.focus({ preventScroll: true });
    });
    return () => { dialog.close(); previous?.focus(); };
  }, [initialFocus]);
  return (
    <dialog ref={setDialogRef} tabIndex={-1} aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) {
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      } }}
      className={cn("ui-modal m-auto w-ui-dialog max-w-full overflow-visible rounded-ui-xl border border-border bg-purr-overlay p-ui-0 font-ui text-content-primary shadow-popover outline-none", className)}>
      <PopoverPortalProvider container={portalContainer}>
        <div className="flex items-center justify-between border-b border-border px-ui-5 py-ui-3">
          <h2 className="text-ui-lg font-medium">{title}</h2>
          <Button variant="ghost" size="icon" aria-label="Close dialog" onClick={onClose}><X className="size-ui-4" /></Button>
        </div>
        {children}
      </PopoverPortalProvider>
    </dialog>
  );
}
