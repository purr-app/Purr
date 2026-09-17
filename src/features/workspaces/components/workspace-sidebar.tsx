import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { ChevronDown, ChevronRight, EllipsisVertical, Folder, FolderOpen, Search, Trash2 } from "lucide-react";
import type { ProjectResource } from "../../../domain/project";
import { Button } from "../../../shared/components/ui/button";
import { Collapsible } from "../../../shared/components/ui/collapsible";
import { Input } from "../../../shared/components/ui/input";
import { KbdGroup } from "../../../shared/components/ui/kbd";
import { Popover, PopoverAnchor, PopoverContent } from "../../../shared/components/ui/popover";
import { keyboardShortcuts } from "../../../shared/config/keyboard-shortcuts";
import { cn } from "../../../shared/lib/cn";
import { getDocumentBadge, getDocumentDisplayName, isMeaningfulDraft, isRequestDocument, type CreatableDocumentKind, type WorkspaceDocument, type Workspace } from "../model/workspace";
import { NewDocumentButton } from "./new-document-button";

type FolderResource = Extract<ProjectResource, { kind: "folder" }>;
type FolderId = string | null;
let draggedSidebarItem: { id: string; kind: "document" | "folder" } | null = null;

export function WorkspaceSidebar({ workspace, extensionTypes = [], onOpen, onPin, onNew, onNewExtension, onNewFolder, onDuplicate, onDiscard, onDiscardAll, onDelete, onRename, onMoveDocument, onMoveDocuments, onReorderDocument, onMoveFolder, onRenameFolder, onDeleteFolder, onOpenFolder }: {
  workspace: Workspace;
  extensionTypes?: readonly { extensionType: string; label: string }[];
  onOpen: (id: string) => void;
  onNew: (kind: CreatableDocumentKind, folderId?: string) => void;
  onNewExtension?: (extensionType: string, folderId?: string) => void;
  onNewFolder: (parentId?: string) => void;
  onPin: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDiscard: (id: string) => void;
  onDiscardAll: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string) => void;
  onMoveDocument: (id: string, folderId: FolderId) => void;
  onMoveDocuments: (ids: string[], folderId: FolderId) => void;
  onReorderDocument: (sourceId: string, targetId: string, position: "before" | "after") => void;
  onMoveFolder: (id: string, folderId: FolderId) => void;
  onRenameFolder: (id: string) => void;
  onDeleteFolder: (id: string) => void;
  onOpenFolder: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const folders = (workspace.extraResources ?? []).filter((resource): resource is FolderResource => resource.kind === "folder");
  const matching = workspace.documents.filter((document) => `${getDocumentDisplayName(document)} ${getDocumentBadge(document).label} ${isRequestDocument(document) ? document.request.url : ""}`.toLowerCase().includes(query.toLowerCase()));
  const savedDocuments = matching.filter((document) => document.saved && document.kind !== "schema");
  const schemas = matching.filter((document) => document.saved && document.kind === "schema");
  const drafts = matching.filter((document) => !document.saved && isMeaningfulDraft(document));
  const hasDrafts = workspace.documents.some((document) => !document.saved && isMeaningfulDraft(document));
  const activeId = workspace.ui.cookiesTabActive || workspace.ui.settingsTabActive || workspace.ui.variablesTabActive ? null : workspace.ui.activeDocumentId;
  const children = (folderId: FolderId) => folders.filter((folder) => (folder.folderId ?? null) === folderId);
  const documentsIn = (folderId: FolderId) => savedDocuments.filter((document) => (document.folderId ?? null) === folderId);
  const hasVisibleContent = (folder: FolderResource): boolean => documentsIn(folder.id).length > 0 || children(folder.id).some(hasVisibleContent);
  const rootFolders = children(null).filter((folder) => !query || hasVisibleContent(folder));
  const rootDocuments = documentsIn(null);
  const order = new Map((workspace.ui.sidebarItemOrder ?? workspace.ui.documentOrder ?? []).map((id, index) => [id, index]));
  const ordered = <T extends { id: string }>(items: T[]) => [...items].sort((left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER));
  const rootItems = ordered([...rootFolders, ...rootDocuments]);
  const hasContent = rootFolders.length > 0 || rootDocuments.length > 0 || schemas.length > 0 || drafts.length > 0;
  const selectDocument = (id: string, additive: boolean) => {
    if (!additive) { setSelectedDocumentIds([]); return false; }
    setSelectedDocumentIds((current) => current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id]);
    return true;
  };
  const clearSelection = () => setSelectedDocumentIds([]);

  return <aside aria-label="Workspace documents" className="flex h-full min-w-ui-sidebar-min w-ui-sidebar-dynamic max-w-ui-sidebar-max shrink-0 flex-col border-r border-border-subtle bg-purr-surface" style={{ "--sidebar-width": `${workspace.ui.sidebarWidth}rem` } as CSSProperties}>
    <div className="flex shrink-0 items-center gap-ui-1 px-ui-2 py-ui-2">
      <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-ui-2 top-1/2 size-ui-3-5 -translate-y-1/2 text-content-tertiary" />
        <Input aria-label="Search documents" placeholder="Search documents…" className="ui-focus-ring h-control-md pl-ui-7 text-ui-md" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <NewDocumentButton onNew={onNew} onNewExtension={onNewExtension} extensionTypes={extensionTypes} onNewFolder={onNewFolder} />
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-ui-2 pb-ui-2 pt-ui-1">
      <div aria-label="Documents">
        {rootItems.map((item) => item.kind === "folder" ? <FolderRow key={item.id} folder={item} folders={folders} documentsIn={documentsIn} children={children} ordered={ordered} depth={0} activeId={activeId}
          onOpen={onOpen} onPin={onPin} onNew={onNew} onNewExtension={onNewExtension} extensionTypes={extensionTypes} onNewFolder={onNewFolder} onDuplicate={onDuplicate} onDelete={onDelete} onRename={onRename}
          onMoveDocument={onMoveDocument} onMoveDocuments={onMoveDocuments} onReorderDocument={onReorderDocument} onMoveFolder={onMoveFolder} onRenameFolder={onRenameFolder} onDeleteFolder={onDeleteFolder}
          selectedDocumentIds={selectedDocumentIds} onSelectDocument={selectDocument} onClearSelection={clearSelection} />
          : <DocumentRow key={item.id} document={item} active={item.id === activeId} selected={selectedDocumentIds.includes(item.id)} selectedDocumentIds={selectedDocumentIds} draft={false} folders={folders}
            onOpen={onOpen} onPin={onPin} onDuplicate={onDuplicate} onDiscard={onDiscard} onDelete={onDelete} onRename={onRename} onMove={onMoveDocument} onReorder={onReorderDocument} onSelect={selectDocument} />)}
      </div>
      <AutoGroup label="Schemas" documents={schemas} activeId={activeId} folders={folders} onOpen={onOpen} onPin={onPin} onDuplicate={onDuplicate} onDiscard={onDiscard} onDelete={onDelete} onRename={onRename} onMove={onMoveDocument} />
      <AutoGroup label="Drafts" documents={drafts} activeId={activeId} folders={folders} onOpen={onOpen} onPin={onPin} onDuplicate={onDuplicate} onDiscard={onDiscard} onDelete={onDelete} onRename={onRename} onMove={onMoveDocument}
        onDiscardAll={onDiscardAll} showDiscardAll={hasDrafts} />
      {!hasContent && <p className="px-ui-2 py-ui-3 text-ui-sm text-content-tertiary">{query ? "No matching documents." : "Create a request or folder to get started."}</p>}
    </div>
    <button type="button" className="ui-focus-ring flex items-center gap-ui-2 border-t border-border-subtle px-ui-3 py-ui-2 text-left text-ui-sm text-content-tertiary hover:bg-purr-elevated hover:text-content-secondary" onClick={onOpenFolder}>
      <FolderOpen className="size-ui-3-5" /><span className="truncate">{workspace.name} · Local workspace</span>
    </button>
  </aside>;
}

