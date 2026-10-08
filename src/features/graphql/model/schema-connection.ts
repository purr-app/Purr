import { resolveEnvironmentValue } from "../../../shared/lib/resolve-variables";
import type { SchemaDocument } from "../../workspaces/model/workspace";
import { resolveAuth } from "../../request-workbench/model/request-auth";
import { getWorkspaceAuth, getWorkspaceAuthProfiles, type WorkspaceRequestConfig } from "../../request-workbench/model/request-workspace-config";

/** A local opaque cache key; credential values never enter cache records. Tokens rotate independently. */
export async function schemaConnectionIdentity(connection: SchemaDocument, config: WorkspaceRequestConfig, variables: Record<string, string>, environmentId: string | null = null): Promise<string> {
  const profile = getWorkspaceAuth(config, "graphql");
  const resolved = resolveAuth(connection.auth, {
    workspace: profile ? { id: profile.id, name: profile.name, auth: profile.value } : undefined,
    workspaceProfiles: getWorkspaceAuthProfiles(config, "graphql").map((item) => ({ id: item.id, name: item.name, auth: item.value })),
  });
  const auth = resolved.auth;
  const activeAuth = auth.type === "bearer" ? auth.bearer : auth.type === "basic" ? auth.basic : auth.type === "api-key" ? auth.apiKey
    : auth.type === "oauth2" ? { ...auth.oauth2, token: undefined } : { type: auth.type, error: resolved.error };
  const source = connection.schemaSource;
  const ownNames = new Set(connection.introspectionHeaders.map((header) => header.name.toLowerCase()));
  const shared = config.headers.filter((header) => header.enabled && (header.scope === "graphql" || header.scope === "all") && !ownNames.has(header.name.toLowerCase()));
  const substitute = (value: unknown): unknown => typeof value === "string" ? resolveEnvironmentValue(value, variables)
    : Array.isArray(value) ? value.map(substitute) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, substitute(child)])) : value;
  const value = substitute({ endpoint: connection.endpoint, source: source ? { type: source.type, ...("location" in source ? { location: source.location } : {}) } : { type: "introspection" },
    environmentId, auth: { type: auth.type, value: activeAuth }, headers: [...shared, ...connection.introspectionHeaders].filter((header) => header.enabled).map(({ name, value }) => ({ name, value })) });
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export type SchemaConnectionStatus = "Not fetched" | "Loading" | "Loaded" | "Stale" | "Error";
export function schemaConnectionStatus(connection: SchemaDocument, identity?: string): SchemaConnectionStatus {
  if (connection.fetchStatus === "loading") return "Loading";
  if (connection.fetchStatus === "error" || connection.fetchError) return "Error";
  if (!connection.sdl) return "Not fetched";
  return connection.cacheIdentity && identity && connection.cacheIdentity !== identity ? "Stale" : "Loaded";
}
