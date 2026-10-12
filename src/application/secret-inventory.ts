import type { AuthDefinition, Credential, HeaderDefinition, Project, VariableDefinition } from "../domain/project";
import { isPureTemplateReference, templateTokens } from "../domain/template-expression";
import { resolveAuth, type RequestAuth } from "../features/request-workbench/model/request-auth";
import { applyWorkspaceRequestConfig, getWorkspaceAuthProfiles, withSchemaAuthContext } from "../features/request-workbench/model/request-workspace-config";
import type { RequestDraft, RequestHeader } from "../features/request-workbench/model/request";
import { getEffectiveVariables, isRequestDocument, type Variable, type Workspace } from "../features/workspaces/model/workspace";
import type { SecretResolution, SecureStore } from "./ports/credentials";
import { requestExpressions } from "./resolve-request-secrets";

export type SecretInventoryInput = { workspace: Workspace; project?: Project; globalVariables: readonly Variable[] };
export type SecretUsage = { ownerId: string; ownerLabel: string; field: string; environmentId?: string; environmentLabel?: string; enabled: boolean };
export type InventoryStatus = { status: SecretResolution["status"] | "unchecked"; code?: string; retryable?: boolean };
export type SecretInventoryItem = { key: string; ref?: string; usages: SecretUsage[]; declaration?: "missing-variable" | "external-provider" | "unsaved-value"; status: InventoryStatus };
export type SecretInventory = { items: SecretInventoryItem[]; publicValueCount: number; legacyLiteralCount: number };