function FolderRow({ folder, folders, documentsIn, children, ordered, depth, activeId, extensionTypes, onOpen, onPin, onNew, onNewExtension, onNewFolder, onDuplicate, onDelete, onRename, onMoveDocument, onMoveDocuments, onReorderDocument, onMoveFolder, onRenameFolder, onDeleteFolder, selectedDocumentIds, onSelectDocument, onClearSelection }: {
  folder: FolderResource;
  folders: FolderResource[];
  documentsIn: (folderId: FolderId) => WorkspaceDocument[];
  children: (folderId: FolderId) => FolderResource[];
  ordered: <T extends { id: string }>(items: T[]) => T[];
  depth: number;
  activeId: string | null;
  onOpen: (id: string) => void;
  onPin: (id: string) => void;
  onNew: (kind: CreatableDocumentKind, folderId?: string) => void;
  extensionTypes: readonly { extensionType: string; label: string }[];
  onNewExtension?: (extensionType: string, folderId?: string) => void;
  onNewFolder: (parentId?: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string) => void;
  onMoveDocument: (id: string, folderId: FolderId) => void;
  onMoveDocuments: (ids: string[], folderId: FolderId) => void;
  onReorderDocument: (sourceId: string, targetId: string, position: "before" | "after") => void;
  onMoveFolder: (id: string, folderId: FolderId) => void;
  onRenameFolder: (id: string) => void;
  onDeleteFolder: (id: string) => void;
  selectedDocumentIds: string[];
  onSelectDocument: (id: string, additive: boolean) => boolean;
  onClearSelection: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [dropping, setDropping] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const directDocuments = documentsIn(folder.id);
  const nestedFolders = children(folder.id);
  const childItems = ordered([...nestedFolders, ...directDocuments]);
  const documentCount = directDocuments.length + nestedFolders.reduce((count, child) => count + countDescendants(child, children, documentsIn), 0);
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDropping(false);
    const documentId = event.dataTransfer.getData("application/x-purr-document");
    const draggedIds = parseDraggedDocumentIds(event.dataTransfer.getData("application/x-purr-documents"), documentId);
    const documentIds = documentId && selectedDocumentIds.includes(documentId) && selectedDocumentIds.length > 1 ? selectedDocumentIds : draggedIds;
    const movingFolderId = event.dataTransfer.getData("application/x-purr-folder");
    if (documentIds.length) { onMoveDocuments(documentIds, folder.id); onClearSelection(); }
    if (movingFolderId && movingFolderId !== folder.id && !isFolderDescendant(folder.id, movingFolderId, folders)) onMoveFolder(movingFolderId, folder.id);
  };
  return <section className="min-w-0" aria-label={folder.name} onDragOver={(event) => { event.preventDefault(); setDropping(true); }} onDragLeave={() => setDropping(false)} onDrop={onDrop}
    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setActionsOpen(true); }}>
    <div draggable className={cn("group relative flex items-center rounded-ui-md", dropping && "bg-purr-highlight outline outline-ui-1 outline-action-brand-border", !dropping && "hover:bg-purr-elevated")}
      onDragStart={(event) => { draggedSidebarItem = { id: folder.id, kind: "folder" }; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-purr-folder", folder.id); }} onDragEnd={() => { draggedSidebarItem = null; }}>
      <button type="button" className="ui-focus-ring flex min-w-0 flex-1 items-center gap-ui-2 rounded-ui-md py-ui-1 pr-ui-12 text-ui-md text-content-secondary" style={{ paddingLeft: `calc(var(--space-2) + ${depth} * var(--space-7))` }} aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDown className={cn("size-ui-3 shrink-0 transition-transform duration-ui-fast", !open && "-rotate-90")} />
        <Folder className="size-ui-3-5 shrink-0 text-content-tertiary" />
        <span className="truncate">{folder.name}</span>
      </button>
      <span className="pointer-events-none absolute right-ui-2 font-code text-ui-sm text-content-tertiary group-hover:opacity-ui-hidden">{documentCount}</span>
      <span className="pointer-events-none absolute right-ui-1 flex items-center opacity-ui-hidden transition-opacity duration-ui-fast group-hover:pointer-events-auto group-hover:opacity-ui-visible focus-within:pointer-events-auto focus-within:opacity-ui-visible"><NewDocumentButton onNew={onNew} onNewExtension={onNewExtension} extensionTypes={extensionTypes} onNewFolder={onNewFolder} folderId={folder.id} />
        <FolderActions folder={folder} folders={folders} open={actionsOpen} onOpenChange={setActionsOpen} onMove={onMoveFolder} onRename={onRenameFolder} onDelete={onDeleteFolder} /></span>
    </div>
    <Collapsible open={open}><div className="relative">
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 border-l border-border-subtle" style={{ left: `calc(var(--space-3-5) + ${depth} * var(--space-7))` }} />
      {childItems.map((item) => item.kind === "folder" ? <FolderRow key={item.id} folder={item} folders={folders} documentsIn={documentsIn} children={children} ordered={ordered} depth={depth + 1} activeId={activeId}
        onOpen={onOpen} onPin={onPin} onNew={onNew} onNewExtension={onNewExtension} extensionTypes={extensionTypes} onNewFolder={onNewFolder} onDuplicate={onDuplicate} onDelete={onDelete} onRename={onRename}
        onMoveDocument={onMoveDocument} onMoveDocuments={onMoveDocuments} onReorderDocument={onReorderDocument} onMoveFolder={onMoveFolder} onRenameFolder={onRenameFolder} onDeleteFolder={onDeleteFolder}
        selectedDocumentIds={selectedDocumentIds} onSelectDocument={onSelectDocument} onClearSelection={onClearSelection} />
        : <DocumentRow key={item.id} document={item} active={item.id === activeId} selected={selectedDocumentIds.includes(item.id)} selectedDocumentIds={selectedDocumentIds} draft={false} folders={folders} folderDepth={depth}
          onOpen={onOpen} onPin={onPin} onDuplicate={onDuplicate} onDiscard={() => {}} onDelete={onDelete} onRename={onRename} onMove={onMoveDocument} onReorder={onReorderDocument} onSelect={onSelectDocument} />)}
    </div></Collapsible>
  </section>;
}

function countDescendants(folder: FolderResource, children: (folderId: FolderId) => FolderResource[], documentsIn: (folderId: FolderId) => WorkspaceDocument[]): number {
  return documentsIn(folder.id).length + children(folder.id).reduce((count, child) => count + countDescendants(child, children, documentsIn), 0);
}

function isFolderDescendant(candidateId: string, ancestorId: string, folders: FolderResource[]): boolean {
  const parent = folders.find((folder) => folder.id === candidateId)?.folderId;
  return parent === ancestorId || Boolean(parent && isFolderDescendant(parent, ancestorId, folders));
}

function parseDraggedDocumentIds(value: string, fallback: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) return [...new Set(parsed)];
  } catch { /* A regular single-document drag has no multi-select payload. */ }
  return fallback ? [fallback] : [];
}

