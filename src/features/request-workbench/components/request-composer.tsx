import { Plus, SendHorizonal } from "lucide-react";

import { Button } from "../../../shared/components/ui/button";
import { Input } from "../../../shared/components/ui/input";
import { HttpMethodPicker } from "../../../shared/components/http/http-method-picker";
import type { RequestDraft } from "../model/request";

const requestSections = ["Query", "Header", "Auth", "Body"];

type RequestComposerProps = {
  draft: RequestDraft;
  onDraftChange: (draft: RequestDraft) => void;
  onSend: () => void;
};

export function RequestComposer({ draft, onDraftChange, onSend }: RequestComposerProps) {
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

      <div className="flex min-h-10 flex-wrap items-center gap-1 border-t border-border bg-surface-raised px-2.5 py-1.5">
        <div className="flex flex-wrap items-center gap-1">
          {requestSections.map((section) => (
            <Button key={section} className="h-7 px-2 text-body-sm" variant="ghost" size="sm" type="button">
              <Plus className="size-3.5" aria-hidden="true" />
              {section}
            </Button>
          ))}
        </div>
      </div>
    </section>
  );
}
