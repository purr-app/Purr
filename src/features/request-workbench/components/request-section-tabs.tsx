import { cn } from "../../../shared/lib/cn";
import { Button } from "../../../shared/components/ui/button";
import { requestEditorSections, type RequestEditorSection } from "../model/request-editor-section";

type RequestSectionTabsProps = {
  activeSection: RequestEditorSection | null;
  onSectionChange: (section: RequestEditorSection) => void;
  headerCount: number;
  hasHeaderError: boolean;
};

export function RequestSectionTabs({ activeSection, onSectionChange, headerCount, hasHeaderError }: RequestSectionTabsProps) {
  return (
    <div
      className="flex min-h-control-md flex-wrap items-center gap-ui-1 bg-purr-elevated px-ui-2 py-ui-1-5"
      role="tablist"
      aria-label="Request options"
    >
      {requestEditorSections.map((section) => {
        return (
          <Button
            key={section.id}
            className={cn(activeSection === section.id ? "bg-purr-highlight text-content-primary" : "text-content-secondary opacity-ui-inactive")}
            variant="ghost"
            weight="normal"
            type="button"
            role="tab"
            aria-selected={activeSection === section.id}
            aria-controls={`request-section-${section.id}`}
            onClick={() => onSectionChange(section.id)}
          >
            {section.label}
            {section.id === "headers" && hasHeaderError ? <span className="size-ui-2 rounded-full bg-method-delete" aria-label="Headers contain validation errors" /> : null}
            {section.id === "headers" && !hasHeaderError && headerCount > 0 ? <span className="font-code text-action-brand">{headerCount}</span> : null}
          </Button>
        );
      })}
    </div>
  );
}
