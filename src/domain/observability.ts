import { z } from "zod";

const attributeScalarSchema = z.union([z.string().max(4096), z.boolean(), z.number().finite()]);
const attributeValueSchema = z.union([attributeScalarSchema, z.array(attributeScalarSchema).max(128)]);

const spanSchema = z.object({
  id: z.string().min(1).max(64), parentSpanId: z.string().min(1).max(64).nullable(),
  service: z.string().max(256), operation: z.string().max(256),
  startedAtUs: z.number().int().nonnegative(), durationUs: z.number().int().nonnegative(),
  status: z.enum(["unset", "ok", "error"]),
  attributes: z.record(z.string().max(128), attributeValueSchema).refine((value) => Object.keys(value).length <= 256),
}).strict();
export const tracePageSchema = z.object({
  protocolVersion: z.literal(2), traceId: z.string().max(32).nullable(),
  spans: z.array(spanSchema).max(25), total: z.number().int().min(0).max(50000),
  timing: z.object({ startedAtUs: z.number().int().nonnegative(), durationUs: z.number().int().nonnegative() }).strict().optional(),
  nextCursor: z.string().max(100).nullable(), cached: z.boolean(),
  correlation: z.object({ injectedTraceId: z.string().max(32).nullable(),
    lookupReference: z.object({ id: z.string().max(32), source: z.string().max(64), format: z.string().max(128) }).strict().nullable(),
    resolvedTraceId: z.string().max(32).nullable() }).strict(),
  rows: z.array(z.object({ spanId: z.string().max(64), depth: z.number().int().min(0).max(49999), hasChildren: z.boolean(), matchesSearch: z.boolean() }).strict()).max(25),
}).strict().refine((page) => page.traceId === page.correlation.resolvedTraceId
  && page.rows.length === page.spans.length && page.total >= page.rows.length
  && new Set(page.rows.map((row) => row.spanId)).size === page.rows.length
  && page.rows.every((row, index) => row.spanId === page.spans[index].id), "Inconsistent normalized trace page");
export const integrationSummariesSchema = z.array(z.object({
  id: z.string().max(128), name: z.string().max(256), enabled: z.boolean(), available: z.boolean(),
  capabilities: z.array(z.string().max(64)).max(16),
}).strict()).max(128);
export type TracePage = z.infer<typeof tracePageSchema>;
export type TraceSpan = TracePage["spans"][number];
export type TraceRow = TracePage["rows"][number];
export type IntegrationSummary = z.infer<typeof integrationSummariesSchema>[number];
export type TraceQuery = {
  workspaceId: string; integrationId: string; documentId: string; startedAtMs: number;
  connection?: { endpoint: string; headers: [string, string][] };
  manualTraceId: string | null; search: string; cursor: string | null;
};
