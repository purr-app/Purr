import * as React from "react";

import type { ShortcutKey } from "../../config/keyboard-shortcuts";
import { cn } from "../../lib/cn";

export type KbdProps = React.HTMLAttributes<HTMLElement>;

type KbdGroupProps = {
  keys: readonly ShortcutKey[];
  className?: string;
  kbdClassName?: string;
  plain?: boolean;
};

function Kbd({ className, ...props }: KbdProps) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-control-xs shrink-0 select-none items-center rounded-ui-sm border border-border-subtle bg-purr-base px-ui-1-5 font-code text-ui-2xs font-normal leading-none text-content-tertiary shadow-button",
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ keys, className, kbdClassName, plain = false }: KbdGroupProps) {
  const labels = keys.map(getPlatformKeyLabel);

  return (
    <span className={cn("ml-ui-1 inline-flex shrink-0", className)} aria-label={labels.join(" + ")}>
      <Kbd className={cn("gap-ui-1", plain && "border-0 bg-transparent px-ui-0 shadow-none", kbdClassName)}>
        {labels.map((label, index) => (
          <span
            key={`${label}-${index}`}
            className={cn("leading-none", isSymbolKey(label) ? "font-ui text-ui-sm" : "font-code text-ui-2xs")}
          >
            {label}
          </span>
        ))}
      </Kbd>
    </span>
  );
}

function isSymbolKey(label: string) {
  return ["⌘", "⌃", "⌥", "⇧", "↵", "⌫"].includes(label);
}

function getPlatformKeyLabel(key: ShortcutKey) {
  const isApplePlatform = typeof navigator !== "undefined" && /mac|iphone|ipad|ipod/i.test(navigator.userAgent);

  const appleLabels: Record<string, string> = {
    mod: "⌘",
    ctrl: "⌃",
    alt: "⌥",
    shift: "⇧",
    enter: "↵",
    escape: "esc",
    backspace: "⌫",
  };
  const otherLabels: Record<string, string> = {
    mod: "Ctrl",
    ctrl: "Ctrl",
    alt: "Alt",
    shift: "Shift",
    enter: "Enter",
    escape: "Esc",
    backspace: "Backspace",
  };

  return (isApplePlatform ? appleLabels : otherLabels)[key.toLowerCase()] ?? key.toUpperCase();
}

export { Kbd, KbdGroup };
