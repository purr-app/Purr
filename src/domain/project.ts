import { z } from "zod";

// Canonical definitions contain no editor rows, transport responses or storage paths.
// Both import adapters and the current editor project into these types.
export const entityId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const secretRefSchema = z.string().min(1).max(512).regex(/^purr\/[a-zA-Z0-9_/-]+$/);
export type SecretRef = z.infer<typeof secretRefSchema>;
export const credentialSchema = z.union([
  z.strictObject({ kind: z.literal("plain"), value: z.string() }),
  z.strictObject({ kind: z.literal("secret"), ref: secretRefSchema }),
]);
export type Credential = z.infer<typeof credentialSchema>;
const variableBase = { id: entityId, name: z.string().trim().min(1).refine((value) => !/[{}]/.test(value), "Variable names cannot contain braces"),
  enabled: z.boolean().default(true), sensitive: z.boolean().default(false) };
export const variableDefinitionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...variableBase, kind: z.literal("static"), value: z.string().optional(), secretRef: secretRefSchema.optional() }),
  z.strictObject({
    ...variableBase,
    kind: z.literal("dynamic-request"),
    documentId: z.string().max(128),
    expression: z.string(),
    language: z.enum(["jsonpath", "jq"]).default("jsonpath"),
    refresh: z.enum(["every-time", "session", "cache"]).default("every-time"),
    cacheTtlSeconds: z.number().int().positive().optional(),
    environment: z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("current") }),
      z.strictObject({ type: z.literal("specific"), environmentId: entityId }),
    ]).default({ type: "current" }),
  }),
  // The definition is intentionally provider-neutral. Provider adapters will
  // resolve it later without changing how requests refer to the variable.
  z.strictObject({ ...variableBase, kind: z.literal("external-secret"), provider: z.string(), key: z.string() }),
]);
export type VariableDefinition = z.infer<typeof variableDefinitionSchema>;
const pair = z.strictObject({ name: z.string(), value: z.string(), enabled: z.boolean().default(true) });
const scope = z.enum(["all", "http", "graphql"]);
export const authDefinitionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("inherit"), profileId: entityId.optional() }),
  z.strictObject({ type: z.literal("bearer"), token: credentialSchema, prefix: z.string().default("Bearer") }),
  z.strictObject({ type: z.literal("basic"), username: z.string(), password: credentialSchema }),
  z.strictObject({ type: z.literal("api-key"), name: z.string(), placement: z.enum(["header", "query", "cookie"]), value: credentialSchema }),
  z.strictObject({ type: z.literal("oauth2"), grantType: z.enum(["client_credentials", "authorization_code"]),
    authorizationUrl: z.string().optional(), tokenUrl: z.string(), clientId: z.string(), clientSecret: credentialSchema,
    scopes: z.string().optional(), redirectUri: z.string().optional(), clientAuthentication: z.enum(["body", "basic"]).default("body"),
    autoRefresh: z.boolean().default(true) }),
]);
export type AuthDefinition = z.infer<typeof authDefinitionSchema>;
const attachment = z.strictObject({ id: entityId, name: z.string(), mediaType: z.string() });
const body = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.enum(["json", "xml", "text"]), data: z.string() }),
  z.strictObject({ type: z.literal("binary"), file: attachment.nullable() }),
  z.strictObject({ type: z.enum(["form-data", "url-encoded"]), fields: z.array(pair.extend({ file: attachment.optional(), contentType: z.string().optional() })) }),
]);
const base = { id: entityId, name: z.string(), description: z.string().optional(), folderId: entityId.optional() };
const request = {
  tracePropagation: z.string().min(1).max(64).regex(/^[a-z][a-z0-9._-]*$/).optional(),
  ...base, url: z.string(), method: z.string().regex(/^[A-Z][A-Z0-9_-]*$/), documentation: z.string().optional(),
  params: z.array(pair).default([]), pathParams: z.array(pair).default([]), headers: z.array(pair).default([]), body: body.default({ type: "none" }),
  auth: authDefinitionSchema.default({ type: "none" }), environmentId: entityId.optional(),
  overrides: z.strictObject({ headers: z.boolean().default(true), auth: z.boolean().default(true),
    excludedHeaderIds: z.array(entityId).default([]), cookies: z.boolean().default(true) }).optional(),
  origin: z.strictObject({ type: z.literal("openapi"), schemaId: entityId, operationPath: z.string(), operationId: z.string().optional() }).optional(),
};
export const requestDefinitionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...request, kind: z.literal("http") }),
  z.strictObject({ ...request, kind: z.literal("graphql"), graphql: z.strictObject({ query: z.string(), variables: z.string().default(""), operation: z.string().optional(), schemaId: entityId.optional() }) }),
]);
export type RequestDefinition = z.infer<typeof requestDefinitionSchema>;
export const schemaDefinitionSchema = z.strictObject({
  ...base, kind: z.literal("schema"), source: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("introspection"), endpoint: z.string(), requestId: entityId.optional() }),
    z.strictObject({ type: z.enum(["sdl-file", "introspection-json"]), location: z.string().optional(), endpoint: z.string().optional() }),
    z.strictObject({ type: z.literal("registry"), provider: z.string(), resource: z.string(), credential: credentialSchema.optional() }),
  ]), pin: z.boolean().default(true), pinnedSdl: z.string().optional(),
});
export type SchemaDefinition = z.infer<typeof schemaDefinitionSchema>;
export const apiSchemaDefinitionSchema = z.strictObject({
  ...base, kind: z.literal("api-schema"), format: z.literal("openapi-3"),
  source: z.strictObject({ type: z.enum(["file", "directory", "url", "text"]), location: z.string() }),
  document: z.string(),
});
export type ApiSchemaDefinition = z.infer<typeof apiSchemaDefinitionSchema>;
export const environmentDefinitionSchema = z.strictObject({ ...base, kind: z.literal("environment"),
  variables: z.array(variableDefinitionSchema).default([]),
});
export type EnvironmentDefinition = z.infer<typeof environmentDefinitionSchema>;
export const folderDefinitionSchema = z.strictObject({ ...base, kind: z.literal("folder") });
export const integrationProviderIdSchema = z.string().min(1).max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/, "Integration provider IDs must be stable lowercase identifiers.");
export const integrationCredentialKeySchema = z.string().min(1).max(64)
  .regex(/^[a-z][a-zA-Z0-9_-]*$/, "Integration credential keys must be stable identifiers.");
