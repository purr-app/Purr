import { SendHorizontal } from "lucide-react";
import { useState } from "react";

import { Button } from "../../../shared/components/ui/button";
import { Input } from "../../../shared/components/ui/input";
import { HttpMethodPicker } from "../../../shared/components/http/http-method-picker";
import { getEnabledRequestHeaderCount, getEnabledRequestQueryParamCount, getRequestQueryParamsFromUrl, hasRequestHeaderValidationError, type RequestDraft } from "../model/request";
import { RequestSectionPanel } from "./request-section-panel";
import { RequestSectionTabs } from "./request-section-tabs";
import type { RequestEditorSection } from "../model/request-editor-section";

type RequestComposerProps = {
  draft: RequestDraft;
  onDraftChange: (draft: RequestDraft) => void;
  onSend: () => void;
};

export function RequestComposer({ draft, onDraftChange, onSend }: RequestComposerProps) {
  const [activeSection, setActiveSection] = useState<RequestEditorSection>("headers");

  const selectSection = (section: RequestEditorSection) => setActiveSection(section);

  return (
    <section className="overflow-hidden rounded-ui-xl border-emphasis border-purr-elevated bg-purr-elevated shadow-panel" aria-label="Request composer">
      <form
        className="bg-purr-base p-ui-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <div className="flex items-center gap-ui-2">
          <HttpMethodPicker value={draft.method} onValueChange={(method) => onDraftChange({ ...draft, method })} />
          <Input
            className="min-w-0 flex-1 font-code text-ui-sm sm:text-ui-md"
            variant="transparent"
            value={draft.url}
            onChange={(event) => {
              const url = event.target.value;
              onDraftChange({ ...draft, url, params: getRequestQueryParamsFromUrl(url, draft.params) });
            }}
            aria-label="Request URL"
            spellCheck="false"
          />
          <Button className="shadow-action" size="lg" type="submit">
            Send
            <SendHorizontal className="size-ui-4" aria-hidden="true" />
          </Button>
        </div>
      </form>

      <div>
        <RequestSectionTabs
          activeSection={activeSection}
          onSectionChange={selectSection}
          queryCount={getEnabledRequestQueryParamCount(draft.params)}
          headerCount={getEnabledRequestHeaderCount(draft.headers)}
          hasHeaderError={hasRequestHeaderValidationError(draft.headers)}
        />
        <RequestSectionPanel activeSection={activeSection} draft={draft} onDraftChange={onDraftChange} />
      </div>
    </section>
  );
}
