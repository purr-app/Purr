import type { RequestAuth } from "./request-auth";
import type { RequestDraft, RequestHeader } from "./request";

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
export type WorkspaceRequestConfig = {
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
      : withWorkspaceAuthDefault(request, kind, config).auth;
  return {
    ...request,
    headers: [...sharedHeaders, ...request.headers],
    auth,
  };
}
