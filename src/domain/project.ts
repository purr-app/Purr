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
const pair = z.strictObject({ name: z.string(), value: z.string(), enabled: z.boolean().default(true) });
const scope = z.enum(["all", "http", "graphql"]);
export const authDefinitionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("inherit") }),
  z.strictObject({ type: z.literal("bearer"), token: credentialSchema, prefix: z.string().default("Bearer"),
    response: z.strictObject({ documentId: entityId, expression: z.string() }).optional() }),
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
  ...base, url: z.string(), method: z.string().regex(/^[A-Z][A-Z0-9_-]*$/),
  params: z.array(pair).default([]), headers: z.array(pair).default([]), body: body.default({ type: "none" }),
  auth: authDefinitionSchema.default({ type: "none" }), environmentId: entityId.optional(),
  overrides: z.strictObject({ headers: z.boolean().default(true), auth: z.boolean().default(true),
    excludedHeaderIds: z.array(entityId).default([]), cookies: z.boolean().default(true) }).optional(),
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
  ]), pinnedSdl: z.string().optional(),
});
export type SchemaDefinition = z.infer<typeof schemaDefinitionSchema>;
export const environmentDefinitionSchema = z.strictObject({ ...base, kind: z.literal("environment"),
  variables: z.array(z.strictObject({ id: entityId.optional(), name: z.string(), enabled: z.boolean().default(true), value: credentialSchema })),
});
export type EnvironmentDefinition = z.infer<typeof environmentDefinitionSchema>;
export const folderDefinitionSchema = z.strictObject({ ...base, kind: z.literal("folder") });
export const integrationDefinitionSchema = z.strictObject({ ...base, kind: z.literal("integration"), provider: z.string(),
  endpoint: z.string().optional(), credentials: z.record(z.string(), credentialSchema).default({}) });
export const resourceSchema = z.union([requestDefinitionSchema, schemaDefinitionSchema, environmentDefinitionSchema, folderDefinitionSchema, integrationDefinitionSchema]);
export type ProjectResource = z.infer<typeof resourceSchema>;
export const workspaceDefinitionSchema = z.strictObject({
  id: entityId, name: z.string(), description: z.string().optional(),
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
    for (const child of Object.values(object)) checkRefs(child);
  };
  checkRefs(workspace); checkRefs(resources);
  if (ids.size !== resources.length) throw new Error("Duplicate project resource identifiers.");
  if (new Set(workspace.auth.map((item) => item.id)).size !== workspace.auth.length || new Set(workspace.headers.map((item) => item.id)).size !== workspace.headers.length)
    throw new Error("Duplicate workspace configuration identifiers.");
  if (workspace.auth.some((item) => item.config.type === "inherit")) throw new Error("Workspace authentication cannot inherit from itself.");
  if (workspace.auth.some((item, index) => workspace.auth.some((other, otherIndex) => index !== otherIndex
    && (item.scope === "all" || other.scope === "all" || item.scope === other.scope))))
    throw new Error("Workspace authentication scopes overlap.");
  for (const resource of resources) {
    if (resource.kind === "environment" && new Set(resource.variables.map((variable) => variable.name)).size !== resource.variables.length)
      throw new Error("Duplicate environment variable names.");
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
  return { workspace, resources };
}
