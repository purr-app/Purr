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
