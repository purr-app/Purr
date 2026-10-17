import { useState, type ReactNode } from "react";
import { ChangeIndicator, CodeComparison } from "./diff-content";
import type { DiffLanguage } from "./diff-text";
import { formattedJson } from "./graphql-diff";
import { ArrowRight, ChevronRight } from "lucide-react";
import { getHttpMethodStyle } from "../../shared/model/http-method";
import { cn } from "../../shared/lib/cn";
import { diffRows, semanticKindLabel, type SemanticRow, type SemanticSection } from "./semantic-diff";
import { AttachmentValue, NamedEntryValue, record, TextValue, valueColor, type SemanticContext, type SemanticSide } from "./semantic-value";

type Props = { section: SemanticSection; unchanged: boolean } & SemanticContext;
const sides = (single?: SemanticSide): SemanticSide[] => single ? [single] : ["before", "after"];
const rowValue = (section: SemanticSection, key: string, side: SemanticSide) => section.rows.find((row) => row.key === key)?.[side];
const namedSections = new Set(["variables", "headers", "introspectionHeaders", "params", "pathParams"]);
const modeLabel = (value: unknown, body: boolean) => ({ none: body ? "No body" : "No auth", inherit: "Inherited", basic: "Basic", bearer: "Bearer", "api-key": "API key", oauth2: "OAuth 2.0", json: "JSON", xml: "XML", text: "Text", binary: "Binary", "form-data": "Multipart form", "form-urlencoded": "URL encoded", "url-encoded": "URL encoded" }[String(value)] ?? String(value ?? ""));

