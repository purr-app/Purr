import { useEffect, useState } from "react";

import { getRequestEditorSection, type RequestEditorSection } from "../model/request-editor-section";

type RequestSectionPanelProps = {
  activeSection: RequestEditorSection | null;
};

export function RequestSectionPanel({ activeSection }: RequestSectionPanelProps) {
  const [renderedSection, setRenderedSection] = useState<RequestEditorSection | null>(activeSection);
  const sectionId = activeSection ?? renderedSection;
  const section = sectionId ? getRequestEditorSection(sectionId) : undefined;

  useEffect(() => {
    if (activeSection) {
      setRenderedSection(activeSection);
      return;
    }

    const removeContentTimer = window.setTimeout(() => setRenderedSection(null), 200);
    return () => window.clearTimeout(removeContentTimer);
  }, [activeSection]);

  return (
    <div
      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${activeSection ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
      aria-hidden={!activeSection}
    >
      <div className="min-h-0 overflow-hidden">
        {section ? (
          <section id={`request-section-${section.id}`} role="tabpanel" className="bg-surface-raised px-4 py-4 sm:px-5">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="m-0 text-body-md font-medium text-foreground">{section.label}</h2>
              <p className="m-0 text-body-xs text-muted-foreground">{section.description}</p>
            </div>
            <div className="mt-4 min-h-36 rounded-lg border border-dashed border-border-strong bg-surface-raised" />
          </section>
        ) : null}
      </div>
    </div>
  );
}