function AutoGroup({ label, documents, activeId, folders, onOpen, onPin, onDuplicate, onDiscard, onDiscardAll, showDiscardAll = false, onDelete, onRename, onMove }: {
  label: "Schemas" | "Drafts";
  documents: WorkspaceDocument[];
  activeId: string | null;
  folders: FolderResource[];
  onOpen: (id: string) => void;
  onPin: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDiscard: (id: string) => void;
  onDiscardAll?: () => void;
  showDiscardAll?: boolean;
  onDelete: (id: string) => void;
  onRename: (id: string) => void;
  onMove: (id: string, folderId: FolderId) => void;
}) {
  const [open, setOpen] = useState(true);
  if (!documents.length) return null;
  return <section aria-label={label}>
    <div className="flex items-center rounded-ui-md hover:bg-purr-elevated">
      <button type="button" className="ui-focus-ring flex min-w-0 flex-1 items-center gap-ui-2 rounded-ui-md px-ui-2 py-ui-1 text-ui-md text-content-tertiary hover:text-content-secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDown className={cn("size-ui-3 transition-transform duration-ui-fast", !open && "-rotate-90")} />
        <span>{label}</span><span className="ml-auto font-code text-ui-xs">{documents.length}</span>
      </button>
      {label === "Drafts" && showDiscardAll && <Button variant="ghost" size="icon" className="mr-ui-1 size-control-xs text-accent-red" aria-label="Discard all drafts" title="Discard all drafts" onClick={onDiscardAll}><Trash2 className="size-ui-3" /></Button>}
    </div>
    <Collapsible open={open}><div className="relative">
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-ui-3-5 border-l border-border-subtle" />
      {documents.map((document) => <DocumentRow key={document.id} document={document} active={document.id === activeId}
        draft={label === "Drafts"} folders={folders} folderDepth={0} onOpen={onOpen} onPin={onPin} onDuplicate={onDuplicate} onDiscard={onDiscard} onDelete={onDelete} onRename={onRename} onMove={onMove} />)}
    </div></Collapsible>
  </section>;
}