export const integrationConfigSchema = z.record(z.string(), z.json());
export type JsonObject = z.infer<typeof integrationConfigSchema>;
export const integrationDefinitionSchema = z.strictObject({
  ...base,
  kind: z.literal("integration"),
  provider: integrationProviderIdSchema,
  enabled: z.boolean().default(true),
  configVersion: z.number().int().positive().default(1),
  config: integrationConfigSchema.default({}),
  credentials: z.record(integrationCredentialKeySchema, credentialSchema).default({}),
});
export type IntegrationDefinition = z.infer<typeof integrationDefinitionSchema>;
export const extensionDocumentDefinitionSchema = z.strictObject({
  ...base,
  kind: z.literal("extension"),
  extensionType: integrationProviderIdSchema,
  configVersion: z.number().int().positive(),
  config: integrationConfigSchema,
});
export type ExtensionDocumentDefinition = z.infer<typeof extensionDocumentDefinitionSchema>;
export const resourceSchema = z.union([requestDefinitionSchema, schemaDefinitionSchema, apiSchemaDefinitionSchema, environmentDefinitionSchema, folderDefinitionSchema, integrationDefinitionSchema, extensionDocumentDefinitionSchema]);
export type ProjectResource = z.infer<typeof resourceSchema>;
export const workspaceDefinitionSchema = z.strictObject({
  tracePropagation: z.string().min(1).max(64).regex(/^[a-z][a-z0-9._-]*$/).optional(),
  id: entityId, name: z.string(), description: z.string().optional(),
  variables: z.array(variableDefinitionSchema).default([]),
  headers: z.array(pair.extend({ id: entityId, scope })).default([]),
  auth: z.array(z.strictObject({ id: entityId, name: z.string(), scope, enabled: z.boolean().default(true), config: authDefinitionSchema })).default([]),
});
export type WorkspaceDefinition = z.infer<typeof workspaceDefinitionSchema>;
export type Project = { workspace: WorkspaceDefinition; resources: ProjectResource[] };

