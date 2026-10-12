import { parseDocument, stringify } from "yaml";
import { resourceSchema, workspaceDefinitionSchema, validateV2WorkspaceDefinition, validateV2ResourceDefinition, type ProjectResource, type WorkspaceDefinition } from "../domain/project";

import { isPureTemplateReference } from "../domain/template-expression";

export type ProjectFormatVersion = 1 | 2;
type DevelopmentConversion<T> = { value: T; developmentRewrite: boolean };
export type DecodedProjectFile<T> = DevelopmentConversion<T> & {
  sourceVersion: ProjectFormatVersion;
  migrationRequired: boolean;
  legacySource?: { version: 1 };
};

export const projectFormatVersion = 2;
const decoded = <T>(value: T, sourceVersion: ProjectFormatVersion, developmentRewrite: boolean): DecodedProjectFile<T> => ({
  value, sourceVersion, developmentRewrite, migrationRequired: sourceVersion === 1,
  ...(sourceVersion === 1 ? { legacySource: { version: 1 as const } } : {}),
});
function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === "object") {
    const preserveOpaqueConfig = ["integration", "extension"].includes(String((value as { kind?: unknown }).kind));
    return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
      if (child === undefined || Array.isArray(child) && !child.length || key === "enabled" && child === true || key === "sensitive" && child === false) return [];
      if (key === "body" && (child as { type?: string })?.type === "none") return [];
      // Integration and extension-document configuration is module-owned JSON.
      // Compacting it would mutate unavailable/private data.
      return [[key, preserveOpaqueConfig && key === "config" ? child : compact(child)]];
    }));
  }
  return value;
}
function yaml(value: unknown) {
  return stringify(compact(value), { lineWidth: 0, blockQuote: "literal", aliasDuplicateObjects: false, sortMapEntries: false });
}
function parse(text: string): Record<string, unknown> {
  try {
    const document = parseDocument(text, { uniqueKeys: true, prettyErrors: false, strict: true, stringKeys: true, logLevel: "silent" });
    if (document.errors.length || document.warnings.length) throw new Error();
    const value = document.toJS({ maxAliasCount: 0 });
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    if (value.purr !== 1 && value.purr !== projectFormatVersion) throw new Error("version");
    return value;
  } catch {
    // Never echo a YAML source excerpt: an external file may contain a credential.
    throw new Error("Invalid or unsupported Purr YAML. The original resource has not been changed.");
  }
}
export function serializeManifest(workspace: WorkspaceDefinition, sourceVersion: ProjectFormatVersion = projectFormatVersion): string {
  const parsed = workspaceDefinitionSchema.parse(workspace);
  if (sourceVersion === 2) validateV2WorkspaceDefinition(parsed);
  const { headers, auth, ...identity } = sourceVersion === 1 ? legacyWorkspace(parsed) : parsed;
  return yaml({ purr: sourceVersion, workspace: identity, ...(headers.length || auth.length ? { defaults: { headers, auth } } : {}) });
}
export function deserializeManifest(text: string): WorkspaceDefinition {
  return deserializeManifestFile(text).value;
}
export function deserializeManifestFile(text: string): DecodedProjectFile<WorkspaceDefinition> {
  const value = parse(text);
  try {
    if (Object.keys(value).some((key) => !["purr", "workspace", "defaults"].includes(key))) throw new Error();
    const defaults = value.defaults as Record<string, unknown> | undefined;
    const workspace = { ...(value.workspace as object), ...defaults } as Record<string, unknown>;
    let developmentRewrite = false;
    if (value.purr === 1 && Array.isArray(workspace.variables)) workspace.variables = workspace.variables.map((candidate) => {
      const converted = convertDevelopmentVariable(candidate); developmentRewrite ||= converted.developmentRewrite; return converted.value;
    });
    if (value.purr === 1 && Array.isArray(workspace.auth)) workspace.auth = workspace.auth.map((candidate) => {
      const converted = convertDevelopmentAuth(candidate); developmentRewrite ||= converted.developmentRewrite; return converted.value;
    });
    const sourceVersion = value.purr as ProjectFormatVersion;
    const parsed = workspaceDefinitionSchema.parse(sourceVersion === 1 ? normalizeLegacyWorkspace(workspace) : workspace);
    if (sourceVersion === 2) validateV2WorkspaceDefinition(parsed);
    return decoded(parsed, sourceVersion, developmentRewrite);
  } catch { throw new Error("Invalid workspace manifest. The original file has not been changed."); }
}
export function serializeResource(resource: ProjectResource, sdlPath?: string, sourceVersion: ProjectFormatVersion = projectFormatVersion): string {
  const validated = resourceSchema.parse(resource);
  if (sourceVersion === 2) validateV2ResourceDefinition(validated);
  const serializable = sourceVersion === 1 ? legacyResource(validated) : validated;
  if (validated.kind === "schema") {
    const { pinnedSdl, pin, ...source } = serializable as Extract<ProjectResource, { kind: "schema" }>;
    return yaml({ purr: sourceVersion, ...source, ...(pin ? {} : { pin: false }), ...(pinnedSdl !== undefined && sdlPath ? { pinned: sdlPath } : {}) });
  }
  if (validated.kind === "api-schema") {
    const { document: _document, ...definition } = serializable as Extract<ProjectResource, { kind: "api-schema" }>;
    if (!sdlPath) throw new Error("An API schema sidecar path is required.");
    return yaml({ purr: sourceVersion, ...definition, schema: sdlPath });
  }
  return yaml({ purr: sourceVersion, ...serializable });
}
export function deserializeResource(text: string, readSdl: (path: string) => string = () => { throw new Error(); }): ProjectResource {
  return deserializeResourceFile(text, readSdl).value;
}
export function deserializeResourceFile(text: string, readSdl: (path: string) => string = () => { throw new Error(); }): DecodedProjectFile<ProjectResource> {
  const { purr: version, pinned, schema, ...value } = parse(text);
  try {
    let developmentRewrite = false;
    // Lightweight development transition only; the next save rewrites the
    // canonical shape and no production compatibility layer is retained.
    if (version === 1 && value.kind === "environment" && Array.isArray(value.variables)) value.variables = value.variables.map((candidate) => {
      const converted = convertDevelopmentVariable(candidate); developmentRewrite ||= converted.developmentRewrite; return converted.value;
    });
    if (version === 1 && value.kind === "integration") {
      const converted = convertLegacyIntegration(value);
      developmentRewrite ||= converted.developmentRewrite;
      Object.assign(value, converted.value);
      for (const key of Object.keys(value)) if (!(key in converted.value)) delete value[key];
    }
    if (pinned !== undefined) {
      if (value.kind !== "schema" || typeof pinned !== "string" || !/^schemas\/[a-zA-Z0-9_/-]+\.graphql$/.test(pinned)) throw new Error();
      value.pinnedSdl = readSdl(pinned);
    }
    if (schema !== undefined) {
      if (value.kind !== "api-schema" || typeof schema !== "string" || !/^schemas\/[a-zA-Z0-9_/-]+\.openapi$/.test(schema)) throw new Error();
      value.document = readSdl(schema);
    }
    const sourceVersion = version as ProjectFormatVersion;
    const parsed = resourceSchema.parse(sourceVersion === 1 ? normalizeLegacyResource(value) : value);
    if (sourceVersion === 2) validateV2ResourceDefinition(parsed);
    return decoded(parsed, sourceVersion, developmentRewrite);
  } catch { throw new Error("Invalid Purr resource definition. The original file has not been changed."); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid legacy definition.");
  return value as Record<string, unknown>;
}
function normalizeLegacyCredential(value: unknown, sensitive: boolean): unknown {
  const credential = typeof value === "string" ? { kind: "plain", value } : object(value);
  return sensitive && credential.kind === "plain" && typeof credential.value === "string" && isPureTemplateReference(credential.value)
    ? { kind: "template", value: credential.value } : credential;
}
function normalizeLegacyHeaders(value: unknown): unknown {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid legacy headers.");
  return value.map((candidate, index) => {
    const { secret, ...row } = object(candidate);
    const cookie = typeof row.name === "string" && ["cookie", "set-cookie"].includes(row.name.trim().toLowerCase());
    const sensitive = cookie || (row.sensitive ?? (secret === true || typeof row.value === "object" && row.value !== null && object(row.value).kind === "secret"));
    return { ...row, id: row.id ?? `legacy-header-${index}`, sensitive, value: normalizeLegacyCredential(row.value, sensitive === true) };
  });
}
function normalizeLegacyAuth(value: unknown): unknown {
  if (value === undefined) return value;
  const auth = { ...object(value) };
  const field = ({ bearer: "token", basic: "password", "api-key": "value", oauth2: "clientSecret" } as Record<string, string>)[String(auth.type)];
  if (field) auth[field] = normalizeLegacyCredential(auth[field], true);
  return auth;
}
/** Pure conversion only: refs are assigned by the owning application commit. */
export function normalizeLegacyWorkspace(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value, headers: normalizeLegacyHeaders(value.headers), ...(Array.isArray(value.auth) ? {
    auth: value.auth.map((candidate) => { const row = object(candidate); return { ...row, config: normalizeLegacyAuth(row.config) }; }),
  } : {}) };
}
export function normalizeLegacyResource(value: Record<string, unknown>): Record<string, unknown> {
  if (value.kind === "http" || value.kind === "graphql") return { ...value, headers: normalizeLegacyHeaders(value.headers),
    ...(value.auth !== undefined ? { auth: normalizeLegacyAuth(value.auth) } : {}) };
  if (value.kind === "schema") {
    const source = object(value.source);
    return { ...value, introspectionHeaders: normalizeLegacyHeaders(value.introspectionHeaders),
      ...(value.auth !== undefined ? { auth: normalizeLegacyAuth(value.auth) } : {}),
      source: source.type === "registry" && source.credential !== undefined ? { ...source, credential: normalizeLegacyCredential(source.credential, true) } : source };
  }
  if (value.kind === "integration" && value.credentials !== undefined) return { ...value,
    credentials: Object.fromEntries(Object.entries(object(value.credentials)).map(([key, credential]) => [key, normalizeLegacyCredential(credential, true)])) };
  return value;
}
function legacyCredential(value: unknown): unknown {
  const credential = object(value);
  return credential.kind === "template" ? { kind: "plain", value: credential.value } : credential;
}
function legacyAuth(value: unknown): unknown {
  if (value === undefined) return value;
  const auth = { ...object(value) };
  const field = ({ bearer: "token", basic: "password", "api-key": "value", oauth2: "clientSecret" } as Record<string, string>)[String(auth.type)];
  if (field) auth[field] = legacyCredential(auth[field]);
  return auth;
}
function legacyHeaders(value: unknown, kind: "request" | "workspace" | "schema"): unknown {
  return (value as Record<string, unknown>[]).map((row) => {
    const { sensitive: _sensitive, id, ...rest } = row;
    const credential = object(row.value);
    if (kind === "schema") return { ...rest, id, value: legacyCredential(credential) };
    if (credential.kind === "secret") throw new Error("Protected header references cannot be written in the legacy format.");
    return { ...rest, ...(kind === "workspace" ? { id } : {}), value: credential.value };
  });
}
function legacyWorkspace(value: WorkspaceDefinition): Record<string, unknown> & { headers: unknown[]; auth: unknown[] } {
  return { ...value, headers: legacyHeaders(value.headers, "workspace") as unknown[],
    auth: value.auth.map((row) => ({ ...row, config: legacyAuth(row.config) })) };
}
function legacyResource(value: ProjectResource): Record<string, unknown> {
  if (value.kind === "http" || value.kind === "graphql") return { ...value, headers: legacyHeaders(value.headers, "request"), auth: legacyAuth(value.auth) };
  if (value.kind === "schema") return { ...value, introspectionHeaders: legacyHeaders(value.introspectionHeaders, "schema"),
    ...(value.auth ? { auth: legacyAuth(value.auth) } : {}), source: value.source.type === "registry" && value.source.credential
      ? { ...value.source, credential: legacyCredential(value.source.credential) } : value.source };
  if (value.kind === "integration") return { ...value, credentials: Object.fromEntries(Object.entries(value.credentials).map(([key, credential]) => [key, legacyCredential(credential)])) };
  return value;
}

