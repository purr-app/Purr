import { useUpdates } from "../../updates/update-context";
import { useState, useSyncExternalStore } from "react";
import { Braces, Check, ChevronDown, ChevronRight, Cookie as CookieIcon, FileInput, FilePlus2, Globe2, Layers, Plus, Search, Settings2 } from "lucide-react";
import { Button } from "../../../shared/components/ui/button";
import { KbdGroup } from "../../../shared/components/ui/kbd";
import { keyboardShortcuts } from "../../../shared/config/keyboard-shortcuts";
import { Popover, PopoverContent, PopoverTrigger } from "../../../shared/components/ui/popover";
import { cn } from "../../../shared/lib/cn";
import { RequestTabBar } from "../../request-workbench/components/request-tab-bar";
import { getDocumentDisplayName, type Workspace, type WorkspaceStore } from "../model/workspace";
import type { SessionCookieJar } from "../../request-workbench/model/cookie-jar";

const menuClass = "ui-workspace-menu mt-ui-2 rounded-ui-lg border border-border bg-purr-overlay p-ui-1 shadow-popover";
const rowClass = "w-full justify-start font-normal";

export function WorkspaceHeader({ store, workspace, cookieJar, cookiesActive, settingsActive, variablesActive, onCookies, onVariables, onWorkspace, onNewWorkspace, onImportWorkspace, onRequestSettings, onEnvironment, onEditEnvironment, onNewEnvironment, onPalette, onView }: {
  store: WorkspaceStore; workspace: Workspace;
  cookieJar: SessionCookieJar;
  cookiesActive: boolean;
  settingsActive: boolean;
  variablesActive: boolean;
  onCookies: () => void;
  onVariables: () => void;
  onWorkspace: (id: string) => void; onNewWorkspace: () => void; onImportWorkspace: () => void; onRequestSettings: () => void;
  onEnvironment: (id: string | null) => void; onEditEnvironment: () => void; onNewEnvironment: () => void;
  onPalette: () => void; onView: (view: Workspace["ui"]["view"]) => void;
}) {
  const updates = useUpdates();
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [newWorkspaceOptionsOpen, setNewWorkspaceOptionsOpen] = useState(false);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const closeWorkspaceMenu = () => { setWorkspaceOpen(false); setNewWorkspaceOptionsOpen(false); };
  useSyncExternalStore(cookieJar.subscribe, cookieJar.getVersion);
  const cookieCount = cookieJar.list().length;
  const environment = workspace.environments.find((item) => item.id === workspace.activeEnvironmentId);
  const document = workspace.documents.find((item) => item.id === workspace.ui.activeDocumentId);
  return <header data-tauri-drag-region className="ui-workspace-header grid h-ui-titlebar shrink-0 items-center gap-ui-2 bg-purr-base px-ui-2">
    <div className="ui-workspace-controls grid min-w-0 items-center gap-ui-1 pl-ui-traffic-lights">
      <Popover open={workspaceOpen} onOpenChange={(open) => { setWorkspaceOpen(open); if (!open) setNewWorkspaceOptionsOpen(false); }}>
        <PopoverTrigger asChild><Button variant="ghost" size="sm" className="min-w-0 w-full justify-start" title={workspace.name} aria-label="Select workspace"><Layers className="size-ui-3-5 shrink-0 text-action-brand" /><span className="truncate">{workspace.name}</span><ChevronDown className="size-ui-3 shrink-0" /></Button></PopoverTrigger>
        <PopoverContent align="start" className={menuClass} aria-label="Workspaces" onOpenAutoFocus={(event) => event.preventDefault()}>
          <Popover open={newWorkspaceOptionsOpen} onOpenChange={setNewWorkspaceOptionsOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" className={rowClass} aria-haspopup="menu" onClick={(event) => { event.preventDefault(); setNewWorkspaceOptionsOpen(true); }} onPointerEnter={() => setNewWorkspaceOptionsOpen(true)}><Plus className="size-ui-4" />New workspace<ChevronRight className="ml-auto size-ui-3" /></Button>
            </PopoverTrigger>
            <PopoverContent side="right" align="start" collisionPadding={8} sideOffset={0} role="menu" aria-label="New workspace options" onOpenAutoFocus={(event) => event.preventDefault()} onPointerLeave={() => setNewWorkspaceOptionsOpen(false)} className="w-ui-workspace-menu rounded-ui-lg border border-border bg-purr-overlay p-ui-1 shadow-popover">
              <Button role="menuitem" variant="ghost" className={rowClass} onClick={() => { closeWorkspaceMenu(); onNewWorkspace(); }}><FilePlus2 className="size-ui-4" />New empty</Button>
              <Button role="menuitem" variant="ghost" className={rowClass} onClick={() => { closeWorkspaceMenu(); onImportWorkspace(); }}><FileInput className="size-ui-4" />Import</Button>
            </PopoverContent>
          </Popover>
          <div onPointerEnter={() => setNewWorkspaceOptionsOpen(false)} className="my-ui-1 max-h-ui-variable-list overflow-y-auto border-y border-border-subtle py-ui-1">
            {store.workspaces.map((item) => <Button key={item.id} variant="ghost" className={cn(rowClass, "h-auto min-h-control-lg whitespace-normal text-left")} aria-pressed={item.id === workspace.id} onClick={() => { onWorkspace(item.id); closeWorkspaceMenu(); }}>
              <Check className={cn("size-ui-4 shrink-0 text-action-brand", item.id !== workspace.id && "invisible")} /><span className="min-w-0 break-words">{item.name}</span>
            </Button>)}
          </div>
          <Button variant="ghost" className={rowClass} onClick={() => { closeWorkspaceMenu(); updates.leaveTab(); onRequestSettings(); }}><Settings2 className="size-ui-4" />Workspace settings</Button>
        </PopoverContent>
      </Popover>
      <ChevronRight className="size-ui-3 shrink-0 text-content-quaternary" />
      <Popover open={environmentOpen} onOpenChange={setEnvironmentOpen}>
        <PopoverTrigger asChild><Button variant="ghost" size="sm" className="min-w-0 w-full justify-start" title={environment?.name ?? "No environment"} aria-label="Select environment"><Globe2 className={cn("size-ui-3-5 shrink-0", environment ? "text-action-brand" : "text-content-tertiary")} /><span className="truncate">{environment?.name ?? "No environment"}</span></Button></PopoverTrigger>
        <PopoverContent align="start" className={menuClass} aria-label="Environments">
          <Button variant="ghost" className={cn(rowClass, "h-auto min-h-control-lg whitespace-normal text-left")} aria-pressed={!environment} onClick={() => { onEnvironment(null); setEnvironmentOpen(false); }}><Check className={cn("size-ui-4 shrink-0 text-action-brand", environment && "invisible")} />No environment</Button>
          <div className="max-h-ui-variable-list overflow-y-auto">
            {workspace.environments.map((item) => <Button key={item.id} variant="ghost" className={cn(rowClass, "h-auto min-h-control-lg whitespace-normal text-left")} aria-pressed={item.id === environment?.id} onClick={() => { onEnvironment(item.id); setEnvironmentOpen(false); }}><Check className={cn("size-ui-4 shrink-0 text-action-brand", item.id !== environment?.id && "invisible")} /><span className="min-w-0 break-words">{item.name}</span></Button>)}
          </div>
          <div className="mt-ui-1 border-t border-border-subtle pt-ui-1">
            <Button variant="ghost" className={rowClass} onClick={() => { setEnvironmentOpen(false); onNewEnvironment(); }}><Plus className="size-ui-4" />New environment</Button>
            {environment && <Button variant="ghost" className={rowClass} onClick={() => { setEnvironmentOpen(false); onEditEnvironment(); }}><Settings2 className="size-ui-4" />Edit environment<KbdGroup keys={keyboardShortcuts.editEnvironment.keys} /></Button>}
          </div>
        </PopoverContent>
      </Popover>
      <Button variant="ghost" size="sm" className={cn("font-code", variablesActive && "bg-purr-highlight text-content-primary")} aria-label="Open variables" title="Variables: inspect effective values and dependencies" aria-pressed={variablesActive} onClick={onVariables}>
        <Braces className="size-ui-3-5 text-action-brand" />Variables
      </Button>
      <Button id="request-cookies-button" variant="ghost" size="icon" className={cn(cookiesActive && "bg-purr-highlight text-content-primary")} aria-label={`Cookies ${cookieCount}`} title="Workspace cookies" aria-controls="active-document-panel" aria-pressed={cookiesActive} onClick={onCookies}>
        <CookieIcon className="size-ui-3-5 text-action-brand" />
        {cookieCount > 0 ? <span className="sr-only">{cookieCount} stored</span> : null}
      </Button>
    </div>
    <Button variant="secondary" size="sm" className="min-w-0 justify-between" onClick={onPalette} aria-label="Open command palette" title="Search documents and commands · Mod+K">
      <Search className="size-ui-3-5 shrink-0 text-content-tertiary" /><span className="truncate">{settingsActive ? "Workspace settings" : variablesActive ? "Variables" : cookiesActive ? "Cookies" : document ? getDocumentDisplayName(document) : "Search documents and commands"}</span><KbdGroup keys={["mod", "k"]} />
    </Button>
    <div data-tauri-drag-region className="flex justify-end"><RequestTabBar view={workspace.ui.view} onViewChange={onView} /></div>
  </header>;
}
