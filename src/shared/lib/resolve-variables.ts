import { templateTokens } from "../../domain/template-expression";

export function resolveEnvironmentValue(value: string, variables: Record<string, string>, stack: string[] = []): string {
  let cursor = 0;
  let result = "";
  for (const token of templateTokens(value)) {
    const key = token.name;
    if (!Object.prototype.hasOwnProperty.call(variables, key)) throw new Error(`Variable “${key}” is not defined.`);
    if (stack.includes(key) || stack.length >= 32) throw new Error(`Variable “${key}” contains a circular reference.`);
    result += value.slice(cursor, token.from) + resolveEnvironmentValue(variables[key], variables, [...stack, key]);
    cursor = token.to;
  }
  return result + value.slice(cursor);
}
