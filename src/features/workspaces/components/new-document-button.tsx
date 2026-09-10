import { useState } from "react";
import { FileCode2, Network, Plus, Waypoints } from "lucide-react";
import { Button } from "../../../shared/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "../../../shared/components/ui/popover";
import type { CreatableDocumentKind, RequestDocumentKind } from "../model/workspace";

export function NewDocumentButton({ onNew, defaultKind }: { onNew: (kind: CreatableDocumentKind) => void; defaultKind?: RequestDocumentKind }) {
  const [open, setOpen] = useState(false);
  const label = defaultKind ? `New ${defaultKind === "graphql" ? "GraphQL" : "HTTP"} request` : "Create document";
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverAnchor asChild><Button variant="ghost" size="icon" aria-label={label} title={defaultKind ? `${label} · right-click to choose type` : label}
      aria-haspopup="menu" aria-expanded={open}
      onClick={() => defaultKind ? onNew(defaultKind) : setOpen(!open)}
      onContextMenu={(event) => { event.preventDefault(); setOpen(true); }}
      onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ContextMenu") { event.preventDefault(); setOpen(true); } }}>
      <Plus className="size-ui-4" />
    </Button></PopoverAnchor>
    <PopoverContent align="end" role="menu" aria-label="New document type" className="mt-ui-2 w-ui-workspace-menu rounded-ui-lg border border-border bg-purr-overlay p-ui-1 shadow-popover">
      <Button role="menuitem" variant="ghost" className="w-full justify-start font-normal" onClick={() => { setOpen(false); onNew("http"); }}><FileCode2 className="size-ui-4 text-action-brand" />HTTP request</Button>
      <Button role="menuitem" variant="ghost" className="w-full justify-start font-normal" onClick={() => { setOpen(false); onNew("graphql"); }}><Network className="size-ui-4 text-action-graphql" />GraphQL request</Button>
      <Button role="menuitem" variant="ghost" className="w-full justify-start font-normal" onClick={() => { setOpen(false); onNew("schema"); }}><Waypoints className="size-ui-4 text-action-graphql" />GraphQL schema</Button>
    </PopoverContent>
  </Popover>;
}