function convertLegacyIntegration(candidate: Record<string, unknown>): DevelopmentConversion<Record<string, unknown>> {
  const legacyEndpoint = candidate.endpoint;
  if (legacyEndpoint !== undefined && typeof legacyEndpoint !== "string") return { value: candidate, developmentRewrite: false };
  const config = candidate.config === undefined ? {} : candidate.config;
  const configObject = config && typeof config === "object" && !Array.isArray(config) ? config as Record<string, unknown> : undefined;
  const developmentRewrite = "endpoint" in candidate || !("configVersion" in candidate) || !("config" in candidate);
  if (!developmentRewrite) return { value: candidate, developmentRewrite: false };
  const { endpoint: _endpoint, ...rest } = candidate;
  return {
    value: {
      ...rest,
      enabled: candidate.enabled ?? true,
      configVersion: candidate.configVersion ?? 1,
      config: legacyEndpoint === undefined || !configObject || "endpoint" in configObject ? config : { endpoint: legacyEndpoint, ...configObject },
    },
    developmentRewrite: true,
  };
}

function convertDevelopmentVariable(candidate: unknown): DevelopmentConversion<unknown> {
  if (!candidate || typeof candidate !== "object") return { value: candidate, developmentRewrite: false };
  const row = candidate as Record<string, unknown>;
  if (typeof row.kind === "string" && ["static", "dynamic-request", "external-secret"].includes(row.kind)) return { value: candidate, developmentRewrite: false };
  const source = row.source as Record<string, unknown> | undefined;
  if (source?.type === "value") return { value: { id: row.id, name: row.name, enabled: row.enabled, kind: "static", value: source.value ?? "" }, developmentRewrite: true };
  if (source?.type === "local-secret") return { value: { id: row.id, name: row.name, enabled: row.enabled, sensitive: true, kind: "static", secretRef: source.ref }, developmentRewrite: true };
  if (source?.type === "dynamic-request") return { value: { id: row.id, name: row.name, enabled: row.enabled, sensitive: source.sensitive === true,
    kind: "dynamic-request", documentId: source.documentId ?? "", expression: source.expression ?? "$", language: source.language ?? "jsonpath",
    refresh: ({ "on-demand": "every-time", always: "every-time", once: "session", cache: "cache" } as Record<string, string>)[String(source.execution)] ?? "every-time",
    ...(source.execution === "cache" ? { cacheTtlSeconds: 300 } : {}), environment: source.environment ?? { type: "current" } }, developmentRewrite: true };
  if (source?.type === "external-secret") return { value: { id: row.id, name: row.name, enabled: row.enabled, sensitive: true, kind: "external-secret", provider: source.provider ?? "", key: source.key ?? "" }, developmentRewrite: true };
  const credential = row.value as { kind?: string; value?: string; ref?: string } | undefined;
  if (credential?.kind === "secret") return { value: { id: row.id, name: row.name, enabled: row.enabled, sensitive: true, kind: "static", secretRef: credential.ref }, developmentRewrite: true };
  if (credential?.kind === "plain") return { value: { id: row.id, name: row.name, enabled: row.enabled, kind: "static", value: credential.value ?? "" }, developmentRewrite: true };
  return { value: candidate, developmentRewrite: false };
}
function convertDevelopmentAuth(candidate: unknown): DevelopmentConversion<unknown> {
  if (!candidate || typeof candidate !== "object") return { value: candidate, developmentRewrite: false };
  const row = candidate as Record<string, unknown>; const config = row.config;
  if (!config || typeof config !== "object" || Array.isArray(config) || !("response" in config)) return { value: candidate, developmentRewrite: false };
  const { response: _obsoleteResponse, ...canonicalConfig } = config as Record<string, unknown>;
  return { value: { ...row, config: canonicalConfig }, developmentRewrite: true };
}
export function pinnedSchemaPath(text: string): string | undefined {
  const value = parse(text);
  return typeof value.pinned === "string" ? value.pinned : typeof value.schema === "string" ? value.schema : undefined;
}
