import { forwardRef, useRef, type UIEvent } from "react";

import { Input, type InputProps } from "../../../shared/components/ui/input";
import { cn } from "../../../shared/lib/cn";

type UrlPart = {
  kind: "protocol" | "base" | "path" | "query";
  value: string;
};

function splitUrl(value: string): UrlPart[] {
  if (!value) return [];
  const queryAt = value.indexOf("?");
  const main = queryAt < 0 ? value : value.slice(0, queryAt);
  const query = queryAt < 0 ? "" : value.slice(queryAt);
  const protocol = main.match(/^https?:\/\//i)?.[0] ?? "";
  const remainder = main.slice(protocol.length);
  const slash = remainder.indexOf("/");
  const baseLength = slash < 0 ? remainder.length : slash;
  const base = remainder.slice(0, baseLength);
  const path = remainder.slice(baseLength);
  return [
    ...(protocol ? [{ kind: "protocol" as const, value: protocol }] : []),
    ...(base ? [{ kind: "base" as const, value: base }] : []),
    ...(path ? [{ kind: "path" as const, value: path }] : []),
    ...(query ? [{ kind: "query" as const, value: query }] : []),
  ];
}

function partClass(kind: UrlPart["kind"]) {
  if (kind === "query") return "text-accent-orange";
  if (kind === "protocol") return "text-action-emerald";
  if (kind === "base") return "text-syntax-property";
  return "text-syntax-attribute";
}

function colorizedPart(part: UrlPart) {
  if (part.kind === "path") {
    return part.value.split(/(:[A-Za-z_][A-Za-z0-9_-]*|graphql)/gi).map((value, index) => value.startsWith(":")
      ? <span key={`${value}-${index}`} data-url-accent="path-param" className="text-accent-orange">{value}</span>
      : value.toLowerCase() === "graphql"
        ? <span key={`${value}-${index}`} data-url-accent="graphql" className="text-action-graphql">{value}</span>
        : value);
  }
  return part.value.split(/(graphql)/gi).map((value, index) => value.toLowerCase() === "graphql"
    ? <span key={`${value}-${index}`} data-url-accent="graphql" className="text-action-graphql">{value}</span>
    : value);
}

export type ColorizedUrlInputProps = Omit<InputProps, "value"> & {
  value: string;
};

export const ColorizedUrlInput = forwardRef<HTMLInputElement, ColorizedUrlInputProps>(function ColorizedUrlInput({ value, className, onScroll, ...props }, ref) {
  const colorized = useRef<HTMLDivElement>(null);
  const handleScroll = (event: UIEvent<HTMLInputElement>) => {
    if (colorized.current) colorized.current.scrollLeft = event.currentTarget.scrollLeft;
    onScroll?.(event);
  };
  return <div className="relative h-control-md min-w-0 flex-1 overflow-hidden rounded-ui-lg">
    {value ? <div ref={colorized} aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center overflow-hidden px-ui-3 font-code text-ui-sm sm:text-ui-md">
      <span className="whitespace-pre">
        {splitUrl(value).map((part, index) => <span key={`${part.kind}-${index}`} data-url-part={part.kind} className={partClass(part.kind)}>{colorizedPart(part)}</span>)}
      </span>
    </div> : null}
    <Input
      {...props}
      ref={ref}
      value={value}
      variant="transparent"
      onScroll={handleScroll}
      className={cn("relative h-control-md min-w-0 flex-1 font-code text-transparent caret-content-primary text-ui-sm sm:text-ui-md", className)}
    />
  </div>;
});