function collector(input: SecretInventoryInput) {
  const { workspace, project, globalVariables } = input;
  const items = new Map<string, SecretInventoryItem>();
  const publicValues = new Set<string>(); const legacyLiterals = new Set<string>();
  const visited = new Set<string>();
  const usageKey = (usage: SecretUsage) => JSON.stringify([usage.ownerId, usage.field, usage.environmentId, usage.enabled]);
  const add = (ref: string | undefined, usage: SecretUsage, declaration?: SecretInventoryItem["declaration"], identity = usageKey(usage)) => {
    if (ref && !ref.startsWith(`purr/${workspace.id}/`) && !ref.startsWith("purr/global/")) return;
    const key = ref ?? `${declaration}:${identity}`;
    const item = items.get(key) ?? { key, ...(ref ? { ref } : {}), usages: [], ...(declaration ? { declaration } : {}),
      status: declaration === "missing-variable" ? { status: "missing" as const } : declaration ? { status: "unavailable" as const } : { status: "unchecked" as const } };
    if (!item.usages.some((candidate) => usageKey(candidate) === usageKey(usage))) item.usages.push(usage);
    items.set(key, item);
  };
  const context = (ownerId: string, ownerLabel: string, field: string, enabled = true, environmentId = workspace.activeEnvironmentId ?? undefined): SecretUsage => ({
    ownerId, ownerLabel, field, enabled, ...(environmentId ? { environmentId, environmentLabel: workspace.environments.find((environment) => environment.id === environmentId)?.name } : {}),
  });
  const inEnvironment = (usage: SecretUsage, environmentId: string | undefined): SecretUsage => ({ ...usage, environmentId,
    environmentLabel: workspace.environments.find((environment) => environment.id === environmentId)?.name });
  const variableOwner = (variable: Variable, fallback: SecretUsage): SecretUsage => {
    const environment = workspace.environments.find((item) => item.variables.some((candidate) => candidate.id === variable.id));
    return context(variable.id, environment ? `${environment.name} / ${variable.name}` : workspace.variables.some((item) => item.id === variable.id)
      ? `${workspace.name} / ${variable.name}` : `Global / ${variable.name}`, "Variable", variable.enabled,
    environment?.id ?? fallback.environmentId);
  };
  const expression = (value: string, usage: SecretUsage) => {
    for (const token of templateTokens(value)) {
      if (!token.name) continue;
      const key = `${usageKey(usage)}:${token.name}`;
      if (visited.has(key)) continue; visited.add(key);
      const definition = getEffectiveVariables(workspace, globalVariables, usage.environmentId ?? null).find((variable) => variable.name.trim() === token.name);
      if (!definition) { add(undefined, { ...usage, field: `${usage.field} → ${token.name}` }, "missing-variable", `${usage.ownerId}:${usage.environmentId ?? "none"}:${token.name}`); continue; }
      const owner = variableOwner(definition, usage);
      variable(definition, owner, false);
      if (definition.kind === "static") {
        const ref = definition.secretState?.ref ?? definition.secretRef;
        if (ref) add(ref, usage);
        expression(definition.value, usage);
      }
      else if (definition.kind === "dynamic-request") {
        const source = workspace.documents.find((document) => document.id === definition.documentId);
        const environment = definition.environment.type === "specific" ? definition.environment.environmentId : usage.environmentId;
        const dependencyKey = `dynamic:${definition.id}:${environment ?? "none"}`;
        if (!visited.has(dependencyKey) && source && isRequestDocument(source) && !source.historical) {
          visited.add(dependencyKey); runtimeRequest(source.savedRequest ?? source.request, context(source.id, source.name, "Dynamic dependency", definition.enabled, environment));
        }
      }
    }
  };
  const credential = (value: Credential, usage: SecretUsage, protectedValue: boolean, canonical = true) => {
    if (value.kind === "secret") add(value.ref, usage);
    else {
      if (canonical) publicValues.add(usageKey(usage));
      if (canonical && protectedValue && value.kind === "plain") legacyLiterals.add(usageKey(usage));
      expression(value.value, usage);
    }
  };
  const auth = (value: AuthDefinition, usage: SecretUsage) => {
    if (value.type === "bearer") credential(value.token, { ...usage, field: "Bearer token" }, true);
    if (value.type === "basic") credential(value.password, { ...usage, field: "Password" }, true);
    if (value.type === "api-key") credential(value.value, { ...usage, field: "API key" }, true);
    if (value.type === "oauth2") credential(value.clientSecret, { ...usage, field: "OAuth client secret" }, true);
    if (value.type === "basic") expression(value.username, { ...usage, field: "Username" });
    if (value.type === "oauth2") for (const [field, text] of Object.entries(value))
      if (typeof text === "string" && field !== "type" && field !== "grantType") expression(text, { ...usage, field });
  };
  const headers = (values: readonly HeaderDefinition[], usage: SecretUsage) => values.forEach((header) => credential(header.value,
    { ...usage, field: `Header ${header.name || "(unnamed)"} [${header.id}]`, enabled: usage.enabled && header.enabled }, header.sensitive));
  const variable = (value: Variable | VariableDefinition, usage: SecretUsage, canonical: boolean) => {
    if (value.kind === "static") {
      const ref = value.secretRef ?? ("secretState" in value ? value.secretState?.ref : undefined);
      if (ref) add(ref, usage);
      else if (value.sensitive) add(undefined, usage, "unsaved-value");
      else if (canonical) publicValues.add(usageKey(usage));
      if (typeof value.value === "string") expression(value.value, usage);
    } else if (value.kind === "external-secret") add(undefined, usage, "external-provider");
  };
  const runtimeAuth = (value: RequestAuth, usage: SecretUsage) => {
    const slots = [["bearer", value.bearer.token], ["password", value.basic.password], ["api-key", value.apiKey.value], ["client-secret", value.oauth2.clientSecret]] as const;
    for (const [slot, text] of slots) {
      const state = value.credentialStates?.[slot]; const ref = state?.ref ?? value.secretRefs?.[slot];
      const enabled = usage.enabled && ({ bearer: "bearer", password: "basic", "api-key": "api-key", "client-secret": "oauth2" } as const)[slot] === value.type;
      const owner = { ...usage, field: slot, enabled };
      if (ref) add(ref, owner);
      else if (enabled && !isPureTemplateReference(text)) add(undefined, owner, "unsaved-value");
      if (enabled || ref) expression(text, owner);
    }
    if (value.type === "oauth2") for (const [field, text] of Object.entries(value.oauth2))
      if (typeof text === "string" && field !== "clientSecret") expression(text, { ...usage, field });
  };
  const runtimeHeaders = (values: readonly RequestHeader[], usage: SecretUsage) => values.forEach((header) => {
    const owner = { ...usage, field: `Header ${header.name || "(unnamed)"} [${header.id}]`, enabled: usage.enabled && header.enabled };
    const ref = header.secretState?.ref ?? header.secretRef;
    if (ref) add(ref, owner);
    else if ((header.secret || /^(cookie|set-cookie)$/i.test(header.name.trim())) && !isPureTemplateReference(header.value)) add(undefined, owner, "unsaved-value");
    expression(header.value, owner);
  });
  const runtimeRequest = (value: RequestDraft, usage: SecretUsage) => {
    runtimeAuth(value.auth, usage); runtimeHeaders(value.headers, usage);
    const kind = value.graphql ? "graphql" : "http";
    const effective = applyWorkspaceRequestConfig(value, kind, workspace.requestConfig);
    const profiles = getWorkspaceAuthProfiles(workspace.requestConfig, kind).map((profile) => ({ id: profile.id, name: profile.name, auth: profile.value }));
    const inherited = resolveAuth(effective.auth, withSchemaAuthContext(effective, workspace.requestConfig, { workspaceProfiles: profiles }));
    if (!inherited.error) runtimeAuth(inherited.auth, usage);
    runtimeHeaders(effective.headers, usage);
    for (const field of requestExpressions({ ...effective, auth: inherited.error ? effective.auth : inherited.auth })) {
      if (field.field === "auth:oauth-access-token") continue;
      expression(field.value, { ...usage, field: field.rowId ? `${field.field} [${field.rowId}]` : field.field });
    }
  };
  const workspaceOwner = context(workspace.id, workspace.name, "Workspace");
  if (project) {
    headers(project.workspace.headers, workspaceOwner);
    for (const profile of project.workspace.auth) auth(profile.config, context(profile.id, profile.name, "Authentication", profile.enabled));
    for (const value of project.workspace.variables) variable(value, context(value.id, `${workspace.name} / ${value.name}`, "Variable", value.enabled), true);
    for (const resource of project.resources) {
      const owner = context(resource.id, resource.name, "Saved definition");
      if (resource.kind === "http" || resource.kind === "graphql") {
        const scoped = inEnvironment(owner, resource.environmentId ?? owner.environmentId);
        headers(resource.headers, scoped); auth(resource.auth, scoped);
        expression(resource.url, { ...scoped, field: "URL" });
        for (const pair of [...resource.params, ...resource.pathParams]) expression(pair.value, { ...scoped, field: pair.name, enabled: pair.enabled });
        if (resource.body.type === "json" || resource.body.type === "xml" || resource.body.type === "text") expression(resource.body.data, { ...scoped, field: "Body" });
        if (resource.body.type === "form-data" || resource.body.type === "url-encoded") for (const field of resource.body.fields)
          expression(field.value, { ...scoped, field: `Body ${field.name}`, enabled: field.enabled });
        if (resource.kind === "graphql") for (const text of [resource.graphql.query, resource.graphql.variables]) expression(text, { ...scoped, field: "GraphQL" });
      } else if (resource.kind === "schema") {
        headers(resource.introspectionHeaders, owner); if (resource.auth) auth(resource.auth, owner);
        if (resource.endpoint) expression(resource.endpoint, { ...owner, field: "Endpoint" });
        if (resource.source.type === "registry" && resource.source.credential) credential(resource.source.credential, { ...owner, field: "Registry credential" }, true);
      } else if (resource.kind === "integration") for (const [key, value] of Object.entries(resource.credentials)) credential(value, { ...owner, field: key, enabled: resource.enabled }, true);
      else if (resource.kind === "environment") for (const value of resource.variables) variable(value, context(value.id, `${resource.name} / ${value.name}`, "Variable", value.enabled, resource.id), true);
    }
  }
  for (const value of workspace.variables) variable(value, context(value.id, `${workspace.name} / ${value.name}`, "Variable", value.enabled), !project);
  for (const environment of workspace.environments) for (const value of environment.variables) variable(value, context(value.id, `${environment.name} / ${value.name}`, "Variable", value.enabled, environment.id), !project);
  runtimeHeaders(workspace.requestConfig.headers, workspaceOwner);
  for (const profile of workspace.requestConfig.auth) runtimeAuth(profile.value, context(profile.id, profile.name, "Authentication", profile.enabled));
  for (const resource of workspace.extraResources ?? []) if (resource.kind === "integration")
    for (const [key, value] of Object.entries(resource.credentials)) credential(value, context(resource.id, resource.name, key, resource.enabled), true, !project);
  for (const document of workspace.documents) {
    const owner = context(document.id, document.name, "Working copy");
    if (isRequestDocument(document)) {
      if (document.historical) continue;
      runtimeRequest(document.request, inEnvironment(owner, document.request.environmentId ?? owner.environmentId));
      if (document.savedRequest) runtimeRequest(document.savedRequest, inEnvironment({ ...owner, field: "Saved definition" }, document.savedRequest.environmentId ?? owner.environmentId));
    } else if (document.kind === "schema") { runtimeAuth(document.auth, owner); runtimeHeaders(document.introspectionHeaders, owner); expression(document.endpoint, { ...owner, field: "Endpoint" }); }
  }
  const result = (): SecretInventory => ({ items: [...items.values()].sort((a, b) => a.usages[0].ownerLabel.localeCompare(b.usages[0].ownerLabel) || a.key.localeCompare(b.key)), publicValueCount: publicValues.size, legacyLiteralCount: legacyLiterals.size });
  return { result, expression };
}