export function validateProject(project: Project): Project {
  const workspace = workspaceDefinitionSchema.parse(project.workspace);
  const resources = project.resources.map((item) => resourceSchema.parse(item));
  const ids = new Set(resources.map((resource) => resource.id));
  const checkRefs = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (object.kind === "secret" && (typeof object.ref !== "string" || !object.ref.startsWith(`purr/${workspace.id}/`)))
      throw new Error("Secret references must belong to this workspace.");
    if (object.kind === "static" && object.sensitive === true
      && (typeof object.secretRef !== "string" || !object.secretRef.startsWith(`purr/${workspace.id}/`)))
      throw new Error("Sensitive variable references must belong to this workspace.");
    for (const child of Object.values(object)) checkRefs(child);
  };
  checkRefs(workspace);
  for (const resource of resources) {
    // Provider-owned config is opaque JSON. Core validates only the explicit
    // credential map and must not infer SecretRef semantics from vendor keys.
    if (resource.kind === "integration") checkRefs(resource.credentials);
    else if (resource.kind === "extension") continue;
    else checkRefs(resource);
  }
  if (ids.size !== resources.length) throw new Error("Duplicate project resource identifiers.");
  if (new Set(workspace.auth.map((item) => item.id)).size !== workspace.auth.length || new Set(workspace.headers.map((item) => item.id)).size !== workspace.headers.length)
    throw new Error("Duplicate workspace configuration identifiers.");
  if (workspace.auth.some((item) => item.config.type === "inherit")) throw new Error("Workspace authentication cannot inherit from itself.");
  if (new Set(workspace.variables.map((variable) => variable.name.trim()).filter(Boolean)).size !== workspace.variables.filter((variable) => variable.name.trim()).length)
    throw new Error("Duplicate workspace variable names.");
  const variableIds = [...workspace.variables, ...resources.flatMap((resource) => resource.kind === "environment" ? resource.variables : [])].map((variable) => variable.id);
  if (new Set(variableIds).size !== variableIds.length) throw new Error("Duplicate variable identifiers.");
  const environmentNames = resources.filter((resource) => resource.kind === "environment").map((environment) => environment.name.trim()).filter(Boolean);
  if (new Set(environmentNames).size !== environmentNames.length) throw new Error("Duplicate environment names.");
  const workspaceVariableNames = new Set(workspace.variables.map((variable) => variable.name.trim()));
  const validateDynamicVariable = (variable: VariableDefinition) => {
    if (variable.kind === "static") {
      if (variable.sensitive && (!variable.secretRef || variable.value !== undefined))
        throw new Error("A sensitive static variable must contain only a SecretRef.");
      if (!variable.sensitive && (variable.value === undefined || variable.secretRef !== undefined))
        throw new Error("A non-sensitive static variable must contain a plain value.");
      return;
    }
    if (variable.kind === "external-secret") {
      if (!variable.sensitive) throw new Error("An external secret must be marked sensitive.");
      return;
    }
    if (variable.documentId && !resources.some((item) => item.id === variable.documentId && (item.kind === "http" || item.kind === "graphql")))
      throw new Error("A dynamic variable refers to a missing saved request.");
    const environmentId = variable.environment.type === "specific" ? variable.environment.environmentId : undefined;
    if (environmentId && !resources.some((item) => item.kind === "environment" && item.id === environmentId))
      throw new Error("A dynamic variable refers to a missing environment.");
    if (variable.refresh === "cache" && !variable.cacheTtlSeconds)
      throw new Error("A cached dynamic variable requires a positive cache duration.");
  };
  for (const resource of resources) {
    const inheritedProfileId = (resource.kind === "http" || resource.kind === "graphql") && resource.auth.type === "inherit"
      ? resource.auth.profileId : undefined;
    if ((resource.kind === "http" || resource.kind === "graphql") && inheritedProfileId
      && !workspace.auth.some((profile) => profile.id === inheritedProfileId
        && (profile.scope === "all" || profile.scope === resource.kind)))
      throw new Error("A request inherits from a missing or incompatible workspace authentication profile.");
    if ((resource.kind === "http" || resource.kind === "graphql") && resource.origin
      && !resources.some((item) => item.kind === "api-schema" && item.id === resource.origin?.schemaId))
      throw new Error("An imported request refers to a missing API schema.");
    if (resource.kind === "environment" && new Set(resource.variables.map((variable) => variable.name.trim()).filter(Boolean)).size !== resource.variables.filter((variable) => variable.name.trim()).length)
      throw new Error("Duplicate environment variable names.");
    if (resource.kind === "environment" && resource.variables.some((variable) => workspaceVariableNames.has(variable.name.trim())))
      throw new Error("Workspace and environment variable names must not overlap.");
    if (resource.kind === "environment" && resource.variables.some((variable) => variable.kind !== "static"))
      throw new Error("Environment variables must be static.");
    if (resource.kind === "environment") resource.variables.forEach(validateDynamicVariable);
    const seen = new Set([resource.id]);
    let parent = resource.folderId;
    while (parent) {
      if (seen.has(parent)) throw new Error("Folder hierarchy contains a cycle.");
      seen.add(parent);
      const folder = resources.find((item) => item.id === parent && item.kind === "folder");
      if (!folder) throw new Error("A resource refers to a missing folder.");
      parent = folder.folderId;
    }
  }
  workspace.variables.forEach(validateDynamicVariable);
  return { workspace, resources };
}
