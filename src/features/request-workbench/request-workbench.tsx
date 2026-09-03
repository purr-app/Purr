import { useCallback, useRef, useState } from "react";

import { EmptyResponse } from "./components/empty-response";
import { RequestComposer } from "./components/request-composer";
import { RequestTabBar } from "./components/request-tab-bar";
import { initialRequestDraft, type RequestDraft } from "./model/request";

export function RequestWorkbench() {
  const [draft, setDraft] = useState<RequestDraft>(initialRequestDraft);
  const composerRef = useRef<HTMLDivElement>(null);

  const focusComposer = useCallback(() => {
    composerRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);

  const pasteCurl = useCallback(async () => {
    focusComposer();
    try {
      const clipboardText = await navigator.clipboard.readText();
      if (clipboardText.startsWith("http")) setDraft((currentDraft) => ({ ...currentDraft, url: clipboardText }));
    } catch {
      // Clipboard access is optional; focusing the composer remains useful when it is unavailable.
    }
  }, [focusComposer]);

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <main className="mx-auto flex w-full max-w-[1360px] flex-1 flex-col px-4 pb-6 pt-6 sm:px-7 sm:pt-8">
        <div className="shrink-0">
          <RequestTabBar />
          <div ref={composerRef} className="mt-3">
            <RequestComposer draft={draft} onDraftChange={setDraft} onSend={focusComposer} />
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center pb-16 pt-10">
          <EmptyResponse onPasteUrl={pasteCurl} />
        </div>
      </main>
      <footer className="pointer-events-none flex h-10 items-center justify-end px-7 text-body-xs text-muted-foreground">
        Purr v0.0.0
      </footer>
    </div>
  );
}
