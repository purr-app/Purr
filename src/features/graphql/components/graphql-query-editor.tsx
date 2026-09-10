import { useEffect, useMemo, useState } from "react";
import { getDiagnostics } from "graphql-language-service";
import { parse, print, type GraphQLSchema } from "graphql";
import { CircleAlert, WandSparkles } from "lucide-react";
import { Button } from "../../../shared/components/ui/button";
import type { RequestDraft } from "../../request-workbench/model/request";
import { getGraphqlOperations, GraphqlCodeEditor, type GraphqlOperation, type OperationFocus } from "./graphql-code-editor";
import { GraphqlVariablesDock } from "./graphql-variables-dock";

const diagnosticsDelayMs = 1000;

function queryDiagnostics(query: string, schema?: GraphQLSchema) {
  if (!query.trim()) return [];
  if (schema) return getDiagnostics(query, schema).map((item) => ({ message: typeof item.message === "string" ? item.message : item.message.value, severity: item.severity === 1 ? "error" : "warning",
    line: item.range.start.line + 1, column: item.range.start.character + 1 }));
  try { parse(query); return []; }
  catch (cause) {
    const error = cause as Error & { locations?: Array<{ line: number; column: number }> };
    return [{ message: error.message.replace(/^Syntax Error: /, ""), severity: "error", line: error.locations?.[0]?.line ?? 1, column: error.locations?.[0]?.column ?? 1 }];
  }
}

export function GraphqlQueryEditor({ value, onChange, schema, onOpenType, onRunOperation }: {
  value: NonNullable<RequestDraft["graphql"]>; onChange: (value: NonNullable<RequestDraft["graphql"]>) => void;
  schema?: GraphQLSchema; onOpenType?: (name: string) => void; onRunOperation?: (name: string) => void;
}) {
  const [formatError, setFormatError] = useState("");
  const [validation, setValidation] = useState(() => ({ query: value.query, schema }));
  const [focusOperation, setFocusOperation] = useState<OperationFocus>();
  const operations = useMemo(() => getGraphqlOperations(value.query), [value.query]);
  const selectedOperation = operations.some((operation) => operation.name === value.operationName)
    ? value.operationName
    : operations[0]?.name ?? "";
  const validationCurrent = validation.query === value.query && validation.schema === schema;
  const diagnostics = useMemo(() => validationCurrent ? queryDiagnostics(validation.query, validation.schema) : [], [validation, validationCurrent]);
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setValidation({ query: value.query, schema }), diagnosticsDelayMs);
    return () => globalThis.clearTimeout(timer);
  }, [value.query, schema]);
  useEffect(() => {
    if (value.operationName && !operations.some((operation) => operation.name === value.operationName))
      onChange({ ...value, operationName: operations.length === 1 ? operations[0].name : "" });
  }, [onChange, operations, value]);
  const selectOperation = (name: string, focus = false) => {
    if (value.operationName !== name) onChange({ ...value, operationName: name });
    if (focus) setFocusOperation({ name, nonce: Date.now() });
  };
  const runOperation = (operation: GraphqlOperation) => {
    selectOperation(operation.name);
    onRunOperation?.(operation.name);
  };
  const format = () => {
    try { onChange({ ...value, query: print(parse(value.query)) }); setFormatError(""); }
    catch (cause) { setFormatError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <section id="request-section-gql-query" role="tabpanel" aria-labelledby="request-tab-gql-query" className="flex h-full min-h-0 flex-col bg-purr-codefield">
    {formatError && <p role="alert" className="m-ui-0 shrink-0 border-b border-border-subtle bg-purr-surface px-ui-3 py-ui-2 font-code text-ui-xs text-accent-red">{formatError}</p>}
    {diagnostics.length > 0 && <div aria-label="GraphQL diagnostics" className="max-h-ui-diagnostics shrink-0 overflow-auto border-b border-border-subtle bg-purr-surface px-ui-3 py-ui-1">
      {diagnostics.map((diagnostic, index) => <p key={`${diagnostic.message}-${index}`} className={`m-ui-0 flex items-center gap-ui-2 py-ui-1 font-code text-ui-xs ${diagnostic.severity === "error" ? "text-accent-red" : "text-accent-orange"}`}>
        <CircleAlert className="size-ui-3 shrink-0" /><span>{diagnostic.message}</span><span className="ml-auto shrink-0 text-content-tertiary">{diagnostic.line}:{diagnostic.column}</span>
      </p>)}
    </div>}
    <div className="ui-graphql-editor-pane group relative min-h-0 flex-1">
      <Button variant="ghost" size="sm" className="absolute right-ui-3 top-ui-2 z-10 opacity-ui-hidden shadow-button group-hover:opacity-ui-visible group-focus-within:opacity-ui-visible" onClick={format}><WandSparkles className="size-ui-3-5" />Format</Button>
      <GraphqlCodeEditor value={value.query} schema={schema} label="GraphQL query" onOpenType={onOpenType} onRunOperation={runOperation}
        onCursorOperationChange={(operation) => selectOperation(operation.name)} focusOperation={focusOperation}
        onChange={(query) => { setFormatError(""); onChange({ ...value, query }); }} />
    </div>
    <GraphqlVariablesDock query={value.query} operationName={selectedOperation} value={value.variables} schema={schema}
      onOperationChange={(name) => selectOperation(name, true)}
      onChange={(variables) => onChange({ ...value, variables })} />
    <footer className="flex shrink-0 justify-between gap-ui-3 border-t border-border-subtle bg-purr-surface px-ui-3 py-ui-1 font-code text-ui-2xs text-content-tertiary">
      <span>GraphQL · UTF-8</span><span>{schema ? "Schema connected · " : "No schema · "}Lines: {value.query.split("\n").length}</span>
    </footer>
  </section>;
}
