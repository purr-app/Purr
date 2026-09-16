import { z } from "zod";

const attributeScalarSchema = z.union([z.string().max(1024), z.boolean(), z.number().finite()]);
const attributeValueSchema = z.union([attributeScalarSchema, z.array(attributeScalarSchema).max(32)]);

const spanSchema = z.object({
  id: z.string().max(64), parentSpanId: z.string().max(64).nullable(),
  service: z.string().max(256), operation: z.string().max(256),
  startedAtUs: z.number().int().nonnegative(), durationUs: z.number().int().nonnegative(),
  status: z.enum(["unset", "ok", "error"]),
  attributes: z.record(z.string().max(128), attributeValueSchema).refine((value) => Object.keys(value).length <= 32),
}).strict();
export const tracePageSchema = z.object({
  protocolVersion: z.literal(1), traceId: z.string().max(32).nullable(),
  spans: z.array(spanSchema).max(25), total: z.number().int().min(0).max(1000),
  nextCursor: z.string().max(100).nullable(), cached: z.boolean(),
}).strict();
export const integrationSummariesSchema = z.array(z.object({
  id: z.string().max(128), name: z.string().max(256), enabled: z.boolean(), available: z.boolean(),
}).strict()).max(128);
export type TracePage = z.infer<typeof tracePageSchema>;
export type IntegrationSummary = z.infer<typeof integrationSummariesSchema>[number];
export type TraceQuery = {
  workspaceId: string; integrationId: string; documentId: string; startedAtMs: number;
  manualTraceId: string | null; search: string; cursor: string | null;
};
