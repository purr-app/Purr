import { useState } from "react";
import { ChevronDown, FileCode2, FilePlus2, FolderOpen, MoreHorizontal, Network, Search, Trash2 } from "lucide-react";
import { Button } from "../../../shared/components/ui/button";
import { Collapsible } from "../../../shared/components/ui/collapsible";
import { Input } from "../../../shared/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "../../../shared/components/ui/popover";
import { KbdGroup } from "../../../shared/components/ui/kbd";
import { keyboardShortcuts } from "../../../shared/config/keyboard-shortcuts";
import { cn } from "../../../shared/lib/cn";
import { getDocumentBadge, getDocumentDisplayName, isMeaningfulDraft, isRequestDocument, type CreatableDocumentKind, type WorkspaceDocument, type Workspace } from "../model/workspace";
import { NewDocumentButton } from "./new-document-button";

export function WorkspaceSidebar({ workspace, onOpen, onPin, onNew, onDuplicate, onDiscard, onDiscardAll, onDelete, onRename, onOpenFolder }: {
  workspace: Workspace; onOpen: (id: string) => void; onNew: (kind: CreatableDocumentKind) => void;
  onPin: (id: string) => void; onDuplicate: (id: string) => void; onDiscard: (id: string) => void; onDiscardAll: () => void; onDelete: (id: string) => void; onRename: (id: string) => void; onOpenFolder: () => void;
}) {
  const [query, setQuery] = useState("");
  const matching = workspace.documents.filter((document) => `${getDocumentDisplayName(document)} ${getDocumentBadge(document).label} ${isRequestDocument(document) ? document.request.url : ""}`.toLowerCase().includes(query.toLowerCase()));
  const savedHttp = matching.filter((document) => document.saved && document.kind === "http");
  const savedGraphql = matching.filter((document) => document.saved && (document.kind === "graphql" || (document.kind === "schema" && Boolean(document.sdl))));
  const drafts = matching.filter((document) => !document.saved && isMeaningfulDraft(document));
  const hasDrafts = workspace.documents.some((document) => !document.saved && isMeaningfulDraft(document));
  return <aside aria-label="Workspace documents" className="flex h-full w-ui-sidebar shrink-0 flex-col border-r border-border-subtle bg-purr-surface">
    <div className="flex shrink-0 items-center gap-ui-1 px-ui-2 py-ui-2">
      <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-ui-2 top-1/2 size-ui-3-5 -translate-y-1/2 text-content-tertiary" />
        <Input aria-label="Search documents" placeholder="Search documents…" className="ui-focus-ring h-control-md pl-ui-7 text-ui-sm" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <NewDocumentButton onNew={onNew} />
    </div>
    <div className="min-h-0 flex-1 space-y-ui-0 overflow-y-auto px-ui-2 pb-ui-2">
      <DocumentGroup label="HTTP" icon="http" documents={savedHttp} activeId={workspace.ui.cookiesTabActive || workspace.ui.settingsTabActive ? null : workspace.ui.activeDocumentId} onOpen={onOpen} onPin={onPin} onDuplicate={onDuplicate} onDiscard={onDiscard} onDelete={onDelete} onRename={onRename} />
      <DocumentGroup label="GraphQL" icon="graphql" documents={savedGraphql} activeId={workspace.ui.cookiesTabActive || workspace.ui.settingsTabActive ? null : workspace.ui.activeDocumentId} onOpen={onOpen} onPin={onPin} onDuplicate={onDuplicate} onDiscard={onDiscard} onDelete={onDelete} onRename={onRename} />
      <DocumentGroup label="Drafts" icon="draft" documents={drafts} activeId={workspace.ui.cookiesTabActive || workspace.ui.settingsTabActive ? null : workspace.ui.activeDocumentId} onOpen={onOpen} onPin={onPin} onDuplicate={onDuplicate} onDiscard={onDiscard} onDiscardAll={onDiscardAll} showDiscardAll={hasDrafts} onDelete={onDelete} onRename={onRename} />
      {!savedHttp.length && !savedGraphql.length && !drafts.length && <p className="px-ui-2 py-ui-3 text-ui-sm text-content-tertiary">{query ? "No matching documents." : "Saved documents and edited drafts appear here."}</p>}
    </div>
    <button type="button" className="ui-focus-ring flex items-center gap-ui-2 border-t border-border-subtle px-ui-3 py-ui-2 text-left text-ui-xs text-content-tertiary hover:bg-purr-elevated hover:text-content-secondary" onClick={onOpenFolder}>
      <FolderOpen className="size-ui-3-5" /><span className="truncate">{workspace.name} · Local workspace</span>
    </button>
  </aside>;
}

