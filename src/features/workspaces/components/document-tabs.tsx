import { Cookie as CookieIcon, Plus, Save, X } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { Button } from "../../../shared/components/ui/button";
import { cn } from "../../../shared/lib/cn";
import { getHttpMethodStyle } from "../../../shared/model/http-method";
import { getDocumentDisplayName, isDocumentDirty, isMeaningfulDraft, type Workspace } from "../model/workspace";

const cookiesTabId = "workspace-cookies-tab";

export function DocumentTabs({ workspace, cookieCount, onOpen, onClose, onPin, onReorder, onOpenCookies, onCloseCookies, onNew, onSave }: {
  workspace: Workspace;
  cookieCount: number;
  onOpen: (id: string) => void;
  onClose: (id: string) => void;
  onPin: (id: string) => void;
  onReorder: (sourceId: string, targetId: string) => void;
  onOpenCookies: () => void;
  onCloseCookies: () => void;
  onNew: () => void;
  onSave: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const activeDocument = workspace.documents.find((item) => item.id === workspace.ui.activeDocumentId);
  const showSave = Boolean(!workspace.ui.cookiesTabActive && activeDocument && (!activeDocument.saved || isDocumentDirty(activeDocument)));
  const tabIds = [...workspace.ui.openDocumentIds, ...(workspace.ui.cookiesTabOpen ? [cookiesTabId] : [])];
  const openTab = (id: string) => id === cookiesTabId ? onOpenCookies() : onOpen(id);
  const onTabKeyDown = (event: KeyboardEvent, id: string) => {
    if (event.altKey && event.shiftKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
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
  }, [workspace.ui.activeDocumentId, workspace.ui.cookiesTabActive]);
  return <div className="flex h-control-lg min-w-0 shrink-0 items-center gap-ui-1 border-b border-border-subtle bg-purr-base px-ui-2">
    <div ref={list} role="tablist" aria-label="Documents" className="flex min-w-0 items-center gap-ui-1 overflow-x-auto">
      {workspace.ui.openDocumentIds.map((id) => {
        const document = workspace.documents.find((item) => item.id === id)!;
        const name = getDocumentDisplayName(document);
        const active = !workspace.ui.cookiesTabActive && workspace.ui.activeDocumentId === id;
        const preview = workspace.ui.previewDocumentId === id;
        const dirty = isDocumentDirty(document);
        const startDrag = (event: DragEvent) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", id);
          setDraggingId(id);
        };
        return <div key={id} draggable data-document-id={id} onDragStart={startDrag} onDragEnd={() => { setDraggingId(null); setDragOverId(null); }}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDragOverId(id); }}
          onDrop={(event) => { event.preventDefault(); const source = draggingId ?? event.dataTransfer.getData("text/plain"); if (source && source !== id) onReorder(source, id); setDraggingId(null); setDragOverId(null); }}
          className={cn("group flex shrink-0 cursor-grab items-center rounded-ui-md border transition-colors duration-ui-fast hover:bg-purr-elevated active:cursor-grabbing",
            active ? "border-border bg-purr-elevated" : "border-transparent",
            dragOverId === id && draggingId !== id && "border-action-brand-border bg-action-brand-surface",
            draggingId === id && "opacity-ui-disabled")}>
          <button type="button" role="tab" aria-selected={active} aria-controls="active-document-panel" id={`document-tab-${id}`} title={name}
            className="ui-focus-ring flex h-control-sm max-w-ui-document-tab items-center gap-ui-2 rounded-ui-md px-ui-2 text-ui-sm leading-none text-content-secondary hover:text-content-primary"
            onClick={() => onOpen(id)} onDoubleClick={() => onPin(id)} onKeyDown={(event) => onTabKeyDown(event, id)} tabIndex={active ? 0 : -1}>
            <span className={cn("ui-document-method inline-flex h-full items-center font-code text-ui-2xs leading-none", getHttpMethodStyle(document.request.method).text)}>{document.request.method}</span>
            <span className={cn("inline-flex h-full min-w-0 items-center truncate leading-none", preview && "italic")}>{name}</span>
            {dirty && <span className="size-ui-1-5 shrink-0 rounded-full bg-action-brand" title={document.saved ? "Unsaved changes" : "Draft"} />}
            {!document.saved && !isMeaningfulDraft(document) ? <span className="sr-only">Blank request</span> : null}
          </button>
          <Button variant="ghost" size="icon" className="mr-ui-1 size-ui-5" aria-label={`Close ${name}`} onClick={() => onClose(id)}><X className="size-ui-3" /></Button>
        </div>;
      })}
      {workspace.ui.cookiesTabOpen ? <div className={cn("group flex shrink-0 items-center rounded-ui-md border transition-colors duration-ui-fast hover:bg-purr-elevated", workspace.ui.cookiesTabActive ? "border-border bg-purr-elevated" : "border-transparent")}>
        <button type="button" role="tab" aria-selected={workspace.ui.cookiesTabActive} aria-controls="active-document-panel" id={`document-tab-${cookiesTabId}`}
          className="ui-focus-ring flex h-control-sm items-center gap-ui-2 rounded-ui-md px-ui-2 text-ui-sm leading-none text-content-secondary hover:text-content-primary"
          onClick={onOpenCookies} onKeyDown={(event) => onTabKeyDown(event, cookiesTabId)} tabIndex={workspace.ui.cookiesTabActive ? 0 : -1}>
          <CookieIcon className="size-ui-3-5 text-action-brand" /><span className="inline-flex h-full items-center leading-none">Cookies</span><span className="font-code text-ui-2xs text-action-brand">{cookieCount}</span>
        </button>
        <Button variant="ghost" size="icon" className="mr-ui-1 size-ui-5" aria-label="Close workspace cookies" onClick={onCloseCookies}><X className="size-ui-3" /></Button>
      </div> : null}
    </div>
    <Button variant="ghost" size="icon" aria-label="New HTTP request" title="New HTTP request · Mod+N" onClick={onNew}><Plus className="size-ui-4" /></Button>
    <div className="flex-1" />
    {showSave ? <Button variant="ghost" size="icon" aria-label="Save document" title={`${activeDocument?.saved ? "Save changes" : "Save document"} · Mod+S`} onClick={onSave}><Save className="size-ui-4 text-action-brand" /></Button> : null}
  </div>;
}
