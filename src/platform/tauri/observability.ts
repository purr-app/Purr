import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { ObservabilityPort } from "../../application/ports/observability";
import { integrationSummariesSchema, tracePageSchema } from "../../domain/observability";

export const tauriObservability: ObservabilityPort = {
  async validateConfig(provider, version, config) {
    return z.record(z.string(), z.unknown()).parse(await invoke("observability_validate_config", { provider, version, config }));
  },
  async integrations(workspaceId) {
    return integrationSummariesSchema.parse(await invoke("observability_integrations", { workspaceId }));
  },
  async trace(query, signal) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const operationId = crypto.randomUUID();
    const cancel = () => { void invoke("cancel_observability", { operationId }).catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const value = await invoke("observability_trace", { operationId, query });
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      return tracePageSchema.parse(value);
    } finally { signal.removeEventListener("abort", cancel); }
  },
};