function DocumentGroup({ label, icon, documents, activeId, onOpen, onPin, onDuplicate, onDiscard, onDiscardAll, showDiscardAll = false, onDelete, onRename }: {
  label: string; icon: "http" | "graphql" | "draft"; documents: WorkspaceDocument[]; activeId: string | null;
  onOpen: (id: string) => void; onPin: (id: string) => void; onDuplicate: (id: string) => void; onDiscard: (id: string) => void; onDiscardAll?: () => void; showDiscardAll?: boolean; onDelete: (id: string) => void; onRename: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  if (!documents.length) return null;
  return <section aria-label={label}>
    <div className="flex items-center rounded-ui-md hover:bg-purr-elevated">
      <button type="button" className="ui-focus-ring flex min-w-0 flex-1 items-center gap-ui-2 rounded-ui-md px-ui-2 py-ui-1 text-ui-sm text-content-tertiary hover:text-content-secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDown className={cn("size-ui-3 transition-transform duration-ui-fast", !open && "-rotate-90")} />
        {icon === "http" ? <FileCode2 className="size-ui-3-5" /> : icon === "graphql" ? <Network className="size-ui-3-5" /> : <FilePlus2 className="size-ui-3-5" />}
        {label}<span className="ml-auto font-code text-ui-xs">{documents.length}</span>
      </button>
      {icon === "draft" && showDiscardAll && <Button variant="ghost" size="icon" className="mr-ui-1 size-control-xs text-accent-red" aria-label="Discard all drafts" title="Discard all drafts" onClick={onDiscardAll}><Trash2 className="size-ui-3" /></Button>}
    </div>
    <Collapsible open={open}><div>{documents.map((document) => <DocumentRow key={document.id} document={document} active={document.id === activeId}
      draft={icon === "draft"} onOpen={onOpen} onPin={onPin} onDuplicate={onDuplicate} onDiscard={onDiscard} onDelete={onDelete} onRename={onRename} />)}</div></Collapsible>
  </section>;
}

function DocumentRow({ document, active, draft, onOpen, onPin, onDuplicate, onDiscard, onDelete, onRename }: {
  document: WorkspaceDocument; active: boolean; draft: boolean; onOpen: (id: string) => void;
  onPin: (id: string) => void; onDuplicate: (id: string) => void; onDiscard: (id: string) => void; onDelete: (id: string) => void; onRename: (id: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  const name = getDocumentDisplayName(document);
  const remove = () => { setMenu(false); if (draft) onDiscard(document.id); else onDelete(document.id); };
  return <Popover open={menu} onOpenChange={setMenu}>
    <PopoverAnchor asChild><div className={cn("group flex items-center rounded-ui-md hover:bg-purr-highlight", active && "bg-purr-highlight")} onContextMenu={(event) => { event.preventDefault(); setMenu(true); }}>
      <button type="button" title={isRequestDocument(document) ? document.request.url || name : name} aria-current={active ? "page" : undefined}
        className={cn("ui-focus-ring flex min-w-0 flex-1 items-center gap-ui-2 rounded-ui-md px-ui-2 py-ui-1 text-ui-sm", active ? "text-content-primary" : "text-content-secondary")}
        onClick={() => onOpen(document.id)} onDoubleClick={() => onPin(document.id)} onKeyDown={(event) => {
          const modified = event.metaKey || event.ctrlKey;
          if (modified && event.key.toLowerCase() === "e") { event.preventDefault(); event.stopPropagation(); onRename(document.id); }
          else if (modified && event.key.toLowerCase() === "d") { event.preventDefault(); event.stopPropagation(); onDuplicate(document.id); }
          else if (!modified && (event.key === "Backspace" || event.key === "Delete")) { event.preventDefault(); remove(); }
        }}>
        <span className={cn("w-ui-10 shrink-0 text-left font-code text-ui-2xs", getDocumentBadge(document).color)}>{getDocumentBadge(document).label}</span><span className="truncate">{name}</span>
      </button>
      <Button variant="ghost" size="icon" className="mr-ui-1 size-control-xs opacity-ui-hidden group-hover:opacity-ui-visible focus-visible:opacity-ui-visible" aria-label={`Document actions for ${name}`} onClick={() => setMenu(true)}><MoreHorizontal className="size-ui-3" /></Button>
    </div></PopoverAnchor>
    <PopoverContent role="menu" aria-label={`Actions for ${name}`} align="end" sideOffset={4} className="w-ui-context-menu rounded-ui-lg border border-border bg-purr-overlay p-ui-1 shadow-popover" onOpenAutoFocus={(event) => event.preventDefault()}>
      <Button role="menuitem" variant="ghost" size="sm" className="w-full justify-start gap-ui-1 font-normal" onClick={() => { setMenu(false); onRename(document.id); }}><span className="flex-1 text-left">Rename</span><span aria-hidden="true"><KbdGroup plain keys={keyboardShortcuts.renameDocument.keys} /></span></Button>
      <Button role="menuitem" variant="ghost" size="sm" className="w-full justify-start gap-ui-1 font-normal" onClick={() => { setMenu(false); onDuplicate(document.id); }}><span className="flex-1 text-left">Duplicate</span><span aria-hidden="true"><KbdGroup plain keys={keyboardShortcuts.duplicateDocument.keys} /></span></Button>
      <div role="separator" className="my-ui-1 border-t border-border-subtle" />
      <Button role="menuitem" variant="ghost" size="sm" className="w-full justify-start gap-ui-1 font-normal text-accent-red" onClick={remove}><span className="flex-1 text-left">{draft ? "Discard" : "Delete"}</span><span aria-hidden="true"><KbdGroup plain keys={keyboardShortcuts.deleteDocument.keys} /></span></Button>
    </PopoverContent>
  </Popover>;
}
