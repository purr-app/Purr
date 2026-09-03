import { ClipboardPaste, Clock3, FileInput, type LucideIcon } from "lucide-react";

import { keyboardShortcuts, type KeyboardShortcut } from "../../../shared/config/keyboard-shortcuts";
import { Button } from "../../../shared/components/ui/button";
import { KbdGroup } from "../../../shared/components/ui/kbd";

type EmptyResponseProps = {
  onPasteUrl: () => void;
};

type QuickAction = {
  label: string;
  shortcut: KeyboardShortcut;
  icon: LucideIcon;
  onClick?: () => void;
};

export function EmptyResponse({ onPasteUrl }: EmptyResponseProps) {
  const quickActions: QuickAction[] = [
    { label: "Paste cURL", shortcut: keyboardShortcuts.pasteCurl, icon: ClipboardPaste, onClick: onPasteUrl },
    { label: "Import request", shortcut: keyboardShortcuts.importRequest, icon: FileInput },
    { label: "Open recent", shortcut: keyboardShortcuts.openRecentRequest, icon: Clock3 },
  ];

  return (
    <section className="flex flex-col items-center text-center" aria-label="Empty response state">
      <div className="mb-4 grid size-16 place-items-center rounded-xl border border-border bg-surface-strong p-3.5">
        <img className="size-8" src="/purr.svg" alt="" aria-hidden="true" />
      </div>
      <h1 className="m-0 text-base font-medium text-muted">Send a request to inspect its response.</h1>
      <p className="mt-1 text-sm text-muted-foreground">No projects, collections, or environments required. Just raw wire speed.</p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
        {quickActions.map(({ label, shortcut, icon: Icon, onClick }) => (
          <Button key={label} className="h-10 gap-2.5 rounded-lg px-4 text-[15px]" onClick={onClick} variant="secondary" type="button">
            <Icon className="size-[18px]" aria-hidden="true" />
            {label}
            <KbdGroup keys={shortcut.keys} />
          </Button>
        ))}
      </div>
    </section>
  );
}
