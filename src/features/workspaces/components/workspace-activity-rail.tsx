import { Files, History } from "lucide-react";
import { Button } from "../../../shared/components/ui/button";
import { cn } from "../../../shared/lib/cn";
import type { SidebarActivity } from "../model/workspace";

const activities = [{ id: "documents", label: "Documents", icon: Files }] as const;

export function WorkspaceActivityRail({ activity, open, onSelect }: {
  activity: SidebarActivity;
  open: boolean;
  onSelect: (activity: SidebarActivity) => void;
}) {
  return <nav aria-label="Workspace activities" className="flex w-ui-traffic-lights shrink-0 flex-col items-center gap-ui-3 border-r border-border-subtle bg-purr-surface py-ui-3">
    {activities.map(({ id, label, icon: Icon }) => <Button key={id} variant="ghost" size="icon" aria-label={label} title={label}
      aria-pressed={activity === id} aria-expanded={activity === id && open} aria-controls="workspace-sidebar"
      className={cn("size-ui-8", activity === id && "bg-purr-highlight text-content-primary")} onClick={() => onSelect(id)}>
      <Icon className="size-ui-5" />
    </Button>)}
    <span title="History — coming soon">
      <Button variant="ghost" size="icon" className="size-ui-8" disabled aria-label="History — coming soon"><History className="size-ui-5" /></Button>
    </span>
  </nav>;
}
