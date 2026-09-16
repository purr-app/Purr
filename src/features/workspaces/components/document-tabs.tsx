import { Braces, Cookie as CookieIcon, Save, Settings2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { Button } from "../../../shared/components/ui/button";
import { KbdGroup } from "../../../shared/components/ui/kbd";
import { Popover, PopoverAnchor, PopoverContent } from "../../../shared/components/ui/popover";
import { keyboardShortcuts } from "../../../shared/config/keyboard-shortcuts";
import { cn } from "../../../shared/lib/cn";
import { getDocumentBadge, getDocumentDisplayName, isDocumentDirty, isMeaningfulDraft, type CreatableDocumentKind, type Workspace } from "../model/workspace";
import { NewDocumentButton } from "./new-document-button";

const cookiesTabId = "workspace-cookies-tab";
const settingsTabId = "workspace-settings-tab";
const variablesTabId = "workspace-variables-tab";
type TabGeometry = { id: string; left: number; right: number; width: number };
type TabDrag = {
  id: string;
  pointerId: number;
  originX: number;
  offsetX: number;
  sourceIndex: number;
  targetIndex: number;
  shiftDistance: number;
  activationDistance: number;
  minOffset: number;
  maxOffset: number;
  moved: boolean;
};

export function DocumentTabs({ workspace, cookieCount, extensionTypes = [], onOpen, onClose, onPin, onDuplicate, onCloseOther, onCloseAll, onReorder, onOpenCookies, onCloseCookies, onOpenSettings, onCloseSettings, onOpenVariables, onCloseVariables, onNew, onNewExtension, onSave }: {
  workspace: Workspace;
  cookieCount: number;
  extensionTypes?: readonly { extensionType: string; label: string }[];
  onOpen: (id: string) => void;
  onClose: (id: string) => void;
  onPin: (id: string) => void;
  onDuplicate: (id: string) => void;
  onCloseOther: (id: string) => void;
  onCloseAll: () => void;
  onReorder: (sourceId: string, targetId: string) => void;
  onOpenCookies: () => void;
  onCloseCookies: () => void;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onOpenVariables: () => void;
  onCloseVariables: () => void;
  onNew: (kind: CreatableDocumentKind) => void;
  onNewExtension?: (extensionType: string) => void;
  onSave: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const geometry = useRef<TabGeometry[]>([]);
  const dragState = useRef<TabDrag | null>(null);
  const dropPositions = useRef<Map<string, number> | null>(null);
  const [drag, setDrag] = useState<TabDrag | null>(null);
  const [settling, setSettling] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const activeDocument = workspace.documents.find((item) => item.id === workspace.ui.activeDocumentId);
  const showSave = Boolean(!workspace.ui.cookiesTabActive && !workspace.ui.settingsTabActive && !workspace.ui.variablesTabActive && activeDocument && activeDocument.kind !== "schema" && (!activeDocument.saved || isDocumentDirty(activeDocument)));
  const tabIds = [...workspace.ui.openDocumentIds, ...(workspace.ui.cookiesTabOpen ? [cookiesTabId] : []), ...(workspace.ui.variablesTabOpen ? [variablesTabId] : []), ...(workspace.ui.settingsTabOpen ? [settingsTabId] : [])];
  const openTab = (id: string) => id === cookiesTabId ? onOpenCookies() : id === settingsTabId ? onOpenSettings() : id === variablesTabId ? onOpenVariables() : onOpen(id);
  const onTabKeyDown = (event: KeyboardEvent, id: string) => {
    if (event.altKey && event.shiftKey && workspace.ui.openDocumentIds.includes(id) && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      const index = workspace.ui.openDocumentIds.indexOf(id);
      const target = Math.max(0, Math.min(workspace.ui.openDocumentIds.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
      if (target !== index) onReorder(id, workspace.ui.openDocumentIds[target]);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabIds.length - 1 : (tabIds.indexOf(id) + (event.key === "ArrowRight" ? 1 : -1) + tabIds.length) % tabIds.length;
    openTab(tabIds[next]);
    globalThis.document.getElementById(`document-tab-${tabIds[next]}`)?.focus();
  };
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [workspace.ui.activeDocumentId, workspace.ui.cookiesTabActive, workspace.ui.settingsTabActive, workspace.ui.variablesTabActive]);
  useEffect(() => {
    dragState.current = null;
    dropPositions.current = null;
    setDrag(null);
    setSettling(false);
    setMenuId(null);
  }, [workspace.id]);
  useLayoutEffect(() => {
    const previous = dropPositions.current;
    if (!previous || !list.current) return;
    dropPositions.current = null;
    const rootStyle = getComputedStyle(globalThis.document.documentElement);
    const reducedMotion = globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reducedMotion ? 0 : parseFloat(rootStyle.getPropertyValue("--duration-normal"));
    const easing = rootStyle.getPropertyValue("--easing-standard").trim();
    for (const tab of list.current.querySelectorAll<HTMLElement>("[data-document-id]")) {
      const previousLeft = previous.get(tab.dataset.documentId!);
      if (previousLeft === undefined) continue;
      const deltaX = previousLeft - tab.getBoundingClientRect().left;
      if (deltaX === 0 || duration === 0) continue;
      tab.animate(
        [{ transform: `translateX(${deltaX}px)` }, { transform: "translateX(0)" }],
        { duration, easing },
      );
    }
    setSettling(false);
  }, [workspace.ui.openDocumentIds]);

  const startTabDrag = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0 || !list.current) return;
    const tabs = [...list.current.querySelectorAll<HTMLElement>("[data-document-id]")];
    geometry.current = tabs.map((tab) => {
      const rect = tab.getBoundingClientRect();
      return { id: tab.dataset.documentId!, left: rect.left, right: rect.right, width: rect.width };
    });
    const sourceIndex = geometry.current.findIndex((tab) => tab.id === id);
    if (sourceIndex < 0) return;
    const source = geometry.current[sourceIndex];
    const neighbour = geometry.current[sourceIndex + 1] ?? geometry.current[sourceIndex - 1];
    const gap = neighbour
      ? Math.max(0, sourceIndex < geometry.current.length - 1 ? neighbour.left - source.right : source.left - neighbour.right)
      : 0;
    const bounds = list.current.getBoundingClientRect();
    const rootStyle = getComputedStyle(globalThis.document.documentElement);
    const activationDistance = parseFloat(rootStyle.getPropertyValue("--document-tab-drag-threshold")) * parseFloat(rootStyle.fontSize);
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = { id, pointerId: event.pointerId, originX: event.clientX, offsetX: 0, sourceIndex, targetIndex: sourceIndex,
      shiftDistance: source.width + gap, activationDistance, minOffset: bounds.left - source.left, maxOffset: bounds.right - source.right, moved: false };
    dragState.current = next;
    setDrag(next);
  };

  const moveTab = (event: PointerEvent<HTMLButtonElement>) => {
    const current = dragState.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    const rawOffset = event.clientX - current.originX;
    const moved = current.moved || Math.abs(rawOffset) >= current.activationDistance;
    if (!moved) return;
    const offsetX = Math.max(current.minOffset, Math.min(current.maxOffset, rawOffset));
    const source = geometry.current[current.sourceIndex];
    const draggedLeft = source.left + offsetX;
    const draggedRight = source.right + offsetX;
    let targetIndex = current.sourceIndex;
    if (offsetX > 0) {
      for (let index = current.sourceIndex + 1; index < geometry.current.length; index += 1) {
        const candidate = geometry.current[index];
        const halfOverlap = Math.min(source.width, candidate.width) / 2;
        if (draggedRight >= candidate.left + halfOverlap) targetIndex = index;
      }
    } else if (offsetX < 0) {
      for (let index = current.sourceIndex - 1; index >= 0; index -= 1) {
        const candidate = geometry.current[index];
        const halfOverlap = Math.min(source.width, candidate.width) / 2;
        if (draggedLeft <= candidate.right - halfOverlap) targetIndex = index;
      }
    }
    if (moved && !current.moved) onPin(current.id);
    const next = { ...current, offsetX, targetIndex, moved };
    dragState.current = next;
    setDrag(next);
  };

  const finishTabDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const current = dragState.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.moved && current.targetIndex !== current.sourceIndex && list.current) {
      dropPositions.current = new Map([...list.current.querySelectorAll<HTMLElement>("[data-document-id]")]
        .map((tab) => [tab.dataset.documentId!, tab.getBoundingClientRect().left]));
      setSettling(true);
      onReorder(current.id, geometry.current[current.targetIndex].id);
    }
    dragState.current = null;
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const cancelTabDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    dragState.current = null;
    setDrag(null);
  };

  const tabTranslateX = (id: string, index: number) => {
    if (!drag) return 0;
    if (id === drag.id) return drag.offsetX;
    if (drag.targetIndex > drag.sourceIndex && index > drag.sourceIndex && index <= drag.targetIndex) return -drag.shiftDistance;
    if (drag.targetIndex < drag.sourceIndex && index >= drag.targetIndex && index < drag.sourceIndex) return drag.shiftDistance;
    return 0;
  };
  return <div className="flex h-control-lg min-w-0 shrink-0 items-center gap-ui-1 border-b border-border-subtle bg-purr-base px-ui-2">
    <div ref={list} role="tablist" aria-label="Documents" className="flex min-w-0 items-center gap-ui-1 overflow-x-auto">
      {workspace.ui.openDocumentIds.map((id, index) => {
        const document = workspace.documents.find((item) => item.id === id)!;
        const name = getDocumentDisplayName(document);
        const active = !workspace.ui.cookiesTabActive && !workspace.ui.settingsTabActive && !workspace.ui.variablesTabActive && workspace.ui.activeDocumentId === id;
        const preview = workspace.ui.previewDocumentId === id;
        const dirty = isDocumentDirty(document);
        const translateX = tabTranslateX(id, index);
        const dragging = drag?.id === id && drag.moved;
        return <Popover key={id} open={menuId === id} onOpenChange={(open) => setMenuId(open ? id : null)}>
          <PopoverAnchor asChild><div data-document-id={id}
          className={cn("ui-sortable-tab group flex shrink-0 cursor-grab select-none items-center rounded-ui-md border hover:bg-purr-elevated active:cursor-grabbing",
            active ? "border-border bg-purr-elevated" : "border-transparent",
            dragging && "ui-sortable-tab-dragging relative z-10",
            settling && "ui-sortable-tab-settling")}
          style={{ "--document-tab-translate-x": `${translateX}px` } as CSSProperties}
          onContextMenu={(event) => { event.preventDefault(); setMenuId(id); }}>
          <button type="button" role="tab" aria-selected={active} aria-controls="active-document-panel" id={`document-tab-${id}`} title={name}
            className="ui-focus-ring flex h-control-sm max-w-ui-document-tab touch-none items-center gap-ui-2 rounded-ui-md px-ui-2 text-ui-sm leading-none text-content-secondary hover:text-content-primary"
            onClick={() => { if (!drag?.moved) onOpen(id); }} onDoubleClick={() => onPin(id)} onKeyDown={(event) => onTabKeyDown(event, id)}
            onPointerDown={(event) => startTabDrag(event, id)} onPointerMove={moveTab} onPointerUp={finishTabDrag} onPointerCancel={cancelTabDrag}
            tabIndex={active ? 0 : -1}>
            <span className={cn("ui-document-method inline-flex h-full items-center font-code text-ui-2xs leading-none", getDocumentBadge(document).color)}>{getDocumentBadge(document).label}</span>
            <span className={cn("inline-flex h-full min-w-0 items-center truncate leading-none", preview && "italic")}>{name}</span>
            {!document.saved && !isMeaningfulDraft(document) ? <span className="sr-only">Blank request</span> : null}
          </button>
          <span className="relative mr-ui-1 flex size-ui-5 shrink-0 items-center justify-center">
            {dirty ? <span className="size-ui-1-5 rounded-full bg-action-brand transition-opacity duration-ui-fast group-hover:opacity-ui-hidden group-focus-within:opacity-ui-hidden" title={document.saved ? "Unsaved changes" : "Draft"} /> : null}
            <Button variant="ghost" size="icon" className={cn("absolute inset-0 size-ui-5 opacity-ui-hidden transition-opacity duration-ui-fast group-hover:opacity-ui-visible group-focus-within:opacity-ui-visible", dirty && "group-hover:opacity-ui-visible group-focus-within:opacity-ui-visible")} aria-label={`Close ${name}`} onClick={() => onClose(id)}><X className="size-ui-3" /></Button>
          </span>
          </div></PopoverAnchor>
          <PopoverContent role="menu" aria-label={`Tab actions for ${name}`} align="start" sideOffset={4} className="w-ui-context-menu rounded-ui-lg border border-border bg-purr-overlay p-ui-1 shadow-popover" onOpenAutoFocus={(event) => event.preventDefault()}>
            <Button role="menuitem" variant="ghost" size="sm" className="w-full justify-start gap-ui-1 font-normal" onClick={() => { setMenuId(null); onNew(workspace.ui.lastRequestKind); }}><span className="flex-1 text-left">New request</span><span aria-hidden="true"><KbdGroup plain keys={keyboardShortcuts.newDocument.keys} /></span></Button>
            <Button role="menuitem" variant="ghost" size="sm" className="w-full justify-start gap-ui-1 font-normal" onClick={() => { setMenuId(null); onDuplicate(id); }}><span className="flex-1 text-left">Duplicate tab</span><span aria-hidden="true"><KbdGroup plain keys={keyboardShortcuts.duplicateDocument.keys} /></span></Button>
            <div role="separator" className="my-ui-1 border-t border-border-subtle" />
            <Button role="menuitem" variant="ghost" size="sm" className="w-full justify-start gap-ui-1 font-normal" onClick={() => { setMenuId(null); onClose(id); }}><span className="flex-1 text-left">Close tab</span><span aria-hidden="true"><KbdGroup plain keys={keyboardShortcuts.closeDocument.keys} /></span></Button>
            <Button role="menuitem" variant="ghost" size="sm" className="w-full justify-start gap-ui-1 font-normal" onClick={() => { setMenuId(null); onCloseOther(id); }}><span className="flex-1 text-left">Close other tabs</span><span aria-hidden="true"><KbdGroup plain keys={keyboardShortcuts.closeOtherDocuments.keys} /></span></Button>
            <Button role="menuitem" variant="ghost" size="sm" className="w-full justify-start gap-ui-1 font-normal" onClick={() => { setMenuId(null); onCloseAll(); }}><span className="flex-1 text-left">Close all tabs</span><span aria-hidden="true"><KbdGroup plain keys={keyboardShortcuts.closeAllDocuments.keys} /></span></Button>
          </PopoverContent>
        </Popover>;
      })}
      {workspace.ui.cookiesTabOpen ? <div className={cn("group flex shrink-0 items-center rounded-ui-md border transition-colors duration-ui-fast hover:bg-purr-elevated", workspace.ui.cookiesTabActive ? "border-border bg-purr-elevated" : "border-transparent")}>
        <button type="button" role="tab" aria-selected={workspace.ui.cookiesTabActive} aria-controls="active-document-panel" id={`document-tab-${cookiesTabId}`}
          className="ui-focus-ring flex h-control-sm items-center gap-ui-2 rounded-ui-md px-ui-2 text-ui-sm leading-none text-content-secondary hover:text-content-primary"
          onClick={onOpenCookies} onKeyDown={(event) => onTabKeyDown(event, cookiesTabId)} tabIndex={workspace.ui.cookiesTabActive ? 0 : -1}>
          <CookieIcon className="size-ui-3-5 text-action-brand" /><span className="inline-flex h-full items-center leading-none">Cookies</span><span className="font-code text-ui-2xs text-action-brand">{cookieCount}</span>
        </button>
        <Button variant="ghost" size="icon" className="mr-ui-1 size-ui-5 opacity-ui-hidden transition-opacity duration-ui-fast group-hover:opacity-ui-visible group-focus-within:opacity-ui-visible" aria-label="Close workspace cookies" onClick={onCloseCookies}><X className="size-ui-3" /></Button>
      </div> : null}
      {workspace.ui.variablesTabOpen ? <div className={cn("group flex shrink-0 items-center rounded-ui-md border transition-colors duration-ui-fast hover:bg-purr-elevated", workspace.ui.variablesTabActive ? "border-border bg-purr-elevated" : "border-transparent")}>
        <button type="button" role="tab" aria-selected={workspace.ui.variablesTabActive} aria-controls="active-document-panel" id={`document-tab-${variablesTabId}`}
          className="ui-focus-ring flex h-control-sm items-center gap-ui-2 rounded-ui-md px-ui-2 text-ui-sm leading-none text-content-secondary hover:text-content-primary"
          onClick={onOpenVariables} onKeyDown={(event) => onTabKeyDown(event, variablesTabId)} tabIndex={workspace.ui.variablesTabActive ? 0 : -1}>
          <Braces className="size-ui-3-5 text-action-brand" /><span className="inline-flex h-full items-center leading-none">Variables</span>
        </button>
        <Button variant="ghost" size="icon" className="mr-ui-1 size-ui-5 opacity-ui-hidden transition-opacity duration-ui-fast group-hover:opacity-ui-visible group-focus-within:opacity-ui-visible" aria-label="Close variables" onClick={onCloseVariables}><X className="size-ui-3" /></Button>
      </div> : null}
      {workspace.ui.settingsTabOpen ? <div className={cn("group flex shrink-0 items-center rounded-ui-md border transition-colors duration-ui-fast hover:bg-purr-elevated", workspace.ui.settingsTabActive ? "border-border bg-purr-elevated" : "border-transparent")}>
        <button type="button" role="tab" aria-selected={workspace.ui.settingsTabActive} aria-controls="active-document-panel" id={`document-tab-${settingsTabId}`}
          className="ui-focus-ring flex h-control-sm items-center gap-ui-2 rounded-ui-md px-ui-2 text-ui-sm leading-none text-content-secondary hover:text-content-primary"
          onClick={onOpenSettings} onKeyDown={(event) => onTabKeyDown(event, settingsTabId)} tabIndex={workspace.ui.settingsTabActive ? 0 : -1}>
          <Settings2 className="size-ui-3-5 text-action-brand" /><span className="inline-flex h-full items-center leading-none">Workspace settings</span>
        </button>
        <Button variant="ghost" size="icon" className="mr-ui-1 size-ui-5 opacity-ui-hidden transition-opacity duration-ui-fast group-hover:opacity-ui-visible group-focus-within:opacity-ui-visible" aria-label="Close workspace settings" onClick={onCloseSettings}><X className="size-ui-3" /></Button>
      </div> : null}
    </div>
    <NewDocumentButton defaultKind={workspace.ui.lastRequestKind} onNew={onNew} onNewExtension={onNewExtension} extensionTypes={extensionTypes} />
    <div className="flex-1" />
    {showSave ? <Button variant="ghost" size="icon" aria-label="Save document" title={`${activeDocument?.saved ? "Save changes" : "Save document"} · Mod+S`} onClick={onSave}><Save className="size-ui-4 text-action-brand" /></Button> : null}
  </div>;
}
