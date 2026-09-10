import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, GripHorizontal } from "lucide-react";
import { getNamedType, isEnumType, isInputObjectType, isInputType, isListType, isNonNullType, Kind, parse, print, typeFromAST, valueFromASTUntyped, type GraphQLInputType, type GraphQLSchema, type OperationDefinitionNode, type TypeNode } from "graphql";
import { Button } from "../../../shared/components/ui/button";
import { Input } from "../../../shared/components/ui/input";
import { SelectField } from "../../../shared/components/ui/select-field";
import { cn } from "../../../shared/lib/cn";
import { getGraphqlOperations, GraphqlCodeEditor, type GraphqlVariableHint } from "./graphql-code-editor";

type Definition = { name: string; type: TypeNode; defaultValue?: unknown };

function definitions(query: string, operationName: string): Definition[] {
  try {
    const operations = parse(query).definitions.filter((node): node is OperationDefinitionNode => node.kind === Kind.OPERATION_DEFINITION);
    const operation = operations.find((node) => node.name?.value === operationName) ?? (operations.length === 1 ? operations[0] : undefined);
    return (operation?.variableDefinitions ?? []).map((item) => ({ name: item.variable.name.value, type: item.type,
      defaultValue: item.defaultValue ? valueFromASTUntyped(item.defaultValue) : undefined }));
  } catch { return []; }
}

function inspectValues(text: string): { values: Record<string, unknown>; error: string } {
  try {
    const parsed: unknown = text.trim() ? JSON.parse(text) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { values: parsed as Record<string, unknown>, error: "" }
      : { values: {}, error: "Variables must be a JSON object." };
  } catch (cause) {
    return { values: {}, error: cause instanceof Error ? cause.message : "Variables must be valid JSON." };
  }
}

function formValue(value: unknown) { return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value); }

function inputHint(name: string, type: GraphQLInputType, defaultValue?: unknown, description?: string, ancestors = new Set<string>()): GraphqlVariableHint {
  const required = isNonNullType(type);
  const nullable = required ? type.ofType : type;
  if (isListType(nullable)) return {
    name, type: String(type), required, description, defaultValue, shape: "list",
    item: inputHint("item", nullable.ofType, undefined, undefined, ancestors),
  };
  const named = getNamedType(nullable);
  if (isInputObjectType(named)) {
    const recursive = ancestors.has(named.name);
    const nextAncestors = new Set(ancestors); nextAncestors.add(named.name);
    return {
      name, type: String(type), required, description, defaultValue, shape: "object",
      fields: recursive ? [] : Object.values(named.getFields()).map((field) => inputHint(field.name, field.type, field.defaultValue, field.description ?? undefined, nextAncestors)),
    };
  }
  return {
    name, type: String(type), required, description, defaultValue,
    enumValues: isEnumType(named) ? named.getValues().map((item) => item.name) : undefined,
    shape: isEnumType(named) ? "enum" : named.name === "Boolean" ? "boolean" : named.name === "Int" || named.name === "Float" ? "number" : "string",
  };
}

function setNestedValue(values: Record<string, unknown>, path: string[], value: unknown) {
  const root = { ...values };
  let target: Record<string, unknown> = root;
  path.forEach((name, index) => {
    if (index === path.length - 1) {
      if (value === undefined) delete target[name];
      else target[name] = value;
      return;
    }
    const current = target[name];
    const child = current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
    target[name] = child;
    target = child;
  });
  return root;
}

