import * as React from "react";

import type { ShortcutKey } from "../../config/keyboard-shortcuts";
import { cn } from "../../lib/cn";

export type KbdProps = React.HTMLAttributes<HTMLElement>;

type KbdGroupProps = {
  keys: readonly ShortcutKey[];
  className?: string;
  kbdClassName?: string;
};

function Kbd({ className, ...props }: KbdProps) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 shrink-0 select-none items-center rounded-[5px] border border-black/[0.12] bg-black/[0.08] px-1.5 font-mono text-[10px] font-normal leading-none text-muted shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] dark:border-white/[0.1] dark:bg-black/[0.28]",
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ keys, className, kbdClassName }: KbdGroupProps) {
  const labels = keys.map(getPlatformKeyLabel);

  return (
    <span className={cn("ml-1 inline-flex shrink-0", className)} aria-label={labels.join(" + ")}>
      <Kbd className={cn("gap-1", kbdClassName)}>
        {labels.map((label, index) => (
          <span key={`${label}-${index}`} className={"font-sans text-[13px] leading-none"}>
            {label}
          </span>
        ))}
      </Kbd>
    </span>
  );
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
  };
  const otherLabels: Record<string, string> = {
    mod: "Ctrl",
    ctrl: "Ctrl",
    alt: "Alt",
    shift: "Shift",
    enter: "Enter",
    escape: "Esc",
  };

  return (isApplePlatform ? appleLabels : otherLabels)[key.toLowerCase()] ?? key.toUpperCase();
}

export { Kbd, KbdGroup };