function DocumentRow({ document, active, selected = false, selectedDocumentIds = [], draft, folders, folderDepth, onOpen, onPin, onDuplicate, onDiscard, onDelete, onRename, onMove, onReorder, onSelect }: {
  document: WorkspaceDocument;
  active: boolean;
  selected?: boolean;
  selectedDocumentIds?: string[];
  draft: boolean;
  folders: FolderResource[];
  folderDepth?: number;
  onOpen: (id: string) => void;
  onPin: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDiscard: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string) => void;
  onMove: (id: string, folderId: FolderId) => void;
  onReorder?: (sourceId: string, targetId: string, position: "before" | "after") => void;
  onSelect?: (id: string, additive: boolean) => boolean;
}) {
  const [menu, setMenu] = useState(false);
  const [dropPosition, setDropPosition] = useState<"before" | "after" | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const name = getDocumentDisplayName(document);
  const highlighted = active || selected;
  const remove = () => { setMenu(false); if (draft) onDiscard(document.id); else onDelete(document.id); };
  useEffect(() => {
    const targetRow = (event: globalThis.DragEvent) => {
      const target = event.target;
      return target instanceof Element ? target.closest(`[data-sidebar-document-id="${document.id}"]`) : null;
    };
    const updateDropTarget = (event: globalThis.DragEvent) => {
      const source = draggedSidebarItem; const target = targetRow(event);
      if (!source || source.id === document.id || !target || !onReorder || draft || document.kind === "schema") return;
      event.preventDefault();
      const bounds = target.getBoundingClientRect();
      setDropPosition(event.clientY - bounds.top < bounds.height / 2 ? "before" : "after");
    };
    const drop = (event: globalThis.DragEvent) => {
      const source = draggedSidebarItem; const target = targetRow(event);
      if (!source || source.id === document.id || !target || !onReorder || draft || document.kind === "schema") return;
      event.preventDefault();
      const bounds = target.getBoundingClientRect();
      onReorder(source.id, document.id, event.clientY - bounds.top < bounds.height / 2 ? "before" : "after");
      draggedSidebarItem = null; setDropPosition(null);
    };
    const clear = () => setDropPosition(null);
    globalThis.document.addEventListener("dragover", updateDropTarget);
    globalThis.document.addEventListener("drop", drop);
    globalThis.document.addEventListener("dragend", clear);
    return () => { globalThis.document.removeEventListener("dragover", updateDropTarget); globalThis.document.removeEventListener("drop", drop); globalThis.document.removeEventListener("dragend", clear); };
  }, [document.id, document.kind, draft, onReorder]);
  const draggedIds = selected && selectedDocumentIds.length ? selectedDocumentIds : [document.id];
  const startDocumentDrag = (event: DragEvent<HTMLElement>) => {
    draggedSidebarItem = { id: document.id, kind: "document" };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-purr-document", document.id);
    event.dataTransfer.setData("application/x-purr-documents", JSON.stringify(draggedIds));
  };
  return <Popover open={menu} onOpenChange={setMenu}>
    <PopoverAnchor asChild><div data-sidebar-document-id={document.id} draggable={!draft && document.kind !== "schema"} className={cn("group relative flex items-center rounded-ui-md hover:bg-purr-highlight", highlighted && "bg-purr-highlight")}
      onDragStart={startDocumentDrag} onDragEnd={() => { draggedSidebarItem = null; setDropPosition(null); }}
      onDragOver={(event) => {
        if (!onReorder || draft || document.kind === "schema") return;
        event.preventDefault(); event.stopPropagation();
        const bounds = event.currentTarget.getBoundingClientRect();
        setDropPosition(event.clientY - bounds.top < bounds.height / 2 ? "before" : "after");
      }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropPosition(null); }} onDrop={(event) => {
        const sourceId = event.dataTransfer.getData("application/x-purr-document") || event.dataTransfer.getData("application/x-purr-folder");
        const bounds = event.currentTarget.getBoundingClientRect();
        const position = dropPosition ?? (event.clientY - bounds.top < bounds.height / 2 ? "before" : "after");
        if (!sourceId || !onReorder || sourceId === document.id) return;
        event.preventDefault(); event.stopPropagation();
        onReorder(sourceId, document.id, position); setDropPosition(null);
      }}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setMenu(true); }}>
      {dropPosition && <span aria-hidden="true" className={cn("pointer-events-none absolute left-ui-2 right-0 border-t border-action-brand", dropPosition === "before" ? "top-0" : "bottom-0")} />}
      <button type="button" draggable={!draft && document.kind !== "schema"} title={isRequestDocument(document) ? document.request.url || name : name} aria-current={active ? "page" : undefined}
        className={cn("ui-focus-ring flex min-w-0 flex-1 items-center gap-ui-2 rounded-ui-md py-ui-1", folderDepth === undefined ? "px-ui-2" : "pr-ui-2", "text-ui-md", active ? "text-content-primary" : "text-content-secondary")}
        style={folderDepth === undefined ? undefined : { paddingLeft: `calc(var(--space-7) + ${folderDepth} * var(--space-7))` }}
        onDragStart={startDocumentDrag}
        onDragOver={(event) => {
          if (!onReorder || draft || document.kind === "schema") return;
          event.preventDefault(); event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          setDropPosition(event.clientY - bounds.top < bounds.height / 2 ? "before" : "after");
        }} onDrop={(event) => {
          const sourceId = event.dataTransfer.getData("application/x-purr-document") || event.dataTransfer.getData("application/x-purr-folder");
          const bounds = event.currentTarget.getBoundingClientRect();
          const position = dropPosition ?? (event.clientY - bounds.top < bounds.height / 2 ? "before" : "after");
          if (!sourceId || !onReorder || sourceId === document.id) return;
          event.preventDefault(); event.stopPropagation(); onReorder(sourceId, document.id, position); setDropPosition(null);
        }}
        onClick={(event) => { if (!onSelect?.(document.id, event.shiftKey)) onOpen(document.id); }} onDoubleClick={() => onPin(document.id)} onKeyDown={(event) => {
          const modified = event.metaKey || event.ctrlKey;
          if (modified && event.key.toLowerCase() === "r") { event.preventDefault(); event.stopPropagation(); onRename(document.id); }
          else if (modified && event.key.toLowerCase() === "d") { event.preventDefault(); event.stopPropagation(); onDuplicate(document.id); }
          else if (!modified && (event.key === "Backspace" || event.key === "Delete")) { event.preventDefault(); remove(); }
        }}>
        <span className={cn("w-ui-10 shrink-0 text-left font-code text-ui-xs", getDocumentBadge(document).color)}>{getDocumentBadge(document).label}</span><span className="truncate">{name}</span>
      </button>
      <Button variant="ghost" size="icon" className="mr-ui-1 size-control-xs opacity-ui-hidden group-hover:opacity-ui-visible focus-visible:opacity-ui-visible" aria-label={`Document actions for ${name}`} onClick={() => setMenu(true)}><EllipsisVertical className="size-ui-3" /></Button>
    </div></PopoverAnchor>
    <PopoverContent ref={menuRef} role="menu" tabIndex={-1} aria-label={`Actions for ${name}`} align="end" sideOffset={4}
      className="w-ui-context-menu rounded-ui-lg border border-border bg-purr-overlay p-ui-1 shadow-popover"
      onOpenAutoFocus={(event) => { event.preventDefault(); menuRef.current?.focus({ preventScroll: true }); }}
      onKeyDown={(event) => {
        const modified = event.metaKey || event.ctrlKey;
        const plainModified = modified && !event.altKey && !event.shiftKey;
        if (plainModified && event.key.toLowerCase() === "r") { event.preventDefault(); event.stopPropagation(); setMenu(false); onRename(document.id); }
        else if (plainModified && event.key.toLowerCase() === "d") { event.preventDefault(); event.stopPropagation(); setMenu(false); onDuplicate(document.id); }
        else if (!modified && !event.altKey && !event.shiftKey && (event.key === "Backspace" || event.key === "Delete")) { event.preventDefault(); event.stopPropagation(); remove(); }
      }}>
      <Button role="menuitem" variant="ghost" size="sm" className="w-full justify-start gap-ui-1 font-normal" onClick={() => { setMenu(false); onRename(document.id); }}><span className="flex-1 text-left">Rename</span><span aria-hidden="true"><KbdGroup plain keys={keyboardShortcuts.renameDocument.keys} /></span></Button>
      <Button role="menuitem" variant="ghost" size="sm" className="w-full justify-start gap-ui-1 font-normal" onClick={() => { setMenu(false); onDuplicate(document.id); }}><span className="flex-1 text-left">Duplicate</span><span aria-hidden="true"><KbdGroup plain keys={keyboardShortcuts.duplicateDocument.keys} /></span></Button>
      {document.kind !== "schema" && <MoveToItems folders={folders} currentFolderId={document.folderId ?? null} onMove={(folderId) => { setMenu(false); onMove(document.id, folderId); }} />}
      <div role="separator" className="my-ui-1 border-t border-border-subtle" />
      <Button role="menuitem" variant="ghost" size="sm" className="w-full justify-start gap-ui-1 font-normal text-accent-red" onClick={remove}><span className="flex-1 text-left">{draft ? "Discard" : "Delete"}</span><span aria-hidden="true"><KbdGroup plain keys={keyboardShortcuts.deleteDocument.keys} /></span></Button>
    </PopoverContent>
  </Popover>;
}

