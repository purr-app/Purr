import { parseDocument, stringify } from "yaml";
import { resourceSchema, workspaceDefinitionSchema, type ProjectResource, type WorkspaceDefinition } from "../domain/project";

export const projectFormatVersion = 1;
function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (child === undefined || Array.isArray(child) && !child.length || key === "enabled" && child === true) return [];
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
  const value = parse(text);
  try {
    if (Object.keys(value).some((key) => !["purr", "workspace", "defaults"].includes(key))) throw new Error();
    const defaults = value.defaults as Record<string, unknown> | undefined;
    return workspaceDefinitionSchema.parse({ ...(value.workspace as object), ...defaults });
  } catch { throw new Error("Invalid workspace manifest. The original file has not been changed."); }
}
export function serializeResource(resource: ProjectResource, sdlPath?: string): string {
  const validated = resourceSchema.parse(resource);
  if (validated.kind === "schema") {
    const { pinnedSdl, ...source } = validated;
    return yaml({ purr: projectFormatVersion, ...source, ...(pinnedSdl !== undefined && sdlPath ? { pinned: sdlPath } : {}) });
  }
  return yaml({ purr: projectFormatVersion, ...validated });
}
export function deserializeResource(text: string, readSdl: (path: string) => string = () => { throw new Error(); }): ProjectResource {
  const { purr: _version, pinned, ...value } = parse(text);
  try {
    if (pinned !== undefined) {
      if (value.kind !== "schema" || typeof pinned !== "string" || !/^schemas\/[a-zA-Z0-9_/-]+\.graphql$/.test(pinned)) throw new Error();
      value.pinnedSdl = readSdl(pinned);
    }
    return resourceSchema.parse(value);
  } catch { throw new Error("Invalid Purr resource definition. The original file has not been changed."); }
}
export function pinnedSchemaPath(text: string): string | undefined {
  const value = parse(text); return typeof value.pinned === "string" ? value.pinned : undefined;
}
