import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Notification } from "./notification";

export type ToastOptions = {
  id?: string; title: string; description?: ReactNode; actions?: ReactNode;
  variant?: "info" | "success" | "warning" | "error"; duration?: number; onClose?: () => void;
};
type Toast = ToastOptions & { id: string };
const Context = createContext<{ notify: (toast: ToastOptions) => string; dismiss: (id: string) => void } | null>(null);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const notify = useCallback((toast: ToastOptions) => {
    const id = toast.id ?? crypto.randomUUID();
    setItems((current) => current.some((item) => item.id === id)
      ? current.map((item) => item.id === id ? { ...toast, id } : item) : [...current, { ...toast, id }]);
    return id;
  }, []);
  const dismiss = useCallback((id: string) => setItems((current) => current.filter((item) => item.id !== id)), []);
  return <Context.Provider value={{ notify, dismiss }}>{children}
    <div aria-label="Notifications" className="ui-notification-stack pointer-events-none fixed bottom-ui-4 right-ui-4 z-50 flex max-h-full flex-col gap-ui-3 overflow-y-auto">
      {items.slice(0, 3).map((toast) => <ToastCard key={toast.id} toast={toast} dismiss={dismiss} />)}
    </div>
  </Context.Provider>;
}
function ToastCard({ toast, dismiss }: { toast: Toast; dismiss: (id: string) => void }) {
  const duration = toast.duration ?? (["warning", "error"].includes(toast.variant ?? "info") ? 0 : 5000);
  const remaining = useRef(duration);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const close = useCallback(() => { dismiss(toast.id); toast.onClose?.(); }, [dismiss, toast.id, toast.onClose]);
  useEffect(() => { remaining.current = duration; }, [duration, toast.title, toast.description]);
  useEffect(() => {
    if (!duration || hovered || focused) return;
    const started = Date.now();
    const timer = window.setTimeout(close, remaining.current);
    return () => { window.clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (Date.now() - started)); };
  }, [close, duration, hovered, focused, toast.title, toast.description]);
  return <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <Notification title={toast.title} variant={toast.variant} actions={toast.actions} onClose={close}>{toast.description}</Notification>
  </div>;
}
export function useToasts() {
  const context = useContext(Context);
  if (!context) throw new Error("ToastProvider is required");
  return context;
}
