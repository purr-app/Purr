import type { IntegrationDefinition } from "../domain/project";
import type { IntegrationPresentationContribution } from "./contracts";
import { resolveEnvironmentValue } from "../shared/lib/resolve-variables";
import { externalHttpUrl } from "../shared/lib/external-url";

export function integrationTraceUrl(integration: IntegrationDefinition, provider: IntegrationPresentationContribution, traceId: string, variables: Record<string, string> = {}): string {
  if (!provider.traceUrl || !/^(?:[a-f0-9]{16}|[a-f0-9]{32})$/i.test(traceId) || /^0+$/.test(traceId)) throw new Error("This provider does not have a valid browser trace link.");
  const config = { ...integration.config };
  for (const [key, value] of Object.entries(config)) if (typeof value === "string") config[key] = resolveEnvironmentValue(value, variables);
  return externalHttpUrl(provider.traceUrl(config, traceId));
}
