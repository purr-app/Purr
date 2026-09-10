import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileCode2, Search } from "lucide-react";
import { Input } from "../../../shared/components/ui/input";
import { KbdGroup } from "../../../shared/components/ui/kbd";
import { Modal } from "../../../shared/components/ui/modal";
import { cn } from "../../../shared/lib/cn";
import type { KeyboardShortcut } from "../../../shared/config/keyboard-shortcuts";
import { getDocumentDisplayName, getDocumentBadge, getDocumentGroup, isRequestDocument, isMeaningfulDraft, type Workspace } from "../model/workspace";

export type PaletteAction = { id: string; title: string; icon: ReactNode; shortcut?: KeyboardShortcut; run: () => void };
export function CommandPalette({ workspace, actions, onOpenDocument, onClose }: {
  workspace: Workspace; actions: PaletteAction[]; onOpenDocument: (id: string) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const items = [
    ...actions.map((action) => ({ ...action, group: "Quick actions", search: action.title })),
    ...workspace.documents.filter((document) => document.saved || isMeaningfulDraft(document)).sort((a, b) => getDocumentGroup(a).localeCompare(getDocumentGroup(b))).map((document) => ({ id: document.id, title: getDocumentDisplayName(document), group: getDocumentGroup(document), search: `${getDocumentDisplayName(document)} ${getDocumentBadge(document).label} ${isRequestDocument(document) ? document.request.url : "schema"}`,
      icon: <FileCode2 className={cn("size-ui-4", getDocumentBadge(document).color)} />, shortcut: undefined, run: () => onOpenDocument(document.id),
    })),
  ].filter((item) => item.search.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [selected]);
  const run = (index: number) => { const item = items[index]; if (item) { onClose(); item.run(); } };
  return <Modal title="Search documents and commands" onClose={onClose}>
    <div className="relative border-b border-border px-ui-5 py-ui-4">
      <Search className="pointer-events-none absolute left-ui-7 top-1/2 size-ui-4 -translate-y-1/2 text-content-tertiary" />
      <Input autoFocus className="ui-focus-ring pl-ui-8" placeholder="Search requests, commands, or shortcuts…" aria-label="Search commands" value={query}
        role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="command-results" aria-activedescendant={items[selected] ? `command-${items[selected].id}` : undefined}
        onChange={(event) => { setQuery(event.target.value); setSelected(0); }} onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setSelected((current) => items.length ? (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length : 0); }
          if (event.key === "Enter") { event.preventDefault(); run(selected); }
        }} />
    </div>
    <div ref={list} id="command-results" role="listbox" aria-label="Commands and documents" className="max-h-ui-palette overflow-y-auto p-ui-2">
      {items.map((item, index) => <div key={item.id}>
        {(index === 0 || item.group !== items[index - 1].group) && <div className="px-ui-3 pb-ui-2 pt-ui-4 text-ui-xs font-medium uppercase text-content-tertiary">{item.group}</div>}
        <div id={`command-${item.id}`} role="option" aria-selected={selected === index} onMouseMove={() => setSelected(index)} onClick={() => run(index)}
          className={cn("flex cursor-pointer items-center gap-ui-3 rounded-ui-md px-ui-3 py-ui-3 text-ui-md", selected === index ? "bg-purr-highlight text-content-primary" : "text-content-secondary")}>
          {item.icon}<span className="min-w-0 flex-1 truncate">{item.title}</span>{item.shortcut && <KbdGroup keys={item.shortcut.keys} />}
        </div>
      </div>)}
      {!items.length && <p className="p-ui-6 text-center text-ui-sm text-content-tertiary">No matching commands or documents.</p>}
    </div>
    <footer className="flex items-center justify-between gap-ui-3 border-t border-border px-ui-5 py-ui-3 text-ui-xs text-content-tertiary"><span className="truncate">{workspace.name} · {workspace.environments.find((item) => item.id === workspace.activeEnvironmentId)?.name ?? "No environment"}</span><span className="shrink-0 font-code">↑ ↓ Navigate · Enter Select · Esc Close</span></footer>
  </Modal>;
}
