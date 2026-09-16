import type { HttpTransportPort } from "../application/ports/http";
import type { ResponseContentPort } from "../application/ports/response-content";
import type { JsonObject } from "../domain/project";

export type AttributeValue = string | number | boolean | null | readonly AttributeValue[] | { readonly [key: string]: AttributeValue };
export type Page<T> = Readonly<{ items: readonly T[]; nextCursor?: string }>;
export type TraceReference = Readonly<{
  traceId: string;
  spanId?: string;
  integrationId?: string;
  source: "response-header" | "request-header" | "response-body" | "manual";
}>;
export type SpanEvent = Readonly<{ name: string; timestamp: string; attributes: Readonly<Record<string, AttributeValue>> }>;
export type Span = Readonly<{
  id: string; traceId: string; parentSpanId?: string; service: string; operation: string;
  startedAt: string; durationUs: number; status: "unset" | "ok" | "error";
  attributes: Readonly<Record<string, AttributeValue>>; events: readonly SpanEvent[];
}>;
export type Trace = Readonly<{
  id: string; startedAt: string; durationUs: number; rootService?: string; rootOperation?: string;
  status: "unset" | "ok" | "error"; spans: readonly Span[]; attributes: Readonly<Record<string, AttributeValue>>;
}>;
export type TraceSummary = Readonly<Pick<Trace, "id" | "startedAt" | "durationUs" | "rootService" | "rootOperation" | "status">>;
export type TraceSearchQuery = Readonly<{ from: string; to: string; service?: string; operation?: string; cursor?: string }>;

export interface TraceProvider {
  getTrace(reference: TraceReference, signal: AbortSignal): Promise<Trace | null>;
  searchTraces(query: TraceSearchQuery, signal: AbortSignal): Promise<Page<TraceSummary>>;
}

export type ExtensionLogger = Readonly<{
  debug(message: string, details?: Readonly<Record<string, unknown>>): void;
  info(message: string, details?: Readonly<Record<string, unknown>>): void;
  warn(message: string, details?: Readonly<Record<string, unknown>>): void;
  error(message: string, details?: Readonly<Record<string, unknown>>): void;
}>;

export type IntegrationCredentialResolver = Readonly<{ resolve(key: string): Promise<string> }>;
export type ProviderFactoryContext = Readonly<{
  http: HttpTransportPort;
  responseContent: ResponseContentPort;
  credentials: IntegrationCredentialResolver;
  logger: ExtensionLogger;
}>;

export type ValidatedIntegrationConfig = Readonly<{ configVersion: number; config: JsonObject }>;
export type IntegrationProviderContribution = Readonly<{
  id: string;
  label: string;
  configVersion: number;
  validateAndMigrate(configVersion: number, config: JsonObject): ValidatedIntegrationConfig;
}>;
export type TraceProviderContribution = Readonly<{
  id: string;
  integrationProviderId: string;
  create(context: ProviderFactoryContext): TraceProvider;
}>;
export type CorrelationInput = Readonly<{ requestHeaders: readonly [string, string][]; responseHeaders: readonly [string, string][] }>;
export type CorrelationExtractorContribution = Readonly<{
  id: string;
  extract(input: CorrelationInput): readonly TraceReference[];
}>;
