import { useEffect, useState, type TransitionEvent } from "react";

import type { RequestDraft } from "../model/request";
import { getRequestEditorSection, type RequestEditorSection } from "../model/request-editor-section";
import { HeadersEditor } from "./headers-editor";

type RequestSectionPanelProps = {
  activeSection: RequestEditorSection | null;
  draft: RequestDraft;
  onDraftChange: (draft: RequestDraft) => void;
};

export function RequestSectionPanel({ activeSection, draft, onDraftChange }: RequestSectionPanelProps) {
  const [renderedSection, setRenderedSection] = useState<RequestEditorSection | null>(activeSection);
  const sectionId = activeSection ?? renderedSection;
  const section = sectionId ? getRequestEditorSection(sectionId) : undefined;

  useEffect(() => {
    if (activeSection) {
      setRenderedSection(activeSection);
    }
  }, [activeSection]);

  const handleTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (!activeSection && event.target === event.currentTarget && event.propertyName === "opacity") {
      setRenderedSection(null);
    }
  };

  return (
    <div
      className={`grid transition-ui-expand duration-ui-normal ease-out ${activeSection ? "grid-rows-ui-expanded opacity-ui-visible" : "grid-rows-ui-collapsed opacity-ui-hidden"}`}
      aria-hidden={!activeSection}
      onTransitionEnd={handleTransitionEnd}
    >
      <div className="min-h-ui-0 overflow-hidden">
        {section?.id === "headers" ? (
          <HeadersEditor headers={draft.headers} onHeadersChange={(headers) => onDraftChange({ ...draft, headers })} />
        ) : section ? (
          <section id={`request-section-${section.id}`} role="tabpanel" className="bg-purr-elevated px-ui-4 py-ui-4 sm:px-ui-5">
            <div className="flex items-baseline justify-between gap-ui-4">
              <h2 className="m-ui-0 text-ui-md font-medium text-content-primary">{section.label}</h2>
              <p className="m-ui-0 text-ui-xs text-content-tertiary">{section.description}</p>
            </div>
            <div className="mt-ui-4 min-h-panel rounded-ui-lg border border-dashed border-border-subtle bg-purr-surface" />
          </section>
        ) : null}
      </div>
    </div>
  );
}
