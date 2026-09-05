import { SendHorizonal } from "lucide-react";
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
    <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-panel" aria-label="Request composer">
      <form
        className="p-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <div className="flex items-center gap-3">
          <HttpMethodPicker value={draft.method} onValueChange={(method) => onDraftChange({ ...draft, method })} />
          <Input
            className="min-w-0 flex-1 font-mono text-body-sm sm:text-body-md"
            value={draft.url}
            onChange={(event) => onDraftChange({ ...draft, url: event.target.value })}
            aria-label="Request URL"
            spellCheck="false"
          />
          <Button className="h-10 bg-[#9fbaf8] px-4 text-[#102c5c] hover:bg-[#b3c8ff] active:bg-[#90acf0] sm:min-w-28" type="submit">
            Send
          <SendHorizonal size={12} className="text-[#102c5c]"/>
            {/*<KbdGroup className="hidden text-[#102c5c] sm:inline-flex" kbdClassName="border-[#6e8dce] bg-[#89a7e8] text-[#102c5c] dark:border-[#6e8dce] dark:bg-[#89a7e8]" keys={["mod", "enter"]} />*/}
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
