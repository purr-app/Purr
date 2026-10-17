import { parseDocument } from "yaml";
import { deserializeManifest, deserializeResourceFile } from "../../storage/yaml";
import { equalGraphql, equalJson } from "./graphql-diff";

export type SemanticRow = { key: string; label: string; before: unknown; after: unknown; changed: boolean; moved: boolean };
export type SemanticSection = { key: string; label: string; rows: SemanticRow[]; changed: boolean };
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
export function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "";
}
function previewHeaders(value: ObjectValue, source: ObjectValue): ObjectValue {
  const result = { ...value };
  for (const key of ["headers", "introspectionHeaders"]) {
    const originals = source[key], headers = value[key];
    if (!Array.isArray(originals) || !Array.isArray(headers)) continue;
    result[key] = headers.map((header, index) => {
      // Legacy codecs generate positional IDs. They are not rename identities.
      if (!object(header) || object(originals[index]) && typeof originals[index].id === "string") return header;
      const { id: _generated, ...fields } = header;
      return fields;
    });
  }
  return result;
}
export function semanticValue(text: string): ObjectValue | null {
  if (!text.trim()) return {};
  try {
    const document = parseDocument(text, { uniqueKeys: true, strict: true, logLevel: "silent" });
    if (document.errors.length || document.warnings.length) return null;
    const raw: unknown = document.toJS({ maxAliasCount: 0 });
    if (!object(raw) || ![1, 2].includes(Number(raw.purr))) return null;
    if ("workspace" in raw) {
      const value = { ...deserializeManifest(text), kind: "workspace" };
      return raw.purr === 1 ? previewHeaders(value, { ...(object(raw.workspace) ? raw.workspace : {}), ...(object(raw.defaults) ? raw.defaults : {}) }) : value;
    }
    const value = deserializeResourceFile(text, () => "").value;
    return { ...(raw.purr === 1 ? previewHeaders(value, raw) : value), ...(typeof raw.pinned === "string" ? { schemaFile: raw.pinned } : {}), ...(typeof raw.schema === "string" ? { schemaFile: raw.schema } : {}) };
  } catch { return null; }
}
const labels: Record<string, string> = { username: "Username", password: "Password", token: "Token", clientId: "Client ID", clientSecret: "Client secret", tokenUrl: "Token URL", authorizationUrl: "Authorization URL", scopes: "Scopes", grantType: "Grant", prefix: "Prefix", autoRefresh: "Auto refresh", profileId: "Profile", operation: "Operation", schemaId: "Schema", name: "Name", description: "Description", folderId: "Folder", method: "Method", url: "URL", params: "Query parameters", pathParams: "Path parameters", headers: "Headers", auth: "Authentication", body: "Body", graphql: "GraphQL", variables: "Variables", settings: "Settings", documentation: "Documentation", overrides: "Inheritance", environmentId: "Environment", endpoint: "Endpoint", source: "Source", pin: "Pin schema", schemaFile: "Schema file", introspectionHeaders: "Introspection headers", config: "Configuration", defaultGraphqlSchemaId: "Default schema", tracePropagation: "Trace propagation", tracing: "Tracing", origin: "Imported source", timeoutMs: "Timeout (ms)", followRedirects: "Follow redirects", scope: "Scope", enabled: "Enabled", provider: "Provider", kind: "Type" };
const label = (key: string) => labels[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase());

