import { useState } from "react";
import { ChevronDown, FileCode2, FilePlus2, FolderOpen, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "../../../shared/components/ui/button";
import { Input } from "../../../shared/components/ui/input";
import { cn } from "../../../shared/lib/cn";
import { getHttpMethodStyle } from "../../../shared/model/http-method";
import { Popover, PopoverContent, PopoverTrigger } from "../../../shared/components/ui/popover";
import { getDocumentDisplayName, isMeaningfulDraft, type HttpDocument, type Workspace } from "../model/workspace";

export function WorkspaceSidebar({ workspace, onOpen, onNew, onDiscard, onOpenFolder }: {
  workspace: Workspace;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDiscard: (id: string) => void;
  onOpenFolder: () => void;
}) {
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const matching = workspace.documents.filter((document) => `${document.name} ${document.request.method} ${document.request.url}`.toLowerCase().includes(query.toLowerCase()));
  return <aside aria-label="Workspace documents" className="flex h-full w-ui-sidebar shrink-0 flex-col border-r border-border-subtle bg-purr-surface">
    <div className="flex shrink-0 items-center gap-ui-1 p-ui-3">
      <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-ui-2 top-1/2 size-ui-3-5 -translate-y-1/2 text-content-tertiary" />
        <Input aria-label="Search documents" placeholder="Search documents…" className="ui-focus-ring h-control-md pl-ui-7 text-ui-sm" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <Popover open={createOpen} onOpenChange={setCreateOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Create document" title="Create document"><Plus className="size-ui-4" /></Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="mt-ui-2 w-ui-workspace-menu rounded-ui-lg border border-border bg-purr-overlay p-ui-1 shadow-popover">
          <Button variant="ghost" className="w-full justify-start font-normal" onClick={() => { setCreateOpen(false); onNew(); }}>
            <FileCode2 className="size-ui-4 text-method-get" />HTTP request
          </Button>
        </PopoverContent>
      </Popover>
    </div>
    <div className="min-h-0 flex-1 space-y-ui-4 overflow-y-auto px-ui-2 pb-ui-3">
      <DocumentGroup label="HTTP requests" icon="http" documents={matching.filter((document) => document.saved)} activeId={workspace.ui.cookiesTabActive ? null : workspace.ui.activeDocumentId} onOpen={onOpen} onDiscard={onDiscard} />
      <DocumentGroup label="Drafts" icon="draft" documents={matching.filter((document) => !document.saved && isMeaningfulDraft(document))} activeId={workspace.ui.cookiesTabActive ? null : workspace.ui.activeDocumentId} onOpen={onOpen} onDiscard={onDiscard} />
      {!matching.length && <p className="px-ui-2 py-ui-5 text-ui-sm text-content-tertiary">{query ? "No matching documents." : "Create your first request with +."}</p>}
    </div>
    <button type="button" className="ui-focus-ring flex items-center gap-ui-2 border-t border-border-subtle px-ui-3 py-ui-3 text-left text-ui-xs text-content-tertiary hover:bg-purr-elevated hover:text-content-secondary" onClick={onOpenFolder}>
      <FolderOpen className="size-ui-3-5" /><span className="truncate">{workspace.name} · Local workspace</span>
    </button>
  </aside>;
}

function DocumentGroup({ label, icon, documents, activeId, onOpen, onDiscard }: { label: string; icon: "http" | "draft"; documents: HttpDocument[]; activeId: string | null; onOpen: (id: string) => void; onDiscard: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  return <section aria-label={label}>
    <button type="button" className="ui-focus-ring mb-ui-1 flex w-full items-center gap-ui-2 rounded-ui-md px-ui-2 py-ui-2 text-ui-xs text-content-tertiary hover:text-content-secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
      <ChevronDown className={cn("size-ui-3 transition-transform duration-ui-fast", !open && "-rotate-90")} />
      {icon === "http" ? <FileCode2 className="size-ui-3-5" /> : <FilePlus2 className="size-ui-3-5" />}
      {label}<span className="ml-auto font-code">{documents.length}</span>
    </button>
    {open && documents.map((document) => {
      const name = getDocumentDisplayName(document);
      return <div key={document.id} className="group flex items-center rounded-ui-md hover:bg-purr-elevated">
      <button type="button" title={document.request.url || name} aria-current={document.id === activeId ? "page" : undefined}
        className={cn("ui-focus-ring flex min-w-0 flex-1 items-center gap-ui-2 rounded-ui-md px-ui-3 py-ui-2 text-ui-sm", document.id === activeId ? "bg-purr-highlight text-content-primary" : "text-content-secondary")}
        onClick={() => onOpen(document.id)}>
        <span className={cn("w-ui-10 shrink-0 text-left font-code text-ui-2xs", getHttpMethodStyle(document.request.method).text)}>{document.request.method}</span><span className="truncate">{name}</span>
      </button>
      {icon === "draft" ? <Button variant="ghost" size="icon" className="mr-ui-1 size-control-xs opacity-ui-hidden group-hover:opacity-ui-visible focus-visible:opacity-ui-visible" aria-label={`Discard draft ${name}`} title="Discard draft" onClick={() => onDiscard(document.id)}><Trash2 className="size-ui-3" /></Button> : null}
    </div>})}
    {open && !documents.length && <p className="px-ui-3 py-ui-2 text-ui-xs text-content-quaternary">{icon === "http" ? "Save a request to add it here." : "No drafts"}</p>}
  </section>;
}
