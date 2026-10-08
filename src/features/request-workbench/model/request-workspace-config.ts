import type { IntegrationDefinition } from "../../../domain/project";
import { resolveRequestTracing } from "./request-tracing";
import { resolveAuth, type AuthContext, type RequestAuth } from "./request-auth";
import { getRequestQueryParamsFromUrl, type RequestDraft, type RequestHeader } from "./request";

export type RequestKind = "http" | "graphql";
export type RequestScope = "all" | RequestKind;
export const requestScopeOptions = [
  { value: "all", label: "All requests" },
  { value: "http", label: "HTTP" },
  { value: "graphql", label: "GraphQL" },
] as const;
export type WorkspaceSharedHeader = RequestHeader & { scope: RequestScope };
export type WorkspaceSharedAuth = {
  id: string;
  name: string;
  enabled: boolean;
  scope: RequestScope;
  value: RequestAuth;
};
export type SchemaConnectionConfig = { id: string; name: string; endpoint: string; auth: RequestAuth };
export function withSchemaAuthContext(request: RequestDraft, config: WorkspaceRequestConfig, context: AuthContext): AuthContext {
  const connection = config.schemaConnections?.find((item) => item.id === request.graphql?.schemaId);
  return { ...context, schema: connection ? { id: connection.id, name: connection.name, auth: connection.auth } : undefined };
}
/** History captures connection settings at dispatch time, never a live schema reference. */
export function snapshotSchemaRequest(request: RequestDraft, config: WorkspaceRequestConfig, context: AuthContext = {}): RequestDraft {
  if (!request.graphql?.schemaId) return request;
  const effective = applyWorkspaceRequestConfig(request, "graphql", config);
  const profile = getWorkspaceAuth(config, "graphql");
  const resolved = resolveAuth(effective.auth, withSchemaAuthContext(effective, config, {
    workspace: profile ? { id: profile.id, name: profile.name, auth: profile.value } : undefined,
    workspaceProfiles: getWorkspaceAuthProfiles(config, "graphql").map((item) => ({ id: item.id, name: item.name, auth: item.value })), ...context,
  }));
  return { ...effective, graphql: { ...effective.graphql!, schemaId: undefined }, auth: structuredClone(resolved.auth) };
}
export type WorkspaceRequestConfig = {
  /** Runtime-only workspace connection projection, shared by every execution path. */
  schemaConnections?: readonly SchemaConnectionConfig[];
  /** Runtime projection only; canonical integrations remain separate resources. */
  integrations?: readonly IntegrationDefinition[];
  tracePropagation?: string;
  headers: WorkspaceSharedHeader[];
  auth: WorkspaceSharedAuth[];
};

export function createWorkspaceRequestConfig(): WorkspaceRequestConfig {
  return {
    headers: [],
    auth: [],
  };
}

export function requestScopeApplies(scope: RequestScope, kind: RequestKind) {
  return scope === "all" || scope === kind;
}

export function getWorkspaceAuth(
  config: WorkspaceRequestConfig,
  kind: RequestKind,
  profileId?: string,
) {
  const profiles = getWorkspaceAuthProfiles(config, kind);
  if (profileId) return profiles.find((auth) => auth.id === profileId);
  return profiles.find((auth) => auth.scope === kind) ?? profiles[0];
}

export function getWorkspaceAuthProfiles(
  config: WorkspaceRequestConfig,
  kind: RequestKind,
) {
  return config.auth.filter((auth) => auth.enabled && requestScopeApplies(auth.scope, kind) && auth.value.type !== "none");
}

export function workspaceAuthApplies(
  config: WorkspaceRequestConfig,
  kind: RequestKind,
) {
  return Boolean(getWorkspaceAuth(config, kind));
}

export function withWorkspaceAuthDefault(
  request: RequestDraft,
  kind: RequestKind,
  config: WorkspaceRequestConfig,
): RequestDraft {
  if (!request.workspace.authEnabled || request.auth.type !== "none" || !workspaceAuthApplies(config, kind))
    return request;
  const profile = getWorkspaceAuth(config, kind);
  return {
    ...request,
    auth: { ...request.auth, type: "inherit", inherit: { source: "workspace", ...(profile ? { profileId: profile.id } : {}) } },
  };
}

export function applyWorkspaceRequestConfig(
  request: RequestDraft,
  kind: RequestKind,
  config: WorkspaceRequestConfig,
): RequestDraft {
  const connection = kind === "graphql" ? config.schemaConnections?.find((item) => item.id === request.graphql?.schemaId) : undefined;
  if (connection) request = { ...request, url: connection.endpoint,
    params: getRequestQueryParamsFromUrl(connection.endpoint, []), pathParams: [] };
  const ownNames = new Set(request.headers.map((header) => header.name.trim().toLowerCase()).filter(Boolean));
  const sharedHeaders = config.headers
    .filter((header) => header.enabled && header.name.trim()
      && requestScopeApplies(header.scope, kind)
      && !ownNames.has(header.name.trim().toLowerCase()))
      .map((header) => ({
        ...header,
        id: `workspace-${header.id}`,
        workspaceHeaderId: header.id,
        enabled: request.workspace.headersEnabled
          && request.workspace.headerOverrides[header.id] !== false,
        readOnly: true,
        readOnlyReason: "Shared by the workspace. Configure it in Workspace settings.",
      }));
  const auth = (!request.workspace.authEnabled || !workspaceAuthApplies(config, kind))
    && request.auth.type === "inherit"
    && request.auth.inherit.source === "workspace"
      ? { ...request.auth, type: "none" as const }
      : kind === "graphql" ? request.auth : withWorkspaceAuthDefault(request, kind, config).auth;
  const tracing = config.integrations ? resolveRequestTracing(request, config.integrations, config.tracePropagation) : undefined;
  return {
    ...request,
    headers: [...sharedHeaders, ...request.headers],
    tracePropagation: tracing?.propagation ?? request.tracePropagation ?? config.tracePropagation,
    traceHeaderTemplates: tracing?.enabled ? tracing.integration?.tracing?.requestHeaders.filter((header) => header.enabled && header.name.trim()).map(({ name, value }) => ({ name, value })) : undefined,
    auth,
  };
}
