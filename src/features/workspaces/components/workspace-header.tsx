import { useState, useSyncExternalStore } from "react";
import { Braces, Check, ChevronDown, ChevronRight, Cookie as CookieIcon, Globe2, Layers, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings2 } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { Button } from "../../../shared/components/ui/button";
import { KbdGroup } from "../../../shared/components/ui/kbd";
import { keyboardShortcuts } from "../../../shared/config/keyboard-shortcuts";
import { Popover, PopoverContent, PopoverTrigger } from "../../../shared/components/ui/popover";
import { cn } from "../../../shared/lib/cn";
import { RequestTabBar } from "../../request-workbench/components/request-tab-bar";
import { getDocumentDisplayName, type Workspace, type WorkspaceStore } from "../model/workspace";
import type { SessionCookieJar } from "../../request-workbench/model/cookie-jar";

const menuClass = "mt-ui-2 min-w-ui-workspace-menu rounded-ui-lg border border-border bg-purr-overlay p-ui-1 shadow-popover";
const rowClass = "w-full justify-start font-normal";

export function WorkspaceHeader({ store, workspace, cookieJar, cookiesActive, settingsActive, variablesActive, onCookies, onVariables, onWorkspace, onNewWorkspace, onRequestSettings, onEnvironment, onEditEnvironment, onNewEnvironment, onToggleSidebar, onPalette, onView }: {
  store: WorkspaceStore; workspace: Workspace;
  cookieJar: SessionCookieJar;
  cookiesActive: boolean;
  settingsActive: boolean;
  variablesActive: boolean;
  onCookies: () => void;
  onVariables: () => void;
  onWorkspace: (id: string) => void; onNewWorkspace: () => void; onRequestSettings: () => void;
  onEnvironment: (id: string | null) => void; onEditEnvironment: () => void; onNewEnvironment: () => void;
  onToggleSidebar: () => void; onPalette: () => void; onView: (view: Workspace["ui"]["view"]) => void;
}) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  useSyncExternalStore(cookieJar.subscribe, cookieJar.getVersion);
  const cookieCount = cookieJar.list().length;
  const environment = workspace.environments.find((item) => item.id === workspace.activeEnvironmentId);
  const document = workspace.documents.find((item) => item.id === workspace.ui.activeDocumentId);
  const nativeMac = isTauri() && /mac/i.test(navigator.platform);
  return <header data-tauri-drag-region className="ui-workspace-header grid h-ui-titlebar shrink-0 items-center gap-ui-2 border-b border-border-subtle bg-purr-surface px-ui-2">
    <div className={cn("flex min-w-0 items-center gap-ui-1", nativeMac && "pl-ui-traffic-lights")}>
      <Button variant="ghost" size="icon" aria-label={workspace.ui.sidebarOpen ? "Hide sidebar" : "Show sidebar"} title="Toggle sidebar · Mod+B" onClick={onToggleSidebar}>
        {workspace.ui.sidebarOpen ? <PanelLeftClose className="size-ui-3-5" /> : <PanelLeftOpen className="size-ui-3-5" />}
      </Button>
      <Popover open={workspaceOpen} onOpenChange={setWorkspaceOpen}>
        <PopoverTrigger asChild><Button variant="ghost" size="sm" className="min-w-0 shrink" aria-label="Select workspace"><Layers className="size-ui-3-5 shrink-0 text-action-brand" /><span className="truncate">{workspace.name}</span><ChevronDown className="size-ui-3 shrink-0" /></Button></PopoverTrigger>
        <PopoverContent align="start" className={menuClass} aria-label="Workspaces">
          <Button variant="ghost" className={rowClass} onClick={() => { setWorkspaceOpen(false); onNewWorkspace(); }}><Plus className="size-ui-4" />New workspace</Button>
          <div className="my-ui-1 max-h-ui-variable-list overflow-y-auto border-y border-border-subtle py-ui-1">
            {store.workspaces.map((item) => <Button key={item.id} variant="ghost" className={rowClass} aria-pressed={item.id === workspace.id} onClick={() => { onWorkspace(item.id); setWorkspaceOpen(false); }}>
              <Check className={cn("size-ui-4 text-action-brand", item.id !== workspace.id && "invisible")} /><span className="max-w-ui-document-tab truncate">{item.name}</span>
            </Button>)}
          </div>
          <Button variant="ghost" className={rowClass} onClick={() => { setWorkspaceOpen(false); onRequestSettings(); }}><Settings2 className="size-ui-4" />Workspace settings</Button>
        </PopoverContent>
      </Popover>
      <ChevronRight className="size-ui-3 shrink-0 text-content-quaternary" />
      <Popover open={environmentOpen} onOpenChange={setEnvironmentOpen}>
        <PopoverTrigger asChild><Button variant="ghost" size="sm" className="min-w-0 shrink" aria-label="Select environment"><Globe2 className={cn("size-ui-3-5 shrink-0", environment ? "text-action-brand" : "text-content-tertiary")} /><span className="truncate">{environment?.name ?? "No environment"}</span></Button></PopoverTrigger>
        <PopoverContent align="start" className={menuClass} aria-label="Environments">
          <Button variant="ghost" className={rowClass} aria-pressed={!environment} onClick={() => { onEnvironment(null); setEnvironmentOpen(false); }}><Check className={cn("size-ui-4 text-action-brand", environment && "invisible")} />No environment</Button>
          <div className="max-h-ui-variable-list overflow-y-auto">
            {workspace.environments.map((item) => <Button key={item.id} variant="ghost" className={rowClass} aria-pressed={item.id === environment?.id} onClick={() => { onEnvironment(item.id); setEnvironmentOpen(false); }}><Check className={cn("size-ui-4 text-action-brand", item.id !== environment?.id && "invisible")} /><span className="max-w-ui-document-tab truncate">{item.name}</span></Button>)}
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
