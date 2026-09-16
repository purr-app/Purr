import type { IntegrationSummary, TracePage, TraceQuery } from "../../domain/observability";

export interface ObservabilityPort {
  validateConfig(provider: string, version: number, config: Record<string, unknown>): Promise<Record<string, unknown>>;
  integrations(workspaceId: string): Promise<IntegrationSummary[]>;
  trace(query: TraceQuery, signal: AbortSignal): Promise<TracePage>;
}
