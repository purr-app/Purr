import { Clock3, ClipboardPaste, FilePlus2 } from "lucide-react";

import { Button } from "../../../shared/components/ui/button";
import { KbdGroup } from "../../../shared/components/ui/kbd";
import { keyboardShortcuts } from "../../../shared/config/keyboard-shortcuts";

export function EmptyWorkspace({ onNew, onPasteCurl }: { onNew: () => void; onPasteCurl: () => void }) {
  return <section aria-label="Nothing is open" className="flex h-full min-h-0 flex-col items-center justify-center px-ui-6 py-ui-10 text-center">
    <img src="/purr.svg" alt="Purr" className="size-ui-16 rounded-ui-xl shadow-panel" />
    <h1 className="mb-ui-0 mt-ui-5 text-ui-xl font-semibold text-content-primary">Nothing is open</h1>
    <p className="mb-ui-0 mt-ui-1 text-ui-md text-content-tertiary">Open a document from the sidebar or start a new request.</p>
    <div className="mt-ui-5 flex flex-wrap items-center justify-center gap-ui-2">
      <Button type="button" variant="secondary" size="lg" aria-label="New request" onClick={onNew}><FilePlus2 className="size-ui-4" aria-hidden="true" />New request<KbdGroup keys={keyboardShortcuts.newDocument.keys} /></Button>
      <Button type="button" variant="secondary" size="lg" aria-label="Paste cURL" onClick={onPasteCurl}><ClipboardPaste className="size-ui-4" aria-hidden="true" />Paste cURL<KbdGroup keys={keyboardShortcuts.pasteCurl.keys} /></Button>
      <Button type="button" variant="secondary" size="lg" aria-label="Open recent" disabled title="Coming soon"><Clock3 className="size-ui-4" aria-hidden="true" />Open recent<KbdGroup keys={keyboardShortcuts.openRecentRequest.keys} /></Button>
    </div>
  </section>;
}
