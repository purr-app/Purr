import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { cn } from "../../lib/cn";

type SplitPaneProps = {
  orientation: "horizontal" | "vertical";
  first: ReactNode;
  second: ReactNode;
  firstLabel: string;
  secondLabel: string;
  initialRatio?: number;
  ratio?: number;
  onRatioChange?: (ratio: number) => void;
  firstSize?: string;
  hideSecond?: boolean;
  dimSecond?: boolean;
  onFocusSecond?: () => void;
  animated?: boolean;
  className?: string;
};

const minimumRatio = 24;
const maximumRatio = 76;

function clampRatio(value: number) {
  return Math.min(maximumRatio, Math.max(minimumRatio, value));
}

export function SplitPane({
  orientation,
  first,
  second,
  firstLabel,
  secondLabel,
  initialRatio = 50,
  ratio: controlledRatio,
  onRatioChange,
  firstSize,
  hideSecond = false,
  dimSecond = false,
  onFocusSecond,
  animated = false,
  className,
}: SplitPaneProps) {
  const [ratios, setRatios] = useState(() => ({
    horizontal: clampRatio(initialRatio),
    vertical: clampRatio(initialRatio),
  }));
  const ratio = controlledRatio ?? ratios[orientation];
  const setRatio = (value: number) => {
    setRatios((current) => ({ ...current, [orientation]: clampRatio(value) }));
    onRatioChange?.(clampRatio(value));
  };
  const resizable = firstSize === undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ position: number; ratio: number } | null>(null);

  const updateFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !containerRef.current || !separatorRef.current || !resizable) return;
    const bounds = containerRef.current.getBoundingClientRect();
    const vertical = orientation === "vertical";
    const available = vertical
      ? bounds.width - separatorRef.current.offsetWidth
      : bounds.height - separatorRef.current.offsetHeight;
    if (available <= 0) return;
    const delta = (vertical ? event.clientX : event.clientY) - dragging.current.position;
    setRatio(dragging.current.ratio + (delta / available) * 100);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!resizable) return;
    const decrementKey = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
    const incrementKey = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
    if (event.key === decrementKey || event.key === incrementKey) {
      event.preventDefault();
      setRatio(ratio + (event.key === incrementKey ? 4 : -4));
    } else if (event.key === "Home") {
      event.preventDefault();
      setRatio(minimumRatio);
    } else if (event.key === "End") {
      event.preventDefault();
      setRatio(maximumRatio);
    }
  };

  const gutter = hideSecond ? "var(--space-0)" : "var(--splitter-gutter)";
  const size = firstSize ?? `calc((100% - ${gutter}) * ${ratio / 100})`;
  const tracks = `minmax(0, ${size}) ${gutter} minmax(0, 1fr)`;

  return (
    <div
      ref={containerRef}
      className={cn(
        "grid h-full min-h-0 min-w-0 flex-1",
        animated && "transition-ui-layout duration-ui-layout motion-reduce:transition-none",
        className,
      )}
      data-split-orientation={orientation}
      style={{
        gridTemplateColumns: orientation === "vertical" ? tracks : "minmax(0, 1fr)",
        gridTemplateRows: orientation === "horizontal" ? tracks : "minmax(0, 1fr)",
      }}
    >
      <section
        aria-label={firstLabel}
        className="min-h-0 min-w-0 overflow-hidden"
      >
        {first}
      </section>
      <div
        ref={separatorRef}
        role="separator"
        tabIndex={resizable && !hideSecond ? 0 : undefined}
        aria-label={resizable ? `Resize ${firstLabel} and ${secondLabel}` : `${firstLabel} and ${secondLabel} divider`}
        aria-hidden={hideSecond}
        aria-orientation={orientation === "vertical" ? "vertical" : "horizontal"}
        aria-valuemin={resizable ? minimumRatio : undefined}
        aria-valuemax={resizable ? maximumRatio : undefined}
        aria-valuenow={resizable ? Math.round(ratio) : undefined}
        className={cn(
          "ui-focus-ring group flex min-h-0 min-w-0 touch-none items-center justify-center overflow-hidden rounded-ui-sm",
          orientation === "vertical"
            ? "flex-col"
            : "flex-row",
          resizable && (orientation === "vertical" ? "cursor-col-resize" : "cursor-row-resize"),
          hideSecond && "invisible",
        )}
        onDoubleClick={() => resizable && setRatio(50)}
        onKeyDown={handleKeyDown}
        onPointerDown={(event) => {
          if (!resizable || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          dragging.current = {
            position: orientation === "vertical" ? event.clientX : event.clientY,
            ratio,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={updateFromPointer}
        onPointerUp={(event) => {
          dragging.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          dragging.current = null;
        }}
        onLostPointerCapture={() => {
          dragging.current = null;
        }}
      >
        <span
          className={cn(
            "flex min-h-0 min-w-0 flex-1 items-center justify-center rounded-full bg-border text-content-quaternary transition-colors duration-ui-fast group-hover:bg-action-brand-border group-hover:text-action-brand group-focus-visible:bg-action-brand-border group-focus-visible:text-action-brand",
            orientation === "vertical"
              ? "w-ui-1 flex-col"
              : "h-ui-1 flex-row",
          )}
          aria-hidden="true"
        >
          <span className={cn("flex gap-ui-1", orientation === "vertical" && "flex-col")}>
            {[0, 1, 2].map((dot) => (
              <span key={dot} className="size-splitter-dot shrink-0 rounded-full bg-current" />
            ))}
          </span>
        </span>
      </div>
      <section
        aria-label={secondLabel}
        className={cn("relative min-h-0 min-w-0 overflow-hidden rounded-ui-xl", hideSecond && "invisible")}
        aria-hidden={hideSecond}
        inert={hideSecond}
      >
        <div
          className={cn("h-full min-h-0 transition-opacity duration-ui-layout motion-reduce:transition-none", dimSecond ? "opacity-ui-disabled" : "opacity-ui-visible")}
          inert={dimSecond}
        >
          {second}
        </div>
        {dimSecond && onFocusSecond ? (
          <button
            type="button"
            className="ui-focus-ring absolute inset-0 rounded-ui-xl"
            aria-label={`Focus ${secondLabel}`}
            onClick={onFocusSecond}
          />
        ) : null}
      </section>
    </div>
  );
}
