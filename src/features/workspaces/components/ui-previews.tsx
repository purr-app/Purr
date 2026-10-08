import { useState } from "react";
import { FlaskConical } from "lucide-react";
import { Progress } from "../../../shared/components/ui/progress";
import { Button } from "../../../shared/components/ui/button";
import { useToasts, type ToastOptions } from "../../../shared/components/ui/toasts";
export default function UiPreviews() {
  const [open, setOpen] = useState(false);
  const { notify, dismiss } = useToasts();
  const previewIds = ["info", "success", "warning", "error", "long message", "retry", "update", ...Array.from({ length: 5 }, (_, i) => `queued ${i + 1}`)];
  const show = (toast: ToastOptions) => { notify({ ...toast, id: toast.id ?? `preview-${toast.title.replace("Preview: ", "")}` }); };
  return <div className="mt-ui-1 border-t border-border-subtle pt-ui-1">
    <Button role="menuitem" variant="ghost" className="w-full justify-start" aria-expanded={open} onClick={() => setOpen(!open)}><FlaskConical className="size-ui-4" />UI previews</Button>
    {open && <div role="group" aria-label="UI previews">
      {(["info", "success", "warning", "error"] as const).map((variant) => <Button role="menuitem" key={variant} variant="ghost" className="w-full justify-start" onClick={() => show({ title: `Preview: ${variant}`, description: "This is an isolated UI preview.", variant })}>{variant} toast</Button>)}
      <Button role="menuitem" variant="ghost" onClick={() => show({ title: "Preview: long message", description: "A detailed notification should wrap without hiding its actions. ".repeat(12) })}>Long text</Button>
      <Button role="menuitem" variant="ghost" onClick={() => show({ id: "preview-retry", title: "Preview: retry", variant: "error", actions: <Button variant="brand" size="sm" onClick={() => show({ id: "preview-retry", title: "Preview: recovered", variant: "success" })}>Retry</Button> })}>Retry action</Button>
      <Button role="menuitem" variant="ghost" onClick={() => { for (let n = 1; n <= 5; n++) show({ title: `Preview: queued ${n}` }); }}>Toast queue</Button>
      {["Update available", "Downloading", "Ready to restart"].map((title) => <Button key={title} role="menuitem" variant="ghost" className="w-full justify-start" onClick={() => show({ id: "preview-update", title: `Preview: ${title}`, duration: 0, description: title === "Downloading" ? <Progress label="Preview download progress" value={45} /> : "Demonstration only. No update will be installed.", actions: <Button variant="brand" size="sm" onClick={() => dismiss("preview-update")}>Close preview</Button> })}>{title}</Button>)}
      <Button role="menuitem" variant="ghost" onClick={() => { previewIds.forEach((id) => dismiss(`preview-${id}`)); }}>Clear previews</Button>
    </div>}
  </div>;
}
