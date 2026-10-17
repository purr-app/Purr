import { Fragment, useMemo } from "react";
import { diff as compareText } from "@codemirror/merge";
import { getHttpMethodStyle } from "../../shared/model/http-method";
import { cn } from "../../shared/lib/cn";
import { displayValue, semanticRowFields, type SemanticRow, type SemanticSection } from "./semantic-diff";

function ChangedText({ before, after, side }: { before: string; after: string; side: "before" | "after" }) {
  const changes = useMemo(() => compareText(before, after, { scanLimit: 1000, timeout: 20 }), [before, after]);
  const value = side === "before" ? before : after;
  let offset = 0;
  const parts = changes.map((change, index) => {
    const from = side === "before" ? change.fromA : change.fromB;
    const to = side === "before" ? change.toA : change.toB;
    const unchanged = value.slice(offset, from); offset = to;
    return <Fragment key={index}>{unchanged}{to > from && <span className={side === "before" ? "rounded-ui-sm bg-syntax-diff-removed text-content-primary line-through decoration-accent-red" : "rounded-ui-sm bg-syntax-diff-added text-content-primary"}>{value.slice(from, to)}</span>}</Fragment>;
  });
  return <>{parts}{value.slice(offset) || (!value && "—")}</>;
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
function ValuePair({ row, endpoint, single, names }: { row: SemanticRow; endpoint: boolean; single?: "before" | "after"; names?: Record<string, string> }) {
  const content = (side: "before" | "after") => {
    if (endpoint) {
      const current = record(row[side]), other = record(row[side === "before" ? "after" : "before"]);
      if (typeof current.url !== "string") return <span className="text-content-secondary">—</span>;
      const method = String(current.method ?? "GET");
      return <div className="flex items-start gap-ui-3">
        <span className={cn("shrink-0 font-medium", getHttpMethodStyle(method).text)}>{single ? method : <ChangedText before={String(side === "before" ? current.method ?? "GET" : other.method ?? "")} after={String(side === "after" ? current.method ?? "GET" : other.method ?? "")} side={side} />}</span>
        <span className="min-w-0 whitespace-pre-wrap break-words">{single ? current.url : <ChangedText before={String(record(row.before).url ?? "")} after={String(record(row.after).url ?? "")} side={side} />}</span>
      </div>;
    }
    const display = (value: unknown) => row.key === "documentId" && typeof value === "string" && names?.[value] ? names[value] : displayValue(value);
    return <pre className="m-ui-0 whitespace-pre-wrap break-words font-code text-ui-sm leading-relaxed text-content-primary">{single ? display(row[side]) : <ChangedText before={row.before === undefined ? "" : display(row.before)} after={row.after === undefined ? "" : display(row.after)} side={side} />}</pre>;
  };
  return <div className={cn("grid gap-ui-3", !single && "grid-cols-1 lg:grid-cols-2")}>
    {(single ? [single] : ["before", "after"] as const).map((side) => <div key={side} className="min-w-0 rounded-ui-md border border-border bg-purr-codefield p-ui-4 font-code text-ui-sm text-content-primary">
      {!single && <div className="mb-ui-2 font-ui text-ui-xs font-medium text-content-secondary">{side === "before" ? "Before" : "After"}</div>}
      {content(side)}
    </div>)}
  </div>;
}
export function SemanticComparison({ section, unchanged, single, names }: { section: SemanticSection; unchanged: boolean; single?: "before" | "after"; names?: Record<string, string> }) {
  const named = ["variables", "headers", "introspectionHeaders", "params", "pathParams"].includes(section.key);
  return <details open={section.changed || Boolean(single)} className="overflow-hidden rounded-ui-lg border border-border bg-purr-surface">
    <summary className="ui-focus-ring cursor-pointer bg-purr-elevated px-ui-4 py-ui-3 text-ui-md font-medium text-content-primary">{section.label}{!single && <span className="ml-ui-3 font-code text-ui-xs text-content-secondary">{section.rows.filter((row) => row.changed).length || "unchanged"}</span>}</summary>
    <div className="divide-y divide-border border-t border-border">{section.rows.filter((row) => single ? row[single] !== undefined : unchanged || row.changed).map((row) => {
      const fields = named ? semanticRowFields(row, section.key) : [row];
      const visible = fields.filter((field) => single ? field[single] !== undefined : unchanged || field.changed);
      return <div key={row.key} className="space-y-ui-3 p-ui-4">
        {(named || section.rows.length > 1) && <div className="flex items-center gap-ui-2 text-ui-md font-medium text-content-primary"><span className={named ? "font-code" : "font-ui"}>{row.label}</span>{named && record(row.before).enabled === false && record(row.after).enabled === false && <span className="rounded-ui-md bg-purr-highlight px-ui-2 py-ui-1 font-ui text-ui-xs text-content-secondary">Disabled</span>}{row.moved && <span className="text-ui-xs text-accent-orange">Reordered</span>}</div>}
        {visible.map((field) => <div key={field.key} className="space-y-ui-2">
          {named && <div className="text-ui-xs font-medium text-content-secondary">{field.label}</div>}
          <ValuePair row={field} endpoint={section.key === "url"} single={single} names={names} />
        </div>)}
        {!visible.length && row.moved && <ValuePair row={fields[0] ?? row} endpoint={false} names={names} />}
      </div>;
    })}</div>
  </details>;
}
