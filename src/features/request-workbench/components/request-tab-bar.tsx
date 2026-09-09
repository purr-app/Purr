import { Columns2, Rows2, Square, type LucideIcon } from "lucide-react";

import { Button } from "../../../shared/components/ui/button";
import { cn } from "../../../shared/lib/cn";

export type WorkbenchView = "canvas" | "horizontal" | "vertical";

const viewOptions: readonly {
  value: WorkbenchView;
  label: string;
  description: string;
  shortcut: string;
  Icon: LucideIcon;
}[] = [
  {
    value: "canvas",
    label: "Canvas",
    description: "Focus request editing, then expand the response",
    shortcut: "Mod+Shift+1",
    Icon: Square,
  },
  {
    value: "horizontal",
    label: "Horizontal split",
    description: "Request above response",
    shortcut: "Mod+Shift+2",
    Icon: Rows2,
  },
  {
    value: "vertical",
    label: "Vertical split",
    description: "Request beside response",
    shortcut: "Mod+Shift+3",
    Icon: Columns2,
  },
];

export function RequestTabBar({
  view,
  onViewChange,
}: {
  view: WorkbenchView;
  onViewChange: (view: WorkbenchView) => void;
}) {
  return (
      <div
        className="flex shrink-0 items-center gap-ui-1 rounded-ui-md bg-purr-surface"
        role="group"
        aria-label="Workbench view"
      >
        {viewOptions.map(({ value, label, description, shortcut, Icon }) => (
          <Button
            key={value}
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`${label} view`}
            aria-pressed={view === value}
            title={`${description} · ${shortcut}`}
            className={cn(
              "size-control-sm",
              view === value
                ? "bg-purr-highlight text-action-brand"
                : "text-content-tertiary",
            )}
            onClick={() => onViewChange(value)}
          >
            <Icon className="size-ui-3-5" aria-hidden="true" />
          </Button>
        ))}
      </div>
  );
}
