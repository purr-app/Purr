import { diff, Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { graphqlLanguage } from "cm6-graphql";
import { jsonLanguage } from "@codemirror/lang-json";
import { xmlLanguage } from "@codemirror/lang-xml";
import { highlightTree } from "@lezer/highlight";
import { Lexer, Source, TokenKind, parse, visit, type ASTNode } from "graphql";
import { purrReadOnlyHighlighting } from "../../shared/theme/code-editor-theme";
import { equalGraphql, equalJson } from "./graphql-diff";

export type DiffLanguage = "text" | "graphql" | "json" | "xml";
export type TextRange = { from: number; to: number };
export type SyntaxRange = TextRange & { className: string };
const limits = { scanLimit: 5000, timeout: 50 };
function graphqlTokens(text: string) {
  const lexer = new Lexer(new Source(text)); const tokens: { from: number; to: number; key: string }[] = [];
  for (let token = lexer.advance(); token.kind !== TokenKind.EOF; token = lexer.advance()) tokens.push({ from: token.start, to: token.end, key: JSON.stringify([token.kind, token.value]) });
  return tokens;
}
function trimCodeRanges(source: string, ranges: TextRange[]): TextRange[] {
  return ranges.flatMap(({ from, to }) => {
    while (from < to && /[\s"'`]/.test(source[from])) from++;
    while (to > from && /[\s"'`]/.test(source[to - 1])) to--;
    return from < to ? [{ from, to }] : [];
  });
}
/** Semantic GraphQL ignores whitespace/comments, but preserves selection/argument order. */
export function changedTextRanges(before: string, after: string, language: DiffLanguage = "text"): { before: TextRange[]; after: TextRange[] } {
  if (before === after || language === "graphql" && equalGraphql(before, after) || language === "json" && equalJson(before, after)) return { before: [], after: [] };
  if (language === "graphql") {
    try {
      const a = graphqlTokens(before), b = graphqlTokens(after);
      // One code unit per complete token prevents a text diff matching pieces of
      // unrelated token names or consuming the punctuation around an insertion.
      const alphabet = new Map<string, string>();
      const encode = (tokens: typeof a) => tokens.map((token) => {
        if (!alphabet.has(token.key)) {
          if (alphabet.size >= 0xd700) throw new Error("Token limit");
          alphabet.set(token.key, String.fromCharCode(0x100 + alphabet.size));
        }
        return alphabet.get(token.key)!;
      }).join("");
      const changes = diff(encode(a), encode(b), limits);
      return { before: trimCodeRanges(before, changes.flatMap((change) => a.slice(change.fromA, change.toA).map(({ from, to }) => ({ from, to })))), after: trimCodeRanges(after, changes.flatMap((change) => b.slice(change.fromB, change.toB).map(({ from, to }) => ({ from, to })))) };
    } catch { /* Incomplete queries still get bounded, precise text comparison. */ }
  }
  const changes = diff(before, after, limits);
  const ranges = { before: changes.filter((c) => c.toA > c.fromA).map((c) => ({ from: c.fromA, to: c.toA })), after: changes.filter((c) => c.toB > c.fromB).map((c) => ({ from: c.fromB, to: c.toB })) };
  if (language !== "json") return language === "text" ? ranges : { before: trimCodeRanges(before, ranges.before), after: trimCodeRanges(after, ranges.after) };
  // JSON scalar tokens (e.g. 10 → 20) are more meaningful than a changed digit.
  const expand = (source: string, changed: TextRange[]) => {
    const tokens = syntaxRanges(source, "json");
    return changed.map((range) => {
      const touched = tokens.filter((token) => token.from < range.to && token.to > range.from);
      return { from: Math.min(range.from, touched[0]?.from ?? range.from), to: Math.max(range.to, touched[touched.length - 1]?.to ?? range.to) };
    }).reduce<TextRange[]>((merged, range) => {
      const last = merged[merged.length - 1];
      if (last && last.to >= range.from) last.to = Math.max(last.to, range.to); else merged.push(range);
      return merged;
    }, []);
  };
  return { before: trimCodeRanges(before, expand(before, ranges.before)), after: trimCodeRanges(after, expand(after, ranges.after)) };
}
export function syntaxRanges(text: string, language: DiffLanguage): SyntaxRange[] {
  if (language === "text") return [];
  const tokens: SyntaxRange[] = [];
  const parser = language === "graphql" ? graphqlLanguage.parser : language === "xml" ? xmlLanguage.parser : jsonLanguage.parser;
  highlightTree(parser.parse(text), purrReadOnlyHighlighting, (from, to, className) => tokens.push({ from, to, className }));
  return tokens;
}
export type DiffLine = { text: string; from: number };
export type AlignedLine = { before?: DiffLine; after?: DiffLine; matched?: boolean };
function sequenceChanges(before: string[], after: string[]) {
  const alphabet = new Map<string, string>();
  const encode = (keys: string[]) => keys.map((key) => {
    if (!alphabet.has(key)) {
      if (alphabet.size >= 0xd700) throw new Error("Line signature limit");
      alphabet.set(key, String.fromCharCode(0x100 + alphabet.size));
    }
    return alphabet.get(key)!;
  }).join("");
  return diff(encode(before), encode(after), limits);
}
function graphqlLineKeys(source: string, doc: Text): Map<number, string> {
  const keys = new Map<number, string>();
  const identity = (node: ASTNode): string | undefined => {
    switch (node.kind) {
      case "OperationDefinition": return `operation:${node.operation}:${node.name?.value ?? ""}`;
      case "FragmentDefinition": return `fragment:${node.name.value}`;
      case "Field": return `field:${node.alias?.value ?? node.name.value}`;
      case "Argument": return `argument:${node.name.value}`;
      case "Directive": return `directive:${node.name.value}`;
      case "InlineFragment": return `inline:${node.typeCondition?.name.value ?? ""}`;
      case "FragmentSpread": return `spread:${node.name.value}`;
      case "VariableDefinition": return `variable:${node.variable.name.value}`;
    }
  };
  try {
    visit(parse(source), { enter(node, _key, _parent, _path, ancestors) {
      const key = identity(node);
      if (!key || !node.loc) return;
      const line = doc.lineAt(node.loc.start);
      if (source.slice(line.from, node.loc.start).trim()) return;
      const parents = ancestors.flatMap((parent) => Array.isArray(parent) ? [] : identity(parent as ASTNode) ?? []);
      keys.set(line.from, [...parents, key].join("/"));
    } });
  } catch { /* Incomplete GraphQL uses line signatures and bounded text comparison. */ }
  return keys;
}
function lineKey(line: DiffLine, language: DiffLanguage, graphqlKeys: Map<number, string>): string {
  if (language === "graphql") return graphqlKeys.get(line.from) ?? `graphql:${line.text.trim().match(/^(?:\.\.\.)?([\w]+)\s*[:(@]?/)?.[1] ?? line.text.trim()}`;
  if (language === "json") return `json:${line.text.trim().match(/^("(?:[^"\\]|\\.)*")\s*:/)?.[1] ?? "item"}`;
  if (language === "xml") return `xml:${line.text.trim().match(/^<(\/?[\w:.-]+)/)?.[1] ?? "text"}`;
  return "text";
}
/** Pair unchanged lines, then pad changed chunks so both sides share row heights. */
export function alignedTextLines(before: string, after: string, language: DiffLanguage = "text"): AlignedLine[] {
  const a = Text.of(before.split("\n")), b = Text.of(after.split("\n"));
  const chunks = Chunk.build(a, b, limits), rows: AlignedLine[] = [];
  const keysA = language === "graphql" ? graphqlLineKeys(before, a) : new Map<number, string>();
  const keysB = language === "graphql" ? graphqlLineKeys(after, b) : new Map<number, string>();
  const lines = (doc: Text, from: number, to: number): DiffLine[] => {
    const result: DiffLine[] = [];
    if (from >= to || from > doc.length) return result;
    for (let number = doc.lineAt(Math.min(from, doc.length)).number; number <= doc.lines; number++) {
      const line = doc.line(number); if (line.from >= to) break;
      result.push({ text: line.text, from: line.from });
    }
    return result;
  };
  const append = (left: DiffLine[], right: DiffLine[], matched = true) => { for (let i = 0; i < Math.max(left.length, right.length); i++) rows.push({ before: left[i], after: right[i], matched }); };
  const appendChanged = (left: DiffLine[], right: DiffLine[]) => {
    if (language === "text") { append(left, right); return; }
    let changes;
    try { changes = sequenceChanges(left.map((line) => lineKey(line, language, keysA)), right.map((line) => lineKey(line, language, keysB))); }
    catch { append(left, right, false); return; }
    let fromA = 0, fromB = 0;
    for (const change of changes) {
      append(left.slice(fromA, change.fromA), right.slice(fromB, change.fromB));
      append(left.slice(change.fromA, change.toA), right.slice(change.fromB, change.toB), false);
      fromA = change.toA; fromB = change.toB;
    }
    append(left.slice(fromA), right.slice(fromB));
  };
  let fromA = 0, fromB = 0;
  for (const chunk of chunks) {
    append(lines(a, fromA, chunk.fromA), lines(b, fromB, chunk.fromB));
    appendChanged(lines(a, chunk.fromA, chunk.toA), lines(b, chunk.fromB, chunk.toB));
    fromA = chunk.toA; fromB = chunk.toB;
  }
  append(lines(a, fromA, a.length + 1), lines(b, fromB, b.length + 1));
  return rows;
}
