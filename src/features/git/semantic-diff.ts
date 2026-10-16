import { parseDocument } from "yaml";
import { deserializeManifest, deserializeResourceFile } from "../../storage/yaml";

export type SemanticRow = { key: string; label: string; before: unknown; after: unknown; changed: boolean; moved: boolean };
export type SemanticSection = { key: string; label: string; rows: SemanticRow[]; changed: boolean };
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
export function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "";
}
export function semanticValue(text: string): ObjectValue | null {
  if (!text.trim()) return {};
  try {
    const document = parseDocument(text, { uniqueKeys: true, strict: true, logLevel: "silent" });
    if (document.errors.length || document.warnings.length) return null;
    const raw: unknown = document.toJS({ maxAliasCount: 0 });
    if (!object(raw) || ![1, 2].includes(Number(raw.purr))) return null;
    if ("workspace" in raw) return { ...deserializeManifest(text), kind: "workspace" };
    const value = deserializeResourceFile(text, () => "").value;
    return { ...value, ...(typeof raw.pinned === "string" ? { schemaFile: raw.pinned } : {}), ...(typeof raw.schema === "string" ? { schemaFile: raw.schema } : {}) };
  } catch { return null; }
}
const labels: Record<string, string> = { name: "Name", description: "Description", folderId: "Folder", method: "Method", url: "URL", params: "Query parameters", pathParams: "Path parameters", headers: "Headers", auth: "Authentication", body: "Body", graphql: "GraphQL", variables: "Variables", settings: "Settings", documentation: "Documentation", overrides: "Inheritance", environmentId: "Environment", endpoint: "Endpoint", source: "Source", pin: "Pin schema", schemaFile: "Schema file", introspectionHeaders: "Introspection headers", config: "Configuration", defaultGraphqlSchemaId: "Default schema", tracePropagation: "Trace propagation", tracing: "Tracing", origin: "Imported source", scope: "Scope", enabled: "Enabled", provider: "Provider", kind: "Type" };
const label = (key: string) => labels[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2");

/** Stable IDs where available; occurrence keys preserve duplicate ordered pairs. */
export function diffRows(before: unknown[], after: unknown[]): SemanticRow[] {
  const entries = (values: unknown[]) => {
    const occurrences = new Map<string, number>();
    return values.map((value, index) => {
      const row = object(value) ? value : { value };
      const identity = typeof row.id === "string" ? `id:${row.id}` : `name:${String(row.name ?? row.key ?? index)}`;
      const ordinal = occurrences.get(identity) ?? 0; occurrences.set(identity, ordinal + 1);
      return { key: `${identity}:${ordinal}`, value, label: String(row.name ?? row.key ?? row.id ?? index + 1) };
    });
  };
  const left = entries(before), right = entries(after);
  const leftMap = new Map(left.map((row) => [row.key, row])); const rightMap = new Map(right.map((row) => [row.key, row]));
  const commonLeft = left.filter((row) => rightMap.has(row.key)).map((row) => row.key); const commonRight = right.filter((row) => leftMap.has(row.key)).map((row) => row.key);
  return [...new Set([...right.map((row) => row.key), ...left.map((row) => row.key)])].map((key) => {
    const previous = leftMap.get(key), next = rightMap.get(key); const moved = Boolean(previous && next && commonLeft.indexOf(key) !== commonRight.indexOf(key));
    return { key, label: next?.label || previous?.label || "Unnamed", before: previous?.value, after: next?.value, moved, changed: moved || stableValue(previous?.value) !== stableValue(next?.value) };
  });
}
export function semanticSections(beforeText: string, afterText: string): SemanticSection[] | null {
  const before = semanticValue(beforeText), after = semanticValue(afterText);
  if (!before || !after) return null;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => !["id", "pinnedSdl", "document", "purr"].includes(key));
  const order = ["kind", "name", "description", "folderId", "method", "url", "params", "pathParams", "headers", "auth", "body", "graphql", "variables", "settings", "documentation"];
  keys.sort((a, b) => (order.includes(a) ? order.indexOf(a) : order.length) - (order.includes(b) ? order.indexOf(b) : order.length));
  return keys.map((key) => {
    const left = before[key], right = after[key];
    const rows = Array.isArray(left) || Array.isArray(right) ? diffRows(Array.isArray(left) ? left : [], Array.isArray(right) ? right : [])
      : ["body", "graphql", "settings", "auth"].includes(key) && (object(left) || object(right))
        ? [...new Set([...Object.keys(object(left) ? left : {}), ...Object.keys(object(right) ? right : {})])].map((field) => {
            const a = object(left) ? left[field] : undefined, b = object(right) ? right[field] : undefined;
            return { key: field, label: label(field), before: a, after: b, changed: stableValue(a) !== stableValue(b), moved: false };
          })
        : [{ key, label: label(key), before: left, after: right, changed: stableValue(left) !== stableValue(right), moved: false }];
    return { key, label: label(key), rows, changed: rows.some((row) => row.changed) };
  }).filter((section) => section.rows.length);
}
export function displayValue(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return value || "(empty)";
  if (object(value)) {
    if (value.kind === "secret" && typeof value.ref === "string") return `Stored credential · ${value.ref}`;
    const { id: _id, ...fields } = value;
    return JSON.stringify(fields, null, 2);
  }
  return JSON.stringify(value, null, 2) ?? "—";
}
