import type { IntegrationSummary, TracePage, TraceQuery } from "../../domain/observability";

export interface ObservabilityPort {
  integrations(workspaceId: string): Promise<IntegrationSummary[]>;
  trace(query: TraceQuery, signal: AbortSignal): Promise<TracePage>;
}
