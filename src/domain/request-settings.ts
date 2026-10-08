import { z } from "zod";

export const requestSettingsSchema = z.strictObject({
  followRedirects: z.boolean(),
  maxRedirects: z.number().int().min(0).max(50),
  timeoutMs: z.number().int().min(1).max(3_600_000),
  validateTlsCertificates: z.boolean(),
  httpVersion: z.enum(["auto", "http1", "http2"]),
  storeCookies: z.boolean(),
});
export type RequestSettings = z.infer<typeof requestSettingsSchema>;
export const defaultRequestSettings: Readonly<RequestSettings> = {
  followRedirects: true,
  maxRedirects: 10,
  timeoutMs: 60_000,
  validateTlsCertificates: true,
  httpVersion: "auto",
  storeCookies: true,
};

/** Older local records may omit settings; recover valid fields independently. */
export function normalizeRequestSettings(value: unknown): Partial<RequestSettings> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entries = Object.entries(requestSettingsSchema.shape).flatMap(([key, schema]) => {
    const parsed = schema.safeParse((value as Record<string, unknown>)[key]);
    return parsed.success ? [[key, parsed.data]] : [];
  });
  return entries.length ? Object.fromEntries(entries) as Partial<RequestSettings> : undefined;
}
