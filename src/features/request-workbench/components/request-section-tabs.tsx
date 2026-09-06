import { cn } from "../../../shared/lib/cn";
import { Button } from "../../../shared/components/ui/button";
import { requestEditorSections, type RequestEditorSection } from "../model/request-editor-section";

type RequestSectionTabsProps = {
  activeSection: RequestEditorSection;
  onSectionChange: (section: RequestEditorSection) => void;
  queryCount: number;
  headerCount: number;
  hasHeaderError: boolean;
};

export function RequestSectionTabs({ activeSection, onSectionChange, queryCount, headerCount, hasHeaderError }: RequestSectionTabsProps) {
  return (
    <div
      className="flex min-h-control-md flex-wrap items-center gap-ui-1 bg-purr-elevated px-ui-1 py-ui-1-5"
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
            {section.id === "query" && queryCount > 0 ? <span className="font-code text-accent-orange">{queryCount}</span> : null}
            {section.id === "headers" && hasHeaderError ? <span className="size-ui-2 rounded-full bg-method-delete" aria-label="Headers contain validation errors" /> : null}
            {section.id === "headers" && !hasHeaderError && headerCount > 0 ? <span className="font-code text-action-brand">{headerCount}</span> : null}
          </Button>
        );
      })}
    </div>
  );
}