function parseFormValue(hint: GraphqlVariableHint, raw: string): unknown {
  if (!raw) return undefined;
  if (/^\s*{{[^{}]+}}\s*$/.test(raw)) return raw.trim();
  if (hint.shape === "number") return Number(raw);
  if (hint.shape === "boolean") return raw === "true";
  if (hint.shape === "object" || hint.shape === "list") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

function VariableFormField({ hint, path, value, onChange, nested = false }: {
  hint: GraphqlVariableHint; path: string[]; value: unknown;
  onChange: (path: string[], value: unknown) => void; nested?: boolean;
}) {
  const label = path.join(".");
  if (hint.shape === "object" && hint.fields?.length) {
    const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return <section aria-label={`GraphQL input ${label}`} className={cn("min-w-0 rounded-ui-md border border-border-subtle bg-purr-surface", !nested && "sm:col-span-2")}>
      <div className="flex min-h-control-sm items-center gap-ui-2 border-b border-border-subtle px-ui-2 py-ui-1 text-ui-xs">
        <span className="min-w-0 truncate font-code text-content-primary">{hint.name}{hint.required && <span className="text-accent-orange"> *</span>}</span>
        <span className="ml-auto min-w-0 truncate font-code text-content-tertiary">{hint.type}</span>
      </div>
      <div className="grid gap-ui-2 p-ui-2 sm:grid-cols-2">{hint.fields.map((field) => <VariableFormField key={field.name} hint={field} path={[...path, field.name]} value={object[field.name]} onChange={onChange} nested />)}</div>
    </section>;
  }
  const choiceValues = hint.enumValues ?? (hint.shape === "boolean" ? ["true", "false"] : []);
  if (choiceValues.length) {
    const options = [{ value: "", label: hint.defaultValue === undefined ? "Unset" : `Default: ${formValue(hint.defaultValue)}` },
      ...choiceValues.map((option) => ({ value: option, label: option }))];
    return <label className="grid min-w-0 grid-cols-2 items-center gap-ui-2 rounded-ui-md border border-border-subtle bg-purr-surface px-ui-2 py-ui-1-5 text-ui-xs" title={hint.description}>
      <span className="min-w-0 truncate font-code text-content-primary">{hint.name}{hint.required && <span className="text-accent-orange"> *</span>}</span>
      <span className="min-w-0 truncate text-right font-code text-content-tertiary">{hint.type}</span>
      <SelectField value={formValue(value)} options={options} onValueChange={(next) => onChange(path, parseFormValue(hint, next))} label={`GraphQL variable ${label}`} className="col-span-2 w-full font-code" />
    </label>;
  }
  return <label className="grid min-w-0 grid-cols-2 items-center gap-ui-2 rounded-ui-md border border-border-subtle bg-purr-surface px-ui-2 py-ui-1-5 text-ui-xs" title={hint.description}>
    <span className="min-w-0 truncate font-code text-content-primary">{hint.name}{hint.required && <span className="text-accent-orange"> *</span>}</span>
    <span className="min-w-0 truncate text-right font-code text-content-tertiary">{hint.type}</span>
    <Input type="text" aria-label={`GraphQL variable ${label}`} className="col-span-2 h-control-sm min-w-0 font-code text-ui-xs"
      placeholder={hint.shape === "object" ? "JSON object" : hint.shape === "list" ? "JSON list" : hint.defaultValue === undefined ? "Value or {{variable}}" : `Default: ${formValue(hint.defaultValue)}`}
      value={formValue(value)} onChange={(event) => onChange(path, parseFormValue(hint, event.target.value))} />
  </label>;
}

export function GraphqlVariablesDock({ query, operationName, value, schema, onChange, onOperationChange }: {
  query: string; operationName: string; value: string; schema?: GraphQLSchema; onChange: (value: string) => void;
  onOperationChange: (name: string) => void;
}) {
  const operations = useMemo(() => getGraphqlOperations(query), [query]);
  const variables = useMemo(() => definitions(query, operationName), [query, operationName]);
  const [expanded, setExpanded] = useState(true);
  const [mode, setMode] = useState<"form" | "json">("form");
  const [height, setHeight] = useState(30);
  const dock = useRef<HTMLElement>(null);
  const inspected = useMemo(() => inspectValues(value), [value]);
  const values = inspected.values;
  const variableHints = useMemo<GraphqlVariableHint[]>(() => variables.map((variable) => {
    const type = schema ? typeFromAST(schema, variable.type) : undefined;
    return type && isInputType(type) ? inputHint(variable.name, type, variable.defaultValue) : {
      name: variable.name, type: print(variable.type), required: variable.type.kind === Kind.NON_NULL_TYPE,
      defaultValue: variable.defaultValue, shape: "string",
    };
  }), [schema, variables]);
  if (!variables.length && operations.length <= 1) return null;
  const update = (path: string[], next: unknown) => onChange(JSON.stringify(setNestedValue(values, path, next), null, 2));
  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const parent = dock.current?.parentElement;
    if (!parent) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = parent.getBoundingClientRect();
    const move = (pointer: PointerEvent) => setHeight(Math.max(18, Math.min(58, ((bounds.bottom - pointer.clientY) / bounds.height) * 100)));
    const stop = () => {
      globalThis.removeEventListener("pointermove", move);
      globalThis.removeEventListener("pointerup", stop);
      globalThis.removeEventListener("pointercancel", stop);
    };
    globalThis.addEventListener("pointermove", move);
    globalThis.addEventListener("pointerup", stop);
    globalThis.addEventListener("pointercancel", stop);
  };
  return <section ref={dock} aria-label="GraphQL variables dock" className="flex min-h-control-md shrink-0 flex-col border-t border-border-subtle bg-purr-surface" style={expanded ? { flexBasis: `${height}%` } : undefined}>
    {expanded && <div role="separator" aria-label="Resize GraphQL variables" aria-orientation="horizontal" aria-valuemin={18} aria-valuemax={58} aria-valuenow={Math.round(height)} tabIndex={0}
      className="ui-focus-ring group flex h-ui-2 shrink-0 cursor-row-resize items-center justify-center hover:bg-purr-highlight"
      onPointerDown={resize} onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault(); setHeight((current) => Math.max(18, Math.min(58, current + (event.key === "ArrowUp" ? 4 : -4))));
      }}><GripHorizontal className="size-ui-3 text-content-quaternary group-hover:text-content-secondary" /></div>}
    <div className="flex h-control-md items-center gap-ui-2 px-ui-3">
      <button type="button" className="ui-focus-ring flex items-center gap-ui-2 rounded-ui-md text-ui-sm text-content-secondary hover:text-content-primary" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <ChevronDown className={cn("size-ui-3 transition-transform duration-ui-fast", !expanded && "-rotate-90")} />Variables <span className="font-code text-action-brand">{variables.length}</span>
      </button>
      {expanded && operations.length > 1 && <SelectField value={operationName || operations[0].name}
        options={operations.map((operation) => ({ value: operation.name, label: `${operation.kind} · ${operation.name}` }))}
        onValueChange={onOperationChange} label="GraphQL variables operation" className="max-w-ui-document-tab font-code" />}
      {expanded && <div className="ml-auto flex rounded-ui-md bg-purr-elevated p-ui-1">
        <Button size="xs" variant="ghost" aria-pressed={mode === "form"} className={cn(mode === "form" && "bg-purr-highlight text-content-primary")} onClick={() => setMode("form")}>Form</Button>
        <Button size="xs" variant="ghost" aria-pressed={mode === "json"} className={cn(mode === "json" && "bg-purr-highlight text-content-primary")} onClick={() => setMode("json")}>JSON</Button>
      </div>}
    </div>
    {expanded && <div className="min-h-0 flex-1 overflow-auto border-t border-border-subtle bg-purr-codefield">
      {inspected.error && <p role="alert" className="m-ui-0 border-b border-border-subtle px-ui-3 py-ui-2 font-code text-ui-xs text-accent-red">{inspected.error}</p>}
      {mode === "json" ? <GraphqlCodeEditor value={value} variables variableHints={variableHints} label="GraphQL variables" onChange={onChange} />
        : <div className="grid gap-ui-2 p-ui-3 sm:grid-cols-2">{variableHints.map((hint) => <VariableFormField key={hint.name} hint={hint} path={[hint.name]} value={values[hint.name]} onChange={update} />)}</div>}
    </div>}
  </section>;
}