function FolderActions({ folder, folders, open, onOpenChange, onMove, onRename, onDelete }: { folder: FolderResource; folders: FolderResource[]; open: boolean; onOpenChange: (open: boolean) => void; onMove: (id: string, folderId: FolderId) => void; onRename: (id: string) => void; onDelete: (id: string) => void }) {
  const descendants = new Set<string>();
  const collect = (parentId: string) => folders.filter((item) => item.folderId === parentId).forEach((item) => { descendants.add(item.id); collect(item.id); });
  collect(folder.id);
  return <Popover open={open} onOpenChange={onOpenChange}>
    <PopoverAnchor asChild><Button variant="ghost" size="icon" className="size-control-xs" aria-label={`Folder actions for ${folder.name}`} onClick={() => onOpenChange(true)}><EllipsisVertical className="size-ui-3" /></Button></PopoverAnchor>
    <PopoverContent role="menu" align="end" sideOffset={4} aria-label={`Actions for ${folder.name}`} className="w-ui-context-menu rounded-ui-lg border border-border bg-purr-overlay p-ui-1 shadow-popover">
      <Button role="menuitem" variant="ghost" size="sm" className="w-full justify-start font-normal" onClick={() => { onOpenChange(false); onRename(folder.id); }}>Rename</Button>
      <MoveToItems folders={folders.filter((item) => item.id !== folder.id && !descendants.has(item.id))} currentFolderId={folder.folderId ?? null} onMove={(folderId) => { onOpenChange(false); onMove(folder.id, folderId); }} />
      <div role="separator" className="my-ui-1 border-t border-border-subtle" />
      <Button role="menuitem" variant="ghost" size="sm" className="w-full justify-start font-normal text-accent-red" onClick={() => { onOpenChange(false); onDelete(folder.id); }}>Delete</Button>
    </PopoverContent>
  </Popover>;
}

function MoveToItems({ folders, currentFolderId, onMove }: { folders: FolderResource[]; currentFolderId: FolderId; onMove: (folderId: FolderId) => void }) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverAnchor asChild><Button role="menuitem" variant="ghost" size="sm" className="w-full justify-start gap-ui-2 font-normal" onClick={() => setOpen(true)} onPointerMove={() => setOpen(true)}><span className="flex-1 text-left">Move to…</span><ChevronRight className="size-ui-3 text-content-tertiary" /></Button></PopoverAnchor>
    <PopoverContent role="menu" side="right" align="start" sideOffset={4} aria-label="Move to folder" className="w-ui-context-menu rounded-ui-lg border border-border bg-purr-overlay p-ui-1 shadow-popover">
      <Button role="menuitem" variant="ghost" size="sm" disabled={currentFolderId === null} className="w-full justify-start font-normal" onClick={() => { setOpen(false); onMove(null); }}>Root</Button>
      {folders.map((folder) => <Button key={folder.id} role="menuitem" variant="ghost" size="sm" disabled={currentFolderId === folder.id} className="w-full justify-start font-normal" onClick={() => { setOpen(false); onMove(folder.id); }}>{folder.name}</Button>)}
    </PopoverContent>
  </Popover>;
}