/** Match entities, never infer a rename from position or a duplicate name. */
export function diffRows(before: unknown[], after: unknown[]): SemanticRow[] {
  const entries = (values: unknown[]) => values.map((value, index) => {
    const row = object(value) ? value : {};
    const id = typeof row.id === "string" && row.id ? row.id : undefined;
    const name = typeof row.name === "string" ? row.name : typeof row.key === "string" ? row.key : undefined;
    const { id: _identity, ...fields } = row;
    return { value, index, id, name, content: object(value) ? fields : value, label: String(name ?? id ?? index + 1) };
  });
  const left = entries(before), right = entries(after);
  type Entry = typeof left[number];
  const count = (rows: Entry[], field: "id" | "name") => {
    const counts = new Map<string, number>();
    for (const row of rows) if (row[field] !== undefined) counts.set(row[field]!, (counts.get(row[field]!) ?? 0) + 1);
    return counts;
  };
  const idsA = count(left, "id"), idsB = count(right, "id"), namesA = count(left, "name"), namesB = count(right, "name");
  const leftIds = new Map(left.map((row) => [row.id, row]));
  const matches = new Map<number, Entry>(), used = new Set<number>();
  const match = (a: Entry, b: Entry) => { matches.set(b.index, a); used.add(a.index); };
  for (const b of right) {
    if (b.id !== undefined && idsA.get(b.id) === 1 && idsB.get(b.id) === 1) match(leftIds.get(b.id)!, b);
  }
  // Exact copies remain identifiable among duplicate names, even after a move.
  const fallback = (a: Entry, b: Entry) => !used.has(a.index) && (a.id === undefined || b.id === undefined) && a.name === b.name;
  for (const b of right) if (!matches.has(b.index)) {
    const a = left.find((candidate) => fallback(candidate, b) && stableValue(candidate.content) === stableValue(b.content));
    if (a) match(a, b);
  }
  // A unique unchanged name can pair a value/metadata edit without a stable ID.
  // Ambiguous duplicate edits stay separate additions/removals.
  for (const b of right) if (!matches.has(b.index) && b.name !== undefined && namesA.get(b.name) === 1 && namesB.get(b.name) === 1) {
    const a = left.find((candidate) => fallback(candidate, b));
    if (a) match(a, b);
  }
  const commonLeft = left.filter((row) => used.has(row.index)).map((row) => row.index);
  const commonRight = right.flatMap((row) => matches.has(row.index) ? [matches.get(row.index)!.index] : []);
  const previousOrder = new Map(commonLeft.map((index, order) => [index, order]));
  const nextOrder = new Map(commonRight.map((index, order) => [index, order]));
  const row = (a: Entry | undefined, b: Entry | undefined): SemanticRow => {
    const moved = Boolean(a && b && previousOrder.get(a.index) !== nextOrder.get(a.index));
    const key = a && b && a.id && a.id === b.id ? `id:${a.id}` : a ? `before:${a.index}` : `after:${b!.index}`;
    return { key, label: b?.label ?? a!.label, before: a?.value, after: b?.value, moved, changed: moved || !a || !b || stableValue(a.content) !== stableValue(b.content) };
  };
  return [...right.map((b) => row(matches.get(b.index), b)), ...left.filter((a) => !used.has(a.index)).map((a) => row(a, undefined))];
}
export function semanticSections(beforeText: string, afterText: string): SemanticSection[] | null {
  const before = semanticValue(beforeText), after = semanticValue(afterText);
  if (!before || !after) return null;
  const mirroredQuery = (value: ObjectValue) => {
    if (typeof value.url !== "string") return false;
    const query = value.url.split("#", 1)[0].split("?").slice(1).join("?");
    const params = (Array.isArray(value.params) ? value.params : []).filter((item) => object(item) && item.enabled !== false).map((item) => [item.name, item.value]);
    return stableValue([...new URLSearchParams(query).entries()]) === stableValue(params);
  };
  // Older files mirrored enabled rows into URL. Compare each endpoint without
  // its mirrored query, including comparisons against the separated encoding.
  const representedQuery = (value: ObjectValue) => !String(value.url ?? "").split("#", 1)[0].includes("?") || mirroredQuery(value);
  const omitQuery = representedQuery(before) && representedQuery(after);
  const endpoint = (value: ObjectValue) => "url" in value ? { method: value.method, url: omitQuery ? String(value.url).replace(/\?[^#]*(?=#|$)/, "") : value.url } : undefined;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => !["id", "pinnedSdl", "document", "purr", ...("url" in before || "url" in after ? ["method"] : [])].includes(key));
  const infoKeys = new Set(["kind", "name", "description", "folderId", "scope", "origin", "format", "extensionType", "configVersion", "provider", "enabled"]);
  const settingKeys = new Set(["settings", "overrides", "environmentId", "defaultGraphqlSchemaId", "tracing", "tracePropagation"]);
  const connectionKeys = new Set(["endpoint", "source", "pin", "schemaFile"]);
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const group = infoKeys.has(key) ? "info" : settingKeys.has(key) ? "settings" : connectionKeys.has(key) ? "connection" : key;
    groups.set(group, [...groups.get(group) ?? [], key]);
  }
  const order = ["info", "url", "connection", "params", "pathParams", "headers", "auth", "body", "graphql", "variables", "settings", "documentation"];
  return [...groups.entries()].sort(([a], [b]) => (order.includes(a) ? order.indexOf(a) : order.length) - (order.includes(b) ? order.indexOf(b) : order.length)).map(([key, fields]) => {
    const left = before[key], right = after[key];
    const row = (field: string, a: unknown, b: unknown): SemanticRow => {
      let changed = stableValue(a) !== stableValue(b);
      if (typeof a === "string" && typeof b === "string") {
        if (key === "graphql" && field === "query") changed = !equalGraphql(a, b);
        const jsonPayload = key === "body" && field === "data" && object(left) && left.type === "json" && object(right) && right.type === "json";
        if (key === "graphql" && field === "variables" || jsonPayload) changed = !equalJson(a, b);
      }
      return { key: field, label: label(field), before: a, after: b, changed, moved: false };
    };
    const groupedRows = () => fields.flatMap((field) => {
      const a = before[field], b = after[field];
      if (!["settings", "overrides", "tracing", "source"].includes(field) || !object(a) && !object(b)) return [row(field, a, b)];
      return [...new Set([...Object.keys(object(a) ? a : {}), ...Object.keys(object(b) ? b : {})])].map((property) => {
        const result = row(field === "settings" ? property : `${field}.${property}`, object(a) ? a[property] : undefined, object(b) ? b[property] : undefined);
        result.label = field === "overrides" ? ({ headers: "Shared headers", auth: "Shared authentication", cookies: "Cookie jar", excludedHeaderIds: "Excluded headers" }[property] ?? label(property))
          : field === "tracing" ? property === "enabled" ? "Tracing" : "Tracing integration" : field === "source" && property === "type" ? "Source" : label(property);
        return result;
      });
    });
    const rows = key === "info" ? fields.map((field) => row(field, before[field], after[field]))
      : ["settings", "connection"].includes(key) ? groupedRows()
      : key === "url" ? [row(key, endpoint(before), endpoint(after))]
      : Array.isArray(left) || Array.isArray(right) ? diffRows(Array.isArray(left) ? left : [], Array.isArray(right) ? right : [])
      : ["body", "graphql", "settings", "auth", "overrides"].includes(key) && (object(left) || object(right))
        ? [...new Set([...Object.keys(object(left) ? left : {}), ...Object.keys(object(right) ? right : {})])].map((field) => row(field, object(left) ? left[field] : undefined, object(right) ? right[field] : undefined))
        : [row(key, left, right)];
    return { key, label: key === "info" ? "Info" : key === "connection" ? "Schema source" : label(key), rows, changed: rows.some((row) => row.changed) };
  }).filter((section) => section.rows.length);
}

/** New-file previews omit empty optional configuration, not explicit changed values. */
export function hasSemanticContent(section: SemanticSection, side: "before" | "after"): boolean {
  if (["auth", "body"].includes(section.key)) {
    const mode = section.rows.find((row) => row.key === "type")?.[side];
    if (mode === "none") return false;
  }
  return section.rows.some((row) => {
    const value = row[side];
    return value !== undefined && value !== "" && value !== null && (!Array.isArray(value) || value.length > 0) && (!object(value) || Object.keys(value).length > 0);
  });
}

export function displayValue(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return value || "(empty)";
  if (object(value)) {
    if (["plain", "template"].includes(String(value.kind))) return String(value.value ?? "(empty)");
    if (value.kind === "secret" && typeof value.ref === "string") return `Stored credential · ${value.ref}`;
    if (typeof value.name === "string" && ("value" in value || "secretRef" in value || "file" in value)) {
      const content = typeof value.secretRef === "string" ? `Stored credential · ${value.secretRef}`
        : object(value.value) && value.value.kind === "plain" ? String(value.value.value ?? "")
          : object(value.value) && value.value.kind === "template" ? String(value.value.value ?? "")
            : object(value.value) && value.value.kind === "secret" ? `Stored credential · ${value.value.ref}`
              : typeof value.value === "string" ? value.value : object(value.file) ? String(value.file.name ?? "File") : "";
      return `${value.name}: ${content || "(empty)"}${value.enabled === false ? "\nDisabled" : ""}`;
    }
    const { id: _id, ...fields } = value;
    return JSON.stringify(fields, null, 2);
  }
  return JSON.stringify(value, null, 2) ?? "—";
}


export const semanticKindLabel = (value: unknown): string => ({ http: "HTTP request", graphql: "GraphQL request", environment: "Environment", workspace: "Workspace", schema: "GraphQL schema", "api-schema": "API schema", folder: "Folder", extension: "Extension document" }[String(value)] ?? String(value ?? ""));
export function variableRefresh(value: Record<string, unknown>): string {
  if (value.refresh === "cache") return value.cacheTtlSeconds ? `Cache ${value.cacheTtlSeconds}s` : "Cached";
  return value.refresh === "session" ? "Once per session" : "Every request";
}
