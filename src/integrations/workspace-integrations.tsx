import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { IntegrationDefinition } from "../domain/project";
import type { IntegrationSummary } from "../domain/observability";
import type { AuthContext } from "../features/request-workbench/model/request-auth";
import { useApplicationServices } from "../app/application-services-context";
import { useExtensionRegistry } from "../extension-api/extension-context";

type WorkspaceIntegrations = {
  definitions: readonly IntegrationDefinition[];
  traces: readonly IntegrationSummary[];
  authContext: AuthContext;
  addProvider: () => void;
};
const Context = createContext<WorkspaceIntegrations>({ definitions: [], traces: [], authContext: {}, addProvider: () => {} });
export const useWorkspaceIntegrations = () => useContext(Context);
export function WorkspaceIntegrationsProvider({ workspaceId, definitions, authContext, addProvider, children }: Omit<WorkspaceIntegrations, "traces"> & { workspaceId: string; children: ReactNode }) {
  const { observability } = useApplicationServices();
  const extensions = useExtensionRegistry();
  const [summaries, setSummaries] = useState<IntegrationSummary[]>([]);
  useEffect(() => {
    let live = true;
    observability.integrations(workspaceId).then((items) => { if (live) setSummaries(items); }).catch(() => { if (live) setSummaries([]); });
    return () => { live = false; };
  }, [observability, workspaceId, definitions]);
  const traces = useMemo(() => definitions.flatMap((item) => {
    const summary = summaries.find((entry) => entry.id === item.id);
    const capabilities = summary?.capabilities ?? extensions.integration(item.provider)?.capabilities ?? [];
    return capabilities.includes("traces") ? [{ id: item.id, name: item.name, enabled: item.enabled,
      available: summary?.available ?? Boolean(extensions.integration(item.provider)), capabilities: [...capabilities] }] : [];
  }), [definitions, summaries, extensions]);
  return <Context.Provider value={{ definitions, traces, authContext, addProvider }}>{children}</Context.Provider>;
}
