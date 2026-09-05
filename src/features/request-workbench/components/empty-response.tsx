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
      <div className="mb-ui-4 grid size-ui-16 place-items-center rounded-ui-xl border border-border-default bg-purr-elevated p-ui-3-5">
        <img className="size-ui-8" src="/purr.svg" alt="" aria-hidden="true" />
      </div>
      <h1 className="m-ui-0 text-ui-lg font-medium text-content-primary">Send a request to inspect its response.</h1>
      <p className="mt-ui-1 text-ui-md text-content-secondary">No projects, collections, or environments required. Just raw wire speed.</p>
      <div className="mt-ui-5 flex flex-wrap items-center justify-center gap-ui-2-5">
        {quickActions.map(({ label, shortcut, icon: Icon, onClick }) => (
          <Button
            key={label}
            className="h-control-lg gap-ui-2-5 rounded-ui-lg px-ui-4 text-ui-lg"
            onClick={onClick}
            variant="secondary"
            type="button"
          >
            <Icon className="size-ui-5" aria-hidden="true" />
            {label}
            <KbdGroup keys={shortcut.keys} />
          </Button>
        ))}
      </div>
    </section>
  );
}
