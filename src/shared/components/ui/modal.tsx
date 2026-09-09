import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "./button";
import { cn } from "../../lib/cn";

export function Modal({ title, children, onClose, className }: {
  title: string; children: ReactNode; onClose: () => void; className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    requestAnimationFrame(() => {
      dialog.querySelector<HTMLElement>("[autofocus], input:not([disabled]), [role='combobox'], [role='option'], button:not([aria-label='Close dialog']):not([disabled])")?.focus({ preventScroll: true });
    });
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  return (
    <dialog ref={ref} aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) {
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      } }}
      className={cn("ui-modal m-auto w-ui-dialog max-w-full overflow-hidden rounded-ui-xl border border-border bg-purr-overlay p-ui-0 font-ui text-content-primary shadow-popover", className)}>
      <div className="flex items-center justify-between border-b border-border px-ui-5 py-ui-3">
        <h2 className="text-ui-lg font-medium">{title}</h2>
        <Button variant="ghost" size="icon" aria-label="Close dialog" onClick={onClose}><X className="size-ui-4" /></Button>
      </div>
      {children}
    </dialog>
  );
}
