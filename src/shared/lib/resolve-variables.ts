export function resolveEnvironmentValue(value: string, variables: Record<string, string>, stack: string[] = []): string {
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) throw new Error(`Environment variable “${key}” is not defined.`);
    if (stack.includes(key) || stack.length >= 32) throw new Error(`Environment variable “${key}” contains a circular reference.`);
    return resolveEnvironmentValue(variables[key], variables, [...stack, key]);
  });
}
