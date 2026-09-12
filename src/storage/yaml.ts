import { parseDocument, stringify } from "yaml";
import { resourceSchema, workspaceDefinitionSchema, type ProjectResource, type WorkspaceDefinition } from "../domain/project";

export type DecodedProjectFile<T> = { value: T; developmentRewrite: boolean };

export const projectFormatVersion = 1;
function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (child === undefined || Array.isArray(child) && !child.length || key === "enabled" && child === true || key === "sensitive" && child === false) return [];
    if (key === "body" && (child as { type?: string })?.type === "none") return [];
    return [[key, compact(child)]];
  }));
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
    if (value.purr !== projectFormatVersion) throw new Error("version");
    return value;
  } catch {
    // Never echo a YAML source excerpt: an external file may contain a credential.
    throw new Error("Invalid or unsupported Purr YAML. The original resource has not been changed.");
  }
}
export function serializeManifest(workspace: WorkspaceDefinition): string {
  const { headers, auth, ...identity } = workspaceDefinitionSchema.parse(workspace);
  return yaml({ purr: projectFormatVersion, workspace: identity, ...(headers.length || auth.length ? { defaults: { headers, auth } } : {}) });
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
    if (Array.isArray(workspace.variables)) workspace.variables = workspace.variables.map((candidate) => {
      const converted = convertDevelopmentVariable(candidate); developmentRewrite ||= converted.developmentRewrite; return converted.value;
    });
    if (Array.isArray(workspace.auth)) workspace.auth = workspace.auth.map((candidate) => {
      const converted = convertDevelopmentAuth(candidate); developmentRewrite ||= converted.developmentRewrite; return converted.value;
    });
    return { value: workspaceDefinitionSchema.parse(workspace), developmentRewrite };
  } catch { throw new Error("Invalid workspace manifest. The original file has not been changed."); }
}
export function serializeResource(resource: ProjectResource, sdlPath?: string): string {
  const validated = resourceSchema.parse(resource);
  if (validated.kind === "schema") {
    const { pinnedSdl, pin, ...source } = validated;
    return yaml({ purr: projectFormatVersion, ...source, ...(pin ? {} : { pin: false }), ...(pinnedSdl !== undefined && sdlPath ? { pinned: sdlPath } : {}) });
  }
  return yaml({ purr: projectFormatVersion, ...validated });
}
export function deserializeResource(text: string, readSdl: (path: string) => string = () => { throw new Error(); }): ProjectResource {
  return deserializeResourceFile(text, readSdl).value;
}
export function deserializeResourceFile(text: string, readSdl: (path: string) => string = () => { throw new Error(); }): DecodedProjectFile<ProjectResource> {
  const { purr: _version, pinned, ...value } = parse(text);
  try {
    let developmentRewrite = false;
    // Lightweight development transition only; the next save rewrites the
    // canonical shape and no production compatibility layer is retained.
    if (value.kind === "environment" && Array.isArray(value.variables)) value.variables = value.variables.map((candidate) => {
      const converted = convertDevelopmentVariable(candidate); developmentRewrite ||= converted.developmentRewrite; return converted.value;
    });
    if (pinned !== undefined) {
      if (value.kind !== "schema" || typeof pinned !== "string" || !/^schemas\/[a-zA-Z0-9_/-]+\.graphql$/.test(pinned)) throw new Error();
      value.pinnedSdl = readSdl(pinned);
    }
    return { value: resourceSchema.parse(value), developmentRewrite };
  } catch { throw new Error("Invalid Purr resource definition. The original file has not been changed."); }
}

function convertDevelopmentVariable(candidate: unknown): DecodedProjectFile<unknown> {
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
function convertDevelopmentAuth(candidate: unknown): DecodedProjectFile<unknown> {
  if (!candidate || typeof candidate !== "object") return { value: candidate, developmentRewrite: false };
  const row = candidate as Record<string, unknown>; const config = row.config;
  if (!config || typeof config !== "object" || Array.isArray(config) || !("response" in config)) return { value: candidate, developmentRewrite: false };
  const { response: _obsoleteResponse, ...canonicalConfig } = config as Record<string, unknown>;
  return { value: { ...row, config: canonicalConfig }, developmentRewrite: true };
}
export function pinnedSchemaPath(text: string): string | undefined {
  const value = parse(text); return typeof value.pinned === "string" ? value.pinned : undefined;
}