function ModeSummary({ section, single }: Props) {
  const before = rowValue(section, "type", "before"), after = rowValue(section, "type", "after");
  const body = section.key === "body";
  if (single || before === after) return <span className="text-ui-xs font-normal text-content-secondary">{modeLabel(single === "before" ? before : after ?? before, body)}</span>;
  return <span className="inline-flex items-center gap-ui-2 text-ui-xs font-normal"><span className={valueColor(before, after, "before")}>{modeLabel(before, body) || "—"}</span><ArrowRight className="size-ui-3 text-content-secondary" /><span className={valueColor(after, before, "after")}>{modeLabel(after, body) || "—"}</span></span>;
}
function InfoSummary({ section, single }: Props) {
  const side = single ?? "after";
  return <span className="min-w-0 truncate text-ui-xs font-normal text-content-secondary">{semanticKindLabel(rowValue(section, "kind", side))}<span className="mx-ui-2">·</span>{String(rowValue(section, "name", side) ?? "")}</span>;
}
function ColumnHeadings({ single, name = "Field" }: { single?: SemanticSide; name?: string }) {
  return <thead className="sr-only"><tr><th scope="col">{name}</th>{sides(single).map((side) => <th key={side} scope="col">{single ? "Value" : side === "before" ? "Before" : "After"}</th>)}</tr></thead>;
}
function FieldsTable({ rows, single, names, label }: { rows: SemanticRow[]; label: string } & SemanticContext) {
  if (!rows.length) return null;
  return <table aria-label={label} className="w-full table-fixed border-collapse text-left"><colgroup><col className="w-ui-semantic-label" />{sides(single).map((side) => <col key={side} />)}</colgroup><ColumnHeadings single={single} />
    <tbody className="divide-y divide-border-subtle">{rows.map((row) => <tr key={row.key}>
      <th scope="row" className="break-words px-ui-4 py-ui-2 align-middle font-ui text-ui-xs font-normal text-content-secondary"><span className="inline-flex items-center gap-ui-1">{!single && (row.before === undefined || row.after === undefined) && <ChangeIndicator side={row.before === undefined ? "after" : "before"} label={row.before === undefined ? "Added field" : "Removed field"} />}{row.label}</span></th>
      {sides(single).map((side) => <td key={side} className="min-w-0 break-words border-l border-border-subtle px-ui-3 py-ui-2 align-middle">
        <TextValue value={row[side]} other={row[side === "before" ? "after" : "before"]} side={side} single={single} code={!["name", "kind", "description", "scope", "format"].includes(row.key)} text={typeof row[side] === "boolean" ? row[side] ? "On" : "Off" : row.key === "kind" ? semanticKindLabel(row[side]) || "—" : typeof row[side] === "string" && /Id$/.test(row.key) ? names?.[String(row[side])] : undefined} />
      </td>)}
    </tr>)}</tbody>
  </table>;
}
function NamedTable({ rows, single, names, label }: { rows: SemanticRow[]; label: string } & SemanticContext) {
  const columnName = label === "Headers" || label === "Introspection headers" ? "Header" : label === "Variables" ? "Variable" : "Name";
  return <table aria-label={label} className="w-full table-fixed border-collapse text-left"><colgroup><col className="w-ui-semantic-label" />{sides(single).map((side) => <col key={side} />)}</colgroup><ColumnHeadings single={single} name={columnName} />
    <tbody className="divide-y divide-border-subtle">{rows.map((row) => {
      const beforeName = record(row.before).name, afterName = record(row.after).name;
      const renamed = typeof beforeName === "string" && typeof afterName === "string" && beforeName !== afterName;
      const added = !single && row.before === undefined, removed = !single && row.after === undefined;
      return <tr key={row.key}>
        <th scope="row" className="break-words px-ui-4 py-ui-3 align-middle font-code text-ui-sm font-medium text-content-primary">
          <span className="flex min-w-0 items-center gap-ui-1">
            {(added || removed) && <ChangeIndicator side={added ? "after" : "before"} label={added ? "Added field" : "Removed field"} />}
            {renamed ? <span className="min-w-0 whitespace-normal break-words"><span className="text-syntax-diff-removed-text">{beforeName || "(empty)"}</span><span className="mx-ui-1 font-ui text-content-secondary">→</span><span className="text-syntax-diff-added-text">{afterName || "(empty)"}</span></span> : <span className="min-w-0 break-words">{row.label || "(empty)"}</span>}
          </span>
          {row.moved && <span className="mt-ui-1 block font-ui text-ui-2xs font-normal text-content-secondary">Reordered</span>}
        </th>
        {sides(single).map((side) => <td key={side} className="min-w-0 break-words border-l border-border-subtle px-ui-3 py-ui-3 align-middle"><NamedEntryValue value={row[side]} other={row[side === "before" ? "after" : "before"]} side={side} single={single} names={names} /></td>)}
      </tr>;
    })}</tbody>
  </table>;
}
function Columns({ single, children }: { single?: SemanticSide; children: (side: SemanticSide) => ReactNode }) {
  return <div className={cn("grid divide-x divide-border-subtle", single ? "grid-cols-1" : "grid-cols-2")}>{sides(single).map((side) => <div key={side} aria-label={single ? "Content" : side === "before" ? "Before value" : "After value"} className="min-w-0 break-words px-ui-4 py-ui-3">{children(side)}</div>)}</div>;
}
function Endpoint({ row, single }: { row: SemanticRow } & SemanticContext) {
  return <Columns single={single}>{(side) => {
    const endpoint = record(row[side]), other = record(row[side === "before" ? "after" : "before"]);
    if (!endpoint.url && endpoint.url !== "") return <TextValue value={undefined} other={other} side={side} single={single} />;
    const method = String(endpoint.method ?? "GET");
    return <div className="flex items-start gap-ui-3 font-code text-ui-sm leading-relaxed"><span className={cn("shrink-0 font-medium", !single && endpoint.method !== other.method ? valueColor(endpoint.method, other.method, side) : getHttpMethodStyle(method).text)}>{method}</span><TextValue value={endpoint.url} other={other.url} side={side} single={single} /></div>;
  }}</Columns>;
}
function Payload({ row, single, opaque = false, language = "text", beforeLanguage = language, afterLanguage = language, replacement = false }: { row: SemanticRow; opaque?: boolean; language?: DiffLanguage; beforeLanguage?: DiffLanguage; afterLanguage?: DiffLanguage; replacement?: boolean } & SemanticContext) {
  const value = (side: SemanticSide) => {
    const content = row[side] === undefined ? "" : opaque ? JSON.stringify(row[side], null, 2) : String(row[side]);
    return (side === "before" ? beforeLanguage : afterLanguage) === "json" ? formattedJson(content) : content;
  };
  return <CodeComparison before={value("before")} after={value("after")} language={language} beforeLanguage={beforeLanguage} afterLanguage={afterLanguage} single={single} replacement={replacement} />;
}
function Body({ section, single, names, unchanged }: Props) {
  const fields = section.rows.find((row) => row.key === "fields");
  if (fields && (Array.isArray(fields.before) || Array.isArray(fields.after))) {
    const pairs = diffRows(Array.isArray(fields.before) ? fields.before : [], Array.isArray(fields.after) ? fields.after : []);
    return <NamedTable rows={pairs.filter((row) => single ? row[single] !== undefined : unchanged || section.rows.find((entry) => entry.key === "type")?.changed || row.changed)} single={single} names={names} label="Body fields" />;
  }
  const file = section.rows.find((row) => row.key === "file");
  if (file) return <Columns single={single}>{(side) => <AttachmentValue value={file[side]} other={file[side === "before" ? "after" : "before"]} side={side} single={single} />}</Columns>;
  const data = section.rows.find((row) => row.key === "data");
  if (data) {
    const language = (side: SemanticSide): DiffLanguage => { const mode = rowValue(section, "type", side); return mode === "json" ? "json" : mode === "xml" ? "xml" : "text"; };
    return <Payload row={data} single={single} language={language(single ?? "after")} beforeLanguage={language("before")} afterLanguage={language("after")} replacement={rowValue(section, "type", "before") !== rowValue(section, "type", "after")} />;
  }
  return <p className="m-ui-0 px-ui-4 py-ui-3 text-ui-sm text-content-secondary">No body</p>;
}
export function SemanticComparison({ section, unchanged, single, names }: Props) {
  const [expanded, setExpanded] = useState(() => !(single && (section.key === "info" || section.key.startsWith("sdl:"))) && section.changed);
  const context = { single, names };
  const rows = section.rows.filter((row) => single ? row[single] !== undefined : unchanged || row.changed);
  const kind = section.key;
  let content: ReactNode;
  if (kind.startsWith("sdl:")) content = <div className="divide-y divide-border-subtle">{rows.map((row) => <div key={row.key}><div className="px-ui-4 pt-ui-2 text-ui-xs text-content-secondary">{row.label}</div><Payload row={row} language="graphql" {...context} /></div>)}</div>;
  else if (namedSections.has(kind)) content = <NamedTable rows={rows} label={section.label} {...context} />;
  else if (kind === "url") content = <Endpoint row={section.rows[0]} {...context} />;
  else if (kind === "body") content = <Body section={section} unchanged={unchanged} {...context} />;
  else if (kind === "auth") content = <FieldsTable rows={section.rows.filter((row) => row.key !== "type" && (single ? row[single] !== undefined : row.before !== undefined || row.after !== undefined))} label="Authentication" {...context} />;
  else if (kind === "graphql") content = <div className="divide-y divide-border-subtle">
    <FieldsTable rows={rows.filter((row) => !["query", "variables"].includes(row.key))} label="GraphQL settings" {...context} />
    {rows.filter((row) => ["query", "variables"].includes(row.key) && (!single || row[single] !== "")).map((row) => <div key={row.key}><div className="px-ui-4 pt-ui-3 text-ui-xs font-medium text-content-secondary">{row.key === "query" ? "Query" : "Variables JSON"}</div><Payload row={row} language={row.key === "query" ? "graphql" : "json"} {...context} /></div>)}
  </div>;
  else if (["documentation", "description", "config"].includes(kind)) content = <Payload row={section.rows[0]} opaque={kind === "config"} {...context} />;
  else content = <FieldsTable rows={rows} label={section.label} {...context} />;
  const unchangedMode = section.rows.every((row) => !row.changed);
  const schemaEntity = kind.startsWith("sdl:");
  const entityLabel = section.label.indexOf(": ");
  return <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)} aria-label={section.label} className={cn("overflow-hidden bg-purr-surface", schemaEntity ? "group" : "rounded-ui-lg border border-border")}>
    <summary className={cn("ui-focus-ring ui-focus-ring-inset cursor-pointer text-content-primary", schemaEntity ? "list-none px-ui-4 py-ui-2 text-ui-sm hover:bg-purr-elevated group-open:bg-purr-elevated [&::-webkit-details-marker]:hidden" : "bg-purr-elevated px-ui-4 py-ui-3 text-ui-md font-medium")}>
      <span className={cn("items-center gap-ui-3 align-middle", schemaEntity ? "flex min-w-0" : "inline-flex max-w-full")}>
        {schemaEntity && <ChevronRight aria-hidden className="size-ui-3-5 shrink-0 text-content-secondary transition-transform duration-ui-fast group-open:rotate-90" />}
        {schemaEntity ? <span className="min-w-0 flex-1 break-words">{entityLabel >= 0 && <span className="mr-ui-2 text-ui-xs text-content-secondary">{section.label.slice(0, entityLabel + 1)}</span>}<span className="font-code font-medium">{entityLabel >= 0 ? section.label.slice(entityLabel + 2) : section.label}</span></span> : <span className="shrink-0">{section.label}</span>}
        {kind === "info" && single ? <InfoSummary section={section} unchanged={unchanged} {...context} /> : ["body", "auth"].includes(kind) ? <ModeSummary section={section} unchanged={unchanged} {...context} /> : null}
        {single && schemaEntity && <span className="shrink-0 text-ui-xs font-normal text-content-secondary">{section.rows.filter((row) => !["declaration", "description"].includes(row.key)).length} members</span>}
        {!single && <span className="shrink-0 font-code text-ui-xs font-normal text-content-secondary">{unchangedMode ? "unchanged" : `${section.rows.filter((row) => row.changed).length}${schemaEntity ? " changes" : ""}`}</span>}
      </span>
    </summary>
    {expanded && <div className="border-t border-border-subtle">{content}</div>}
  </details>;
}
