import { lazy, Suspense, useRef, useState, type ComponentType } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpen, Megaphone, Bug, MessageSquarePlus, GitFork, House, RefreshCw, Ellipsis, ExternalLink, Puzzle, ArrowUpCircle } from "lucide-react";
import { useApplicationServices } from "../../../app/application-services-context";
import { useExtensionRegistry } from "../../../extension-api/extension-context";
import type { ExtensionMenuContribution } from "../../../extension-api/contracts";
import type { OwnedContribution } from "../../../extension-api/registry";
import { Button } from "../../../shared/components/ui/button";
import { Modal } from "../../../shared/components/ui/modal";
import { Popover, PopoverTrigger, PopoverContent } from "../../../shared/components/ui/popover";
import { useToasts } from "../../../shared/components/ui/toasts";
import { useUpdates } from "../../updates/update-context";

const DevPreviews = import.meta.env?.DEV ? lazy(() => import("./ui-previews")) : null;
const links = [
  ["Documentation", "https://usepurr.com/docs/", BookOpen],
  ["What’s new", "https://usepurr.com/changelog/", Megaphone],
  ["Report a bug", "https://github.com/purr-app/Purr/issues", Bug],
  ["Feedback / Request a feature", "https://github.com/purr-app/Purr/discussions", MessageSquarePlus],
  ["GitHub", "https://github.com/purr-app/Purr", GitFork],
  ["Homepage", "https://usepurr.com/", House],
] as const;
const itemClass = "w-full justify-start text-left font-normal";
export function ApplicationMenu() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string[]>([]);
  const running = useRef(new Set<string>());
  const [dialog, setDialog] = useState<{ title: string; component: ComponentType<{ onClose(): void }> } | null>(null);
  const { workspaceShell } = useApplicationServices();
  const registry = useExtensionRegistry();
  const navigate = useNavigate();
  const { notify } = useToasts();
  const { version, state, controller } = useUpdates();
  const available = ["available", "downloading", "downloaded", "installing", "installed"].includes(state.phase);
  const external = async (url: string) => {
    setOpen(false);
    try { await workspaceShell.openExternalUrl(url); }
    catch { notify({ title: "Could not open link", description: "Try opening the link again.", variant: "error" }); }
  };
  const run = async (item: OwnedContribution<ExtensionMenuContribution>) => {
    const id = `${item.moduleId}.${item.id}`;
    if (running.current.has(id)) return;
    setOpen(false);
    if (item.action.type === "link") { await external(item.action.url); return; }
    running.current.add(id); setPending([...running.current]);
    try {
      await item.action.run({
        notify: (message) => { notify(message); },
        openDialog: setDialog,
        openPage: (pageId) => {
          const page = registry.pages.find((page) => page.moduleId === item.moduleId && page.id === pageId);
          if (!page) throw new Error("Unknown extension page");
          navigate(page.fullPath);
        },
      });
    } catch { notify({ title: "Extension action failed", description: `${item.label} could not be completed. Try again.`, variant: "error" }); }
    finally { running.current.delete(id); setPending([...running.current]); }
  };
  const versionClick = () => {
    setOpen(false);
    if (state.phase === "disabled") notify({ title: "Automatic updates unavailable", description: "Automatic updates are not configured for this build." });
    else if (available) controller.present();
    else void controller.check();
  };
  const DialogContent = dialog?.component;
  return <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button variant="ghost" size="icon" className="relative size-ui-8" aria-label="More" title="More" aria-haspopup="menu" aria-expanded={open}>
        <Ellipsis className="size-ui-5" />
        {available && <span aria-label="Update available" className="absolute right-ui-1 top-ui-1 size-ui-1-5 rounded-full bg-action-brand" />}
      </Button></PopoverTrigger>
      <PopoverContent side="right" align="end" role="menu" aria-label="Application menu"
        className="ml-ui-2 overflow-y-auto w-ui-application-menu rounded-ui-lg border border-border bg-purr-overlay p-ui-1 shadow-popover"
        style={{ maxHeight: "var(--radix-popover-content-available-height)" }}
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          event.preventDefault(); items[next]?.focus();
        }}>
        {links.map(([label, url, Icon]) => <Button key={label} role="menuitem" variant="ghost" className={itemClass} onClick={() => { void external(url); }}>
          <Icon className="size-ui-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{label}</span><ExternalLink className="size-ui-3 shrink-0 text-content-tertiary" />
        </Button>)}
        {registry.menuItems.length > 0 && <div role="group" aria-label="Extension actions" className="mt-ui-1 border-t border-border-subtle pt-ui-1">
          {registry.menuItems.map((item) => { const Icon = item.icon ?? Puzzle; const id = `${item.moduleId}.${item.id}`; return <Button key={id} role="menuitem" variant="ghost" className={itemClass} disabled={pending.includes(id)} onClick={() => { void run(item); }}>
            <Icon className="size-ui-4 shrink-0" /><span className="min-w-0 flex-1 truncate" title={item.label}>{item.label}</span>{item.action.type === "link" && <ExternalLink className="size-ui-3 shrink-0" />}
          </Button>; })}
        </div>}
        <div className="mt-ui-1 border-t border-border-subtle pt-ui-1">
          <Button role="menuitem" variant="ghost" className={itemClass} disabled={state.phase === "checking"} onClick={versionClick}>
            <RefreshCw className={`size-ui-4 shrink-0 ${state.phase === "checking" ? "animate-spin" : ""}`} /><span className="flex-1">Version <span className="font-code">v{version}</span></span>
            {available && <ArrowUpCircle aria-label="Update available" className="size-ui-4 text-action-brand" />}
          </Button>
        </div>
        {DevPreviews && <Suspense fallback={null}><DevPreviews /></Suspense>}
      </PopoverContent>
    </Popover>
    {dialog && DialogContent && <Modal title={dialog.title} onClose={() => setDialog(null)}><div className="p-ui-4"><DialogContent onClose={() => setDialog(null)} /></div></Modal>}
  </>;
}
