import { z } from "zod";

export type HttpHeader = [string, string];

// This snapshot describes the logical request shown in response history. The
// native transport DTO remains adapter-owned at the platform boundary.
export type HttpRequestSnapshot = {
  url: string;
  method: string;
  headers: HttpHeader[];
  bodyBase64: string | null;
};

export type HttpResponseMetadata = {
  url: string;
  status: number;
  statusText: string;
  headers: HttpHeader[];
  byteLength: number;
  durationMs: number;
  headersDurationMs?: number;
  downloadDurationMs?: number;
  httpVersion?: string;
  localAddress?: string;
  remoteAddress?: string;
};

export type HttpTimeline = {
  startedAtMs: number;
  prepareMs: number;
  waitingMs: number;
  downloadMs: number;
  completedAtMs: number;
  request: HttpRequestSnapshot;
  displayRequest?: HttpRequestSnapshot;
  followRedirects: boolean;
  usesCookieJar: boolean;
  timeoutMs: number;
  processing?: {
    setupMs: number;
    networkMs: number;
    encryptionMs: number;
    sqliteWriteMs: number;
    storageBackpressureMs: number;
    nativeTotalMs: number;
    ipcMs?: number;
    contentReadMs?: number;
    displayReadyMs?: number;
  };
};

// The ID is deliberately opaque. A platform adapter may interpret it as native
// encrypted content or as a browser/test object-store key; feature code may not.
export type ResponseContentRef = {
  id: string;
  byteLength: number;
  mediaType?: string;
  charset?: string;
  lineCount?: number;
  maxLineBytes?: number;
  complete: boolean;
};

export type HttpExchange = {
  protocolVersion: 2;
  request: HttpRequestSnapshot;
  response: HttpResponseMetadata;
  content: ResponseContentRef;
  timeline: HttpTimeline;
};

// Transitional materialized shape used by the current response UI. It is
// domain-owned so runtime models no longer import a feature service type.
export type InlineHttpResponse = {
  url: string;
  status: number;
  statusText: string;
  headers: HttpHeader[];
  bodyBase64: string;
  text: string;
  size: number;
  durationMs: number;
  headersDurationMs?: number;
  downloadDurationMs?: number;
  httpVersion?: string;
  localAddress?: string;
  remoteAddress?: string;
  timeline: HttpTimeline;
  // Phase 6 compatibility presentation. Persistence projects this field back
  // to the v2 exchange so native response bytes are never duplicated locally.
  sourceExchange?: HttpExchange;
};

export type StoredHttpResponse = InlineHttpResponse | HttpExchange;

const headerSchema = z.tuple([z.string(), z.string()]);
const requestSnapshotSchema = z.object({
  url: z.string(),
  method: z.string(),
  headers: z.array(headerSchema),
  bodyBase64: z.string().nullable(),
}).passthrough();
const timelineSchema = z.object({
  startedAtMs: z.number().finite(),
  prepareMs: z.number().finite(),
  waitingMs: z.number().finite(),
  downloadMs: z.number().finite(),
  completedAtMs: z.number().finite(),
  request: requestSnapshotSchema,
  displayRequest: requestSnapshotSchema.optional(),
  followRedirects: z.boolean(),
  usesCookieJar: z.boolean(),
  timeoutMs: z.number().finite(),
  processing: z.object({
    setupMs: z.number().finite().nonnegative(),
    networkMs: z.number().finite().nonnegative(),
    encryptionMs: z.number().finite().nonnegative(),
    sqliteWriteMs: z.number().finite().nonnegative(),
    storageBackpressureMs: z.number().finite().nonnegative(),
    nativeTotalMs: z.number().finite().nonnegative(),
    ipcMs: z.number().finite().nonnegative().optional(),
    contentReadMs: z.number().finite().nonnegative().optional(),
    displayReadyMs: z.number().finite().nonnegative().optional(),
  }).optional(),
}).passthrough();
const responseMetadataSchema = z.object({
  url: z.string(),
  status: z.number().finite(),
  statusText: z.string(),
  headers: z.array(headerSchema),
  byteLength: z.number().finite().nonnegative(),
  durationMs: z.number().finite(),
  headersDurationMs: z.number().finite().optional(),
  downloadDurationMs: z.number().finite().optional(),
  httpVersion: z.string().optional(),
  localAddress: z.string().optional(),
  remoteAddress: z.string().optional(),
}).passthrough();
const responseContentRefSchema = z.object({
  id: z.string().min(1),
  byteLength: z.number().finite().nonnegative(),
  mediaType: z.string().optional(),
  charset: z.string().optional(),
  lineCount: z.number().int().nonnegative().optional(),
  maxLineBytes: z.number().int().nonnegative().optional(),
  complete: z.boolean(),
}).passthrough();
const httpExchangeSchema = z.object({
  protocolVersion: z.literal(2),
  request: requestSnapshotSchema,
  response: responseMetadataSchema,
  content: responseContentRefSchema,
  timeline: timelineSchema,
}).passthrough();
const inlineHttpResponseSchema = z.object({
  url: z.string(),
  status: z.number().finite(),
  statusText: z.string(),
  headers: z.array(headerSchema),
  bodyBase64: z.string(),
  text: z.string(),
  size: z.number().finite().nonnegative(),
  durationMs: z.number().finite(),
  headersDurationMs: z.number().finite().optional(),
  downloadDurationMs: z.number().finite().optional(),
  httpVersion: z.string().optional(),
  localAddress: z.string().optional(),
  remoteAddress: z.string().optional(),
  timeline: timelineSchema,
}).passthrough();

export function createInlineHttpResponse(response: InlineHttpResponse): InlineHttpResponse {
  return response;
}

export function isInlineHttpResponse(response: StoredHttpResponse): response is InlineHttpResponse {
  return "text" in response && typeof response.text === "string"
    && "bodyBase64" in response && typeof response.bodyBase64 === "string";
}

export function responseForPersistence(response: StoredHttpResponse): StoredHttpResponse {
  return isInlineHttpResponse(response) && response.sourceExchange
    ? response.sourceExchange
    : response;
}

export function storedHttpResponseStartedAt(response: StoredHttpResponse) {
  return response.timeline.startedAtMs;
}

// Local records are untrusted and predate an explicit response schema. Invalid
// history entries are ignored so damaged local state cannot block a workspace.
export function restoreStoredHttpResponse(value: unknown): StoredHttpResponse | null {
  const referenced = httpExchangeSchema.safeParse(value);
  if (referenced.success) return referenced.data as HttpExchange;
  const inline = inlineHttpResponseSchema.safeParse(value);
  return inline.success ? inline.data as InlineHttpResponse : null;
}
