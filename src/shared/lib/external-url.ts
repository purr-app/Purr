/** Restrict external navigation to browser URLs without embedded credentials. */
export function externalHttpUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("The provider browser URL must use HTTP or HTTPS without embedded credentials.");
  return url.href;
}
