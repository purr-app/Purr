import { ApplicationMenu } from "./application-menu";
import { Files, History, GitBranch } from "lucide-react";
import { Button } from "../../../shared/components/ui/button";
import { cn } from "../../../shared/lib/cn";
import type { SidebarActivity } from "../model/workspace";

const activities = [{ id: "documents", label: "Documents", icon: Files }, { id: "history", label: "History", icon: History }, { id: "git", label: "Source control", icon: GitBranch }] as const;

export function WorkspaceActivityRail({ activity, open, onSelect, gitChanges = 0 }: {
  gitChanges?: number;
  activity: SidebarActivity;
  open: boolean;
  onSelect: (activity: SidebarActivity) => void;
}) {
  return <nav aria-label="Workspace activities" className="flex w-ui-traffic-lights shrink-0 flex-col items-center gap-ui-3 border-r border-border-subtle bg-purr-surface py-ui-3">
    {activities.map(({ id, label, icon: Icon }) => <Button key={id} variant="ghost" size="icon" aria-label={label} title={label}
      aria-pressed={activity === id} aria-expanded={activity === id && open} aria-controls="workspace-sidebar"
      className={cn("relative size-ui-8", activity === id && "bg-purr-highlight text-content-primary")} onClick={() => onSelect(id)}>
      <Icon className="size-ui-5" />
      {id === "git" && gitChanges > 0 && <span className="absolute bottom-0 right-0 flex min-w-ui-3-5 items-center justify-center rounded-full bg-action-brand px-ui-1 font-code text-ui-2xs text-content-primary" aria-label={`${gitChanges} changed files`}>{gitChanges > 99 ? "99+" : gitChanges}</span>}
    </Button>)}
    <div className="mt-auto"><ApplicationMenu /></div>
  </nav>;
}
