import { SendHorizontal } from "lucide-react";
import { useState } from "react";

import { Button } from "../../../shared/components/ui/button";
import { Input } from "../../../shared/components/ui/input";
import { HttpMethodPicker } from "../../../shared/components/http/http-method-picker";
import {
  getEnabledRequestHeaderCount,
  getEnabledRequestQueryParamCount,
  getRequestHeaders,
  getRequestQueryParamsFromUrl,
  hasRequestHeaderValidationError,
  type RequestDraft,
} from "../model/request";
import { RequestSectionPanel } from "./request-section-panel";
import { RequestSectionTabs } from "./request-section-tabs";
import type { RequestEditorSection } from "../model/request-editor-section";

type RequestComposerProps = {
  draft: RequestDraft;
  onDraftChange: (draft: RequestDraft) => void;
  onSend: () => void;
};

export function RequestComposer({
  draft,
  onDraftChange,
  onSend,
}: RequestComposerProps) {
  const [activeSection, setActiveSection] =
    useState<RequestEditorSection>("body");
  const headers = getRequestHeaders(draft);

  const selectSection = (section: RequestEditorSection) =>
    setActiveSection(section);

  return (
    <section
      className="flex min-w-0 flex-col gap-ui-3"
      aria-label="Request composer"
    >
      <div className="overflow-hidden rounded-ui-xl border-emphasis border-purr-elevated bg-purr-elevated shadow-panel px-ui-2 pt-2">
        <form
          className="bg-purr-codefield p-ui-2 rounded-ui-lg"
          onSubmit={(event) => {
            event.preventDefault();
            onSend();
          }}
        >
          <div className="flex items-center gap-ui-2">
            <HttpMethodPicker
              value={draft.method}
              onValueChange={(method) => onDraftChange({ ...draft, method })}
            />
            <Input
              className="min-w-0 flex-1 font-code text-ui-sm sm:text-ui-md"
              variant="transparent"
              value={draft.url}
              onChange={(event) => {
                const url = event.target.value;
                onDraftChange({
                  ...draft,
                  url,
                  params: getRequestQueryParamsFromUrl(url, draft.params),
                });
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

        <RequestSectionTabs
          activeSection={activeSection}
          onSectionChange={selectSection}
          bodyType={draft.body.type}
          queryCount={getEnabledRequestQueryParamCount(draft.params)}
          headerCount={getEnabledRequestHeaderCount(headers)}
          hasHeaderError={hasRequestHeaderValidationError(headers)}
        />
      </div>
      <RequestSectionPanel
        activeSection={activeSection}
        draft={draft}
        onDraftChange={onDraftChange}
      />
    </section>
  );
}
