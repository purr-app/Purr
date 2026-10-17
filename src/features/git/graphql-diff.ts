import { Kind, parse, print, visit, type ASTNode } from "graphql";
import type { SemanticRow, SemanticSection } from "./semantic-diff";

/** Parsing is syntactic only: partial SDL need not build a complete executable schema. */
export function normalizedGraphql(source: string): string | null {
  if (!source.trim()) return "";
  try { return print(parse(source)); } catch { return null; }
}
export function equalGraphql(before: string, after: string): boolean {
  const left = normalizedGraphql(before), right = normalizedGraphql(after);
  return left !== null && right !== null ? left === right : before === after;
}
export function equalJson(before: string, after: string): boolean {
  try { return stableJson(JSON.parse(before)) === stableJson(JSON.parse(after)); } catch { return before === after; }
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function formattedJson(source: string): string {
  try { return JSON.stringify(JSON.parse(source), null, 2); } catch { return source; }
}

type SchemaEntity = { label: string; rows: Map<string, { label: string; value: string }> };
const entityLabels: Record<string, string> = { ObjectType: "Type", InterfaceType: "Interface", InputObjectType: "Input", EnumType: "Enum", UnionType: "Union", ScalarType: "Scalar", Directive: "Directive", Schema: "Schema" };
// SDL argument order carries no meaning. Match names even after reordering;
// request selection/argument ordering and the exact SDL view remain untouched.
const byName = (a: { name: { value: string } }, b: { name: { value: string } }) => a.name.value.localeCompare(b.name.value);
function structuralPrint(node: ASTNode): string {
  return print(visit(node, {
    FieldDefinition: (field) => ({ ...field, arguments: [...field.arguments ?? []].sort(byName) }),
    DirectiveDefinition: (directive) => ({ ...directive, arguments: [...directive.arguments ?? []].sort(byName) }),
    Directive: (directive) => ({ ...directive, arguments: [...directive.arguments ?? []].sort(byName) }),
  }));
}
function schemaEntities(source: string): Map<string, SchemaEntity> | null {
  if (!source.trim()) return new Map();
  try {
    const entities = new Map<string, SchemaEntity>();
    for (const definition of parse(source).definitions) {
      if (definition.kind === Kind.OPERATION_DEFINITION || definition.kind === Kind.FRAGMENT_DEFINITION) return null;
      // Match a type and its extensions by the same GraphQL entity identity.
      const family = definition.kind.replace(/(Definition|Extension)$/, "");
      const name = "name" in definition ? definition.name.value : "schema";
      const key = `${family}:${name}`;
      const entity = entities.get(key) ?? { label: family === "Schema" ? "Schema" : `${entityLabels[family] ?? family}: ${name}`, rows: new Map() };
      const add = (id: string, label: string, value: string) => {
        const previous = entity.rows.get(id);
        // Repeated declarations can occur across extensions; never silently drop them.
        entity.rows.set(id, { label, value: previous ? `${previous.value}\n${value}` : value });
      };
      const header = { ...definition, description: undefined, fields: undefined, values: undefined, types: undefined, arguments: undefined, operationTypes: undefined } as unknown as ASTNode;
      add("declaration", "Declaration", structuralPrint(header));
      if ("description" in definition && definition.description) add("description", "Description", print(definition.description));
      const members: [string, string, readonly ASTNode[] | undefined][] = [
        ["field", family === "InputObjectType" ? "Input" : "Field", "fields" in definition ? definition.fields : undefined],
        ["value", "Value", "values" in definition ? definition.values : undefined],
        ["member", "Member", "types" in definition ? definition.types : undefined],
        ["argument", "Argument", "arguments" in definition ? definition.arguments : undefined],
        ["operation", "Operation", "operationTypes" in definition ? definition.operationTypes : undefined],
      ];
      for (const [prefix, label, nodes] of members) for (const node of nodes ?? []) {
        const memberName = "name" in node && node.name && typeof node.name === "object" && "value" in node.name ? String(node.name.value) : "operation" in node ? String(node.operation) : print(node);
        add(`${prefix}:${memberName}`, `${label} ${memberName}`, structuralPrint(node));
      }
      entities.set(key, entity);
    }
    return entities;
  } catch { return null; }
}

/** Only the changed GraphQL entities/members are expanded by the shared semantic UI. */
export function schemaSections(before: string, after: string): SemanticSection[] | null {
  const left = schemaEntities(before), right = schemaEntities(after);
  if (!left || !right) return null;
  return [...new Set([...right.keys(), ...left.keys()])].map((key) => {
    const a = left.get(key), b = right.get(key);
    const rows: SemanticRow[] = [...new Set([...b?.rows.keys() ?? [], ...a?.rows.keys() ?? []])].map((id) => {
      const previous = a?.rows.get(id), next = b?.rows.get(id);
      return { key: id, label: next?.label ?? previous!.label, before: previous?.value, after: next?.value, changed: previous?.value !== next?.value, moved: false };
    });
    return { key: `sdl:${key}`, label: b?.label ?? a!.label, rows, changed: rows.some((row) => row.changed) };
  });
}
