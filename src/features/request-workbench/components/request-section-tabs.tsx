import { cn } from "../../../shared/lib/cn";
import { Button } from "../../../shared/components/ui/button";
import { requestEditorSections, type RequestEditorSection } from "../model/request-editor-section";

type RequestSectionTabsProps = {
  activeSection: RequestEditorSection | null;
  onSectionChange: (section: RequestEditorSection) => void;
};

export function RequestSectionTabs({ activeSection, onSectionChange }: RequestSectionTabsProps) {
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-1 border-t border-border bg-surface-raised px-2.5 py-1.5" role="tablist" aria-label="Request options">
      {requestEditorSections.map((section) => {
        return (
          <Button
            key={section.id}
            className={cn(
              "h-7 px-2 text-xs font-normal leading-3",
              activeSection === section.id ? "text-foreground" : "text-muted opacity-60",
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
