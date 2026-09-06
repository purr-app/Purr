import { useCallback, useRef, useState } from "react";

import { RequestComposer } from "./components/request-composer";
import { RequestTabBar } from "./components/request-tab-bar";
import { initialRequestDraft, type RequestDraft } from "./model/request";

export function RequestWorkbench() {
  const [draft, setDraft] = useState<RequestDraft>(initialRequestDraft);
  const composerRef = useRef<HTMLDivElement>(null);

  const focusComposer = useCallback(() => {
    composerRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-purr-base">
      <main className="mx-auto flex w-full max-w-content flex-1 flex-col px-ui-4 pb-ui-6 pt-ui-6 sm:px-ui-7 sm:pt-ui-8">
        <div className="shrink-0">
          <RequestTabBar />
          <div ref={composerRef} className="mt-ui-3">
            <RequestComposer draft={draft} onDraftChange={setDraft} onSend={focusComposer} />
          </div>
        </div>

      </main>
      <footer className="pointer-events-none flex h-control-lg items-center justify-end px-ui-7 font-code text-ui-xs text-content-tertiary">
        Purr v0.0.0
      </footer>
    </div>
  );
}
