import { Fragment, useMemo } from "react";
import { cn } from "../../shared/lib/cn";
import { alignedTextLines, changedTextRanges, syntaxRanges, type AlignedLine, type DiffLanguage, type SyntaxRange, type TextRange } from "./diff-text";
import type { SemanticSide } from "./semantic-value";

// Ranges are ordered and non-overlapping. Bound work to this line, even for large payloads.
function lineRanges<T extends TextRange>(ranges: T[], from: number, to: number): T[] {
  let low = 0, high = ranges.length;
  while (low < high) { const mid = (low + high) >>> 1; if (ranges[mid].to <= from) low = mid + 1; else high = mid; }
  const result: T[] = [];
  for (let i = low; i < ranges.length && ranges[i].from < to; i++) result.push(ranges[i]);
  return result;
}
function Tokens({ text, offset = 0, changes, syntax, side }: { text: string; offset?: number; changes: TextRange[]; syntax: SyntaxRange[]; side: SemanticSide }) {
  const end = offset + text.length;
  changes = lineRanges(changes, offset, end); syntax = lineRanges(syntax, offset, end);
  const points = [...new Set([offset, end, ...[...changes, ...syntax].flatMap((range) => [range.from, range.to]).filter((point) => point > offset && point < end)])].sort((a, b) => a - b);
  let syntaxIndex = 0, changeIndex = 0;
  return <>{points.slice(0, -1).map((from, index) => {
    const to = points[index + 1];
    while (syntaxIndex < syntax.length && syntax[syntaxIndex].to <= from) syntaxIndex++;
    while (changeIndex < changes.length && changes[changeIndex].to <= from) changeIndex++;
    const token = syntax[syntaxIndex]?.from <= from ? syntax[syntaxIndex] : undefined;
    const fragment = text.slice(from - offset, to - offset);
    const changed = changes[changeIndex]?.from <= from && !/^[\s"'`,:]+$/.test(fragment);
    const content = <span className={token?.className}>{fragment}</span>;
    return changed ? <mark key={from} data-diff={side === "before" ? "removed" : "added"} className={cn("rounded-ui-sm text-content-primary", side === "before" ? "bg-syntax-diff-removed" : "bg-syntax-diff-added")}>{content}</mark> : <Fragment key={from}>{content}</Fragment>;
  })}</>;
}
export function ChangeIndicator({ side, label }: { side: SemanticSide; label: string }) {
  return <span aria-label={label} className={cn("inline-block w-ui-3 shrink-0 select-none font-code text-ui-xs", side === "before" ? "text-syntax-diff-removed-text" : "text-syntax-diff-added-text")}>{side === "before" ? "−" : "+"}</span>;
}
export function InlineDiffText({ value, other, side, single }: { value: string; other: string; side: SemanticSide; single?: SemanticSide }) {
  const model = useMemo(() => {
    const changes = single ? { before: [], after: [] } : side === "before" ? changedTextRanges(value, other) : changedTextRanges(other, value);
    const ranges = changes[side];
    const changedLength = [...changes.before, ...changes.after].reduce((sum, range) => sum + range.to - range.from, 0);
    return { ranges, replaced: changedLength > (value.length + other.length) * 0.65 };
  }, [value, other, side, single]);
  if (model.replaced) return <span data-scalar-change={side} className={side === "before" ? "text-syntax-diff-removed-text" : "text-syntax-diff-added-text"}>{value}</span>;
  return <Tokens text={value} changes={model.ranges} syntax={[]} side={side} />;
}
const languageLabel = (language: DiffLanguage) => ({ text: "Content", json: "JSON", graphql: "GraphQL", xml: "XML" })[language];
const contentLines = (content: string) => {
  let from = 0;
  return content.split("\n").map((text) => { const line = { text, from }; from += text.length + 1; return line; });
};
function mostlyReplaced(source: string, changes: TextRange[]) {
  const meaningful = (text: string) => text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  const total = meaningful(source);
  return total > 16 && changes.reduce((sum, range) => sum + meaningful(source.slice(range.from, range.to)), 0) / total > 0.7;
}

/** Lightweight code: whole additions/replacements, unmatched lines, then inline edits. */
export function CodeComparison({ before, after, language = "text", beforeLanguage = language, afterLanguage = language, single, replacement = false }: { before: string; after: string; language?: DiffLanguage; beforeLanguage?: DiffLanguage; afterLanguage?: DiffLanguage; single?: SemanticSide; replacement?: boolean }) {
  const model = useMemo(() => {
    const changes = single ? { before: [], after: [] } : changedTextRanges(before, after, language);
    const changed = changes.before.length > 0 || changes.after.length > 0;
    const wholeMultilineAddition = (!before.trim() || !after.trim()) && (before.includes("\n") || after.includes("\n"));
    const replaced = !single && (replacement || beforeLanguage !== afterLanguage || wholeMultilineAddition || mostlyReplaced(before, changes.before) && mostlyReplaced(after, changes.after));
    const lines: AlignedLine[] = single ? contentLines(single === "before" ? before : after).map((line) => ({ [single]: line })) : alignedTextLines(before, after, language);
    return {
      changed, replaced,
      before: syntaxRanges(before, beforeLanguage), after: syntaxRanges(after, afterLanguage),
      lines: lines.map((row) => {
        const local = changed && row.before && row.after && row.matched !== false ? changedTextRanges(row.before.text, row.after.text, language) : { before: [], after: [] };
        const shifted = (side: SemanticSide) => local[side].map((range) => ({ from: range.from + (row[side]?.from ?? 0), to: range.to + (row[side]?.from ?? 0) }));
        return { ...row, changes: { before: shifted("before"), after: shifted("after") } };
      }),
    };
  }, [before, after, language, beforeLanguage, afterLanguage, single, replacement]);
  const sides: SemanticSide[] = single ? [single] : ["before", "after"];
  const label = language === "graphql" ? "GraphQL comparison" : language === "json" ? "JSON comparison" : "Content comparison";
  if (model.replaced) return <div role="group" aria-label={label} data-content-replacement className="grid grid-cols-2 divide-x divide-border-subtle py-ui-3">
    {sides.map((side) => <div key={side} data-side={side} className="min-w-0 px-ui-4">
      <div className="mb-ui-2 flex items-center gap-ui-1 text-ui-xs text-content-secondary"><ChangeIndicator side={side} label={side === "before" ? "Removed content" : "Added content"} />{languageLabel(side === "before" ? beforeLanguage : afterLanguage)}</div>
      <div className="font-code text-ui-sm leading-relaxed text-content-primary">{contentLines(side === "before" ? before : after).map((line) => <div key={line.from} className="whitespace-pre-wrap break-words"><Tokens text={line.text} offset={line.from} changes={[]} syntax={model[side]} side={side} />{!line.text && "\u00a0"}</div>)}</div>
    </div>)}
  </div>;
  return <div role="group" aria-label={label} className="py-ui-3">
    {model.lines.map((row, index) => <div key={index} className={cn("grid", single ? "grid-cols-1" : "grid-cols-2")}>
      {sides.map((side) => {
        const line = row[side], other = row[side === "before" ? "after" : "before"];
        const unmatched = !other || row.matched === false;
        const lineChanged = !single && model.changed && line && unmatched && /[\p{L}\p{N}]/u.test(line.text);
        return <div key={side} data-side={side} data-line-change={lineChanged ? side === "before" ? "removed" : "added" : undefined} className={cn("flex min-w-0 gap-ui-1 px-ui-4 font-code text-ui-sm leading-relaxed text-content-primary", side === "after" && !single && "border-l border-border-subtle", lineChanged && (side === "before" ? "bg-syntax-diff-removed-line" : "bg-syntax-diff-added-line"))}>
          {!single && (lineChanged ? <ChangeIndicator side={side} label={side === "before" ? "Removed line" : "Added line"} /> : <span aria-hidden className="w-ui-3 shrink-0" />)}
          <span className="min-w-0 whitespace-pre-wrap break-words">{line ? <Tokens text={line.text} offset={line.from} changes={single || lineChanged || unmatched ? [] : row.changes[side]} syntax={model[side]} side={side} /> : "\u00a0"}{line?.text === "" ? "\u00a0" : ""}</span>
        </div>;
      })}
    </div>)}
  </div>;
}
