import { useEffect, useState } from "react";
import type { SchemaDocument } from "../../workspaces/model/workspace";
import type { WorkspaceRequestConfig } from "../../request-workbench/model/request-workspace-config";
import { schemaConnectionIdentity, schemaConnectionStatus, type SchemaConnectionStatus } from "../model/schema-connection";
import { cn } from "../../../shared/lib/cn";

export function useSchemaConnectionStatus(connection: SchemaDocument, config: WorkspaceRequestConfig, variables: Record<string, string>, environmentId: string | null) {
  const [identity, setIdentity] = useState<string>();
  useEffect(() => {
    let active = true;
    void schemaConnectionIdentity(connection, config, variables, environmentId).then((value) => { if (active) setIdentity(value); }).catch(() => { if (active) setIdentity("unresolved"); });
    return () => { active = false; };
  }, [connection, config, variables, environmentId]);
  return schemaConnectionStatus(connection, identity);
}
export function SchemaStatusDot({ status }: { status: SchemaConnectionStatus }) {
  return <span role="img" aria-label={status} title={status} className={cn("inline-block size-ui-2 shrink-0 rounded-full",
    status === "Loaded" ? "bg-action-emerald" : status === "Error" ? "bg-accent-red" : status === "Stale" ? "bg-accent-orange"
      : status === "Loading" ? "animate-pulse bg-action-graphql" : "bg-content-tertiary")} />;
}
export function ConnectionStatus({ connection, config, variables, environmentId }: { connection: SchemaDocument; config: WorkspaceRequestConfig; variables: Record<string, string>; environmentId: string | null }) {
  const status = useSchemaConnectionStatus(connection, config, variables, environmentId);
  return <SchemaStatusDot status={status} />;
}