/** No vault enumeration, network resolution or secret values in the returned model. */
export function buildSecretInventory(input: SecretInventoryInput): SecretInventory { return collector(input).result(); }

export async function resolveSecretInventory(input: SecretInventoryInput, secure: SecureStore): Promise<SecretInventory> {
  const collected = collector(input); const checked = new Map<string, Set<string>>();
  const usageKey = (usage: SecretUsage) => JSON.stringify(usage);
  for (;;) {
    const pending = collected.result().items.filter((item) => item.ref && item.usages.some((usage) => !checked.get(item.ref!)?.has(usageKey(usage))));
    if (!pending.length) break;
    for (const item of pending) {
      const usages = item.usages.filter((usage) => !checked.get(item.ref!)?.has(usageKey(usage)));
      const seen = checked.get(item.ref!) ?? new Set<string>();
      usages.forEach((usage) => seen.add(usageKey(usage))); checked.set(item.ref!, seen);
      try {
        const resolution = await secure.resolve(item.ref!);
        item.status = { status: resolution.status, ...("code" in resolution ? { code: resolution.code, retryable: resolution.retryable } : {}) };
        if (resolution.status === "available") for (const usage of usages) collected.expression(resolution.value, usage);
      } catch { item.status = { status: "unavailable", code: "credential-status-unavailable", retryable: true }; }
    }
  }
  return collected.result();
}
