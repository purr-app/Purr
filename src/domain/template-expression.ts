/** Template spans are syntax only; never resolve values while rendering an editor. */
export function templateTokens(value: string) {
  return [...value.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match) => ({
    from: match.index!, to: match.index! + match[0].length,
    text: match[0], name: match[1].trim(),
  }));
}

export function templateSegments(value: string, maskLiterals = false) {
  const segments: { text: string; variable: boolean }[] = [];
  let from = 0;
  const literal = (text: string) => ({ text: maskLiterals ? text.replace(/[^\s]/g, "•") : text, variable: false });
  for (const token of templateTokens(value)) {
    if (token.from > from) segments.push(literal(value.slice(from, token.from)));
    segments.push({ text: token.text, variable: true });
    from = token.to;
  }
  if (from < value.length) segments.push(literal(value.slice(from)));
  return segments;
}

/** Preserve original whitespace; exactly one nonempty reference is public syntax. */
export function isPureTemplateReference(value: string): boolean {
  const tokens = templateTokens(value);
  if (tokens.length !== 1 || !tokens[0].name) return false;
  const token = tokens[0];
  return !value.slice(0, token.from).trim() && !value.slice(token.to).trim();
}

export type ExpressionClassification = { kind: "template"; value: string; name: string } | { kind: "literal" | "mixed"; value: string };
export function classifyExpression(value: string): ExpressionClassification {
  const tokens = templateTokens(value);
  if (isPureTemplateReference(value)) return { kind: "template", value, name: tokens[0].name };
  return { kind: tokens.length ? "mixed" : "literal", value };
}
