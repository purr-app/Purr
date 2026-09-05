import { cn } from "../../../shared/lib/cn";
import { Button } from "../../../shared/components/ui/button";
import { requestEditorSections, type RequestEditorSection } from "../model/request-editor-section";

type RequestSectionTabsProps = {
  activeSection: RequestEditorSection | null;
  onSectionChange: (section: RequestEditorSection) => void;
};

export function RequestSectionTabs({ activeSection, onSectionChange }: RequestSectionTabsProps) {
  return (
    <div
      className="flex min-h-control-md flex-wrap items-center gap-ui-1 border-t border-border-default bg-purr-elevated px-ui-2-5 py-ui-1-5"
      role="tablist"
      aria-label="Request options"
    >
      {requestEditorSections.map((section) => {
        return (
          <Button
            key={section.id}
            className={cn(
              "h-control-sm px-ui-2 text-ui-2xs font-normal",
              activeSection === section.id ? "bg-purr-highlight text-content-primary" : "text-content-secondary opacity-ui-inactive",
            )}
            variant="ghost"
            size="sm"
            type="button"
            role="tab"
            aria-selected={activeSection === section.id}
            aria-controls={`request-section-${section.id}`}
            onClick={() => onSectionChange(section.id)}
          >
            {section.label}
          </Button>
        );
      })}
    </div>
  );
}
