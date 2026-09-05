import { SendHorizontal } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { Button } from "../../../shared/components/ui/button";
import { Input } from "../../../shared/components/ui/input";
import { HttpMethodPicker } from "../../../shared/components/http/http-method-picker";
import { useClickOutside } from "../../../shared/hooks/use-click-outside";
import type { RequestDraft } from "../model/request";
import { RequestSectionPanel } from "./request-section-panel";
import { RequestSectionTabs } from "./request-section-tabs";
import type { RequestEditorSection } from "../model/request-editor-section";

type RequestComposerProps = {
  draft: RequestDraft;
  onDraftChange: (draft: RequestDraft) => void;
  onSend: () => void;
};

export function RequestComposer({ draft, onDraftChange, onSend }: RequestComposerProps) {
  const [activeSection, setActiveSection] = useState<RequestEditorSection | null>(null);
  const sectionControlsRef = useRef<HTMLDivElement>(null);

  const closeSection = useCallback(() => setActiveSection(null), []);
  useClickOutside(sectionControlsRef, closeSection, activeSection !== null);

  const toggleSection = (section: RequestEditorSection) => {
    setActiveSection((currentSection) => (currentSection === section ? null : section));
  };

  return (
    <section className="overflow-hidden rounded-ui-xl border border-border-default bg-purr-surface shadow-panel" aria-label="Request composer">
      <form
        className="p-ui-2-5"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <div className="flex items-center gap-ui-3">
          <HttpMethodPicker value={draft.method} onValueChange={(method) => onDraftChange({ ...draft, method })} />
          <Input
            className="min-w-0 flex-1 font-code text-ui-sm sm:text-ui-md"
            value={draft.url}
            onChange={(event) => onDraftChange({ ...draft, url: event.target.value })}
            aria-label="Request URL"
            spellCheck="false"
          />
          <Button className="h-control-lg px-ui-4" type="submit">
            Send
            <SendHorizontal className="size-ui-4" aria-hidden="true" />
          </Button>
        </div>
      </form>

      <div ref={sectionControlsRef}>
        <RequestSectionTabs activeSection={activeSection} onSectionChange={toggleSection} />
        <RequestSectionPanel activeSection={activeSection} />
      </div>
    </section>
  );
}
