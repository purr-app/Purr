import { File, LockKeyhole } from "lucide-react";
import { cn } from "../../shared/lib/cn";
import { displayValue, stableValue, variableRefresh } from "./semantic-diff";
import { InlineDiffText } from "./diff-content";

export type SemanticSide = "before" | "after";
export type SemanticContext = { single?: SemanticSide; names?: Record<string, string> };
export const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function valueColor(value: unknown, other: unknown, side: SemanticSide, single?: SemanticSide) {
  return value === undefined ? "text-content-tertiary" : !single && stableValue(value) !== stableValue(other) ? side === "before" ? "text-syntax-diff-removed-text" : "text-syntax-diff-added-text" : "text-content-primary";
}
function metadataColor(value: unknown, other: unknown, side: SemanticSide, single?: SemanticSide) {
  return single || stableValue(value) === stableValue(other) ? "text-content-secondary" : valueColor(value, other, side, single);
}
export function TextValue({ value, other, side, single, text, code = true }: { value: unknown; other: unknown; side: SemanticSide; single?: SemanticSide; text?: string; code?: boolean }) {
  single = other === undefined ? side : single;
  const item = record(value);
  if (item.kind === "secret" && typeof item.ref === "string") return <span title={item.ref} data-secret-change={!single && record(other).ref !== item.ref && other !== undefined ? side : undefined} className="inline-flex max-w-full items-center gap-ui-2 text-ui-sm text-content-primary"><LockKeyhole className={cn("size-ui-3-5 shrink-0", valueColor(value, other, side, single))} /><span>Stored credential</span></span>;
  return <span className={cn("min-w-0 whitespace-pre-wrap break-words text-ui-sm leading-relaxed", code ? "font-code" : "font-ui", value === undefined ? "text-content-tertiary" : "text-content-primary")}>{value === undefined ? "—" : text !== undefined ? <span className={valueColor(value, other, side, single)}>{text}</span> : <InlineDiffText value={displayValue(value)} other={displayValue(other)} side={side} single={other === undefined ? side : single} />}</span>;
}
export function AttachmentValue({ value, other, side, single }: { value: unknown; other: unknown; side: SemanticSide; single?: SemanticSide }) {
  const file = record(value);
  if (!file.name) return <TextValue value={undefined} other={other} side={side} single={single} />;
  return <div className="flex items-start gap-ui-2" title={String(file.id ?? "")}><File className={cn("mt-ui-1 size-ui-4 shrink-0", valueColor(value, other, side, single))} /><div className="min-w-0"><TextValue value={value} other={other} side={side} single={single} text={String(file.name)} /><div className="text-ui-xs text-content-secondary">{String(file.mediaType ?? "File")}</div></div></div>;
}
function EntryFlags({ value, other, side, single }: { value: Record<string, unknown>; other: Record<string, unknown>; side: SemanticSide; single?: SemanticSide }) {
  const flags = [
    value.enabled === false ? { key: "enabled", text: "Disabled" } : value.enabled === true && other.enabled === false ? { key: "enabled", text: "Enabled" } : null,
    value.sensitive === true ? { key: "sensitive", text: "Secret" } : value.sensitive === false && other.sensitive === true ? { key: "sensitive", text: "Public" } : null,
    value.kind === "static" && other.kind && other.kind !== "static" ? { key: "kind", text: "Static" } : null,
  ].filter((flag) => flag !== null);
  if (!flags.length) return null;
  return <span className="inline-flex flex-wrap items-center gap-ui-1">{flags.map((flag) => <span key={flag.key} className={cn("rounded-ui-sm border border-border px-ui-1 font-ui text-ui-2xs", valueColor(value[flag.key], other[flag.key], side, single))}>{flag.text}</span>)}</span>;
}

/** A variable is a value or an extraction recipe; its transport DTO is not UI. */
export function NamedEntryValue({ value, other, side, single, names }: { value: unknown; other: unknown; side: SemanticSide } & SemanticContext) {
  if (value === undefined) return <TextValue value={undefined} other={other} side={side} single={single} />;
  const entry = record(value), previous = record(other);
  single = other === undefined ? side : single;
  const flags = <EntryFlags value={entry} other={previous} side={side} single={single} />;
  if (entry.kind === "dynamic-request") {
    const source = String(entry.documentId ?? "");
    const environment = record(entry.environment), oldEnvironment = record(previous.environment);
    const environmentText = environment.type === "specific" ? names?.[String(environment.environmentId)] ?? String(environment.environmentId) : "Current environment";
    const refresh = variableRefresh(entry), oldRefresh = other === undefined ? undefined : variableRefresh(previous);
    return <div className="space-y-ui-1">
      <div className="flex flex-wrap items-center gap-x-ui-2 gap-y-ui-1 text-ui-xs text-content-secondary"><span>From</span><TextValue value={entry.documentId} other={previous.documentId} side={side} single={single} text={names?.[source] ?? source} code={false} />{flags}</div>
      <TextValue value={entry.expression} other={previous.expression} side={side} single={single} />
      <div className="flex flex-wrap items-center gap-x-ui-2 gap-y-ui-1 text-ui-xs text-content-secondary">
        <span className={metadataColor(entry.language, previous.language, side, single)}>{entry.language === "jq" ? "jq" : "JSONPath"}</span><span>·</span>
        <span className={metadataColor(refresh, oldRefresh, side, single)}>{refresh}</span><span>·</span>
        <span className={metadataColor(entry.environment, other === undefined ? undefined : oldEnvironment, side, single)}>{environmentText}</span>
      </div>
    </div>;
  }
  if (entry.kind === "external-secret") return <div className="space-y-ui-1"><div className="flex flex-wrap items-center gap-ui-2"><LockKeyhole className="size-ui-3-5 text-content-secondary" /><TextValue value={entry.provider} other={previous.provider} side={side} single={single} code={false} />{flags}</div><TextValue value={entry.key} other={previous.key} side={side} single={single} /></div>;
  const content = (item: Record<string, unknown>) => item.secretRef ? { kind: "secret", ref: item.secretRef } : item.value;
  return <div className="flex flex-wrap items-center gap-x-ui-3 gap-y-ui-1">
    {entry.file ? <AttachmentValue value={entry.file} other={previous.file} side={side} single={single} /> : <TextValue value={content(entry)} other={other === undefined ? undefined : content(previous)} side={side} single={single} />}
    {flags}
    {entry.contentType !== undefined && <span className={cn("font-code text-ui-xs", valueColor(entry.contentType, previous.contentType, side, single))}>{String(entry.contentType)}</span>}
  </div>;
}
