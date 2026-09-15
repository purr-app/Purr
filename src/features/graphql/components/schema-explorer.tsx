import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { getIntrospectionQuery, getNamedType, introspectionFromSchema, isCompositeType, isEnumType, isInputObjectType, isInterfaceType, isListType, isNonNullType, isObjectType, isScalarType, isUnionType, print, printType, type GraphQLField, type GraphQLInputField, type GraphQLNamedType, type GraphQLSchema } from "graphql";
import { ChevronDown, Copy, Download, LoaderCircle, Network, PanelRightClose, PanelRightOpen, Pin, Play, RefreshCw, Search, Upload } from "lucide-react";
import { Button } from "../../../shared/components/ui/button";
import { Input } from "../../../shared/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../../shared/components/ui/popover";
import { cn } from "../../../shared/lib/cn";
import type { RequestDocument, SchemaDocument } from "../../workspaces/model/workspace";
import { initialRequestDraft, type RequestDraft } from "../../request-workbench/model/request";
import type { AuthContext, RequestAuth } from "../../request-workbench/model/request-auth";
import type { SessionCookieJar } from "../../request-workbench/model/cookie-jar";
import { useAuthRuntime } from "../../request-workbench/hooks/use-auth-runtime";
import { executeRequest } from "../../request-workbench/services/execute-request";
import { isInlineHttpResponse } from "../../../domain/http";
import { applyWorkspaceRequestConfig, getWorkspaceAuth, getWorkspaceAuthProfiles, type WorkspaceRequestConfig } from "../../request-workbench/model/request-workspace-config";
import { normalizeSchema, parseGraphqlSchema } from "../model/graphql";
import { GraphqlCodeEditor } from "./graphql-code-editor";
import { useApplicationServices } from "../../../app/application-services-context";

type RootKind = "query" | "mutation" | "subscription";
type SearchResult = { path: string; type: GraphQLNamedType; field?: GraphQLField<unknown, unknown> | GraphQLInputField };
function typeKind(type: GraphQLNamedType) {
  return isObjectType(type) ? "Object" : isInputObjectType(type) ? "Input" : isInterfaceType(type) ? "Interface" : isEnumType(type) ? "Enum" : isUnionType(type) ? "Union" : "Scalar";
}
function operationName(field: string) { return field.charAt(0).toUpperCase() + field.slice(1); }
function updatedLabel(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
function operationForField(kind: RootKind, field: GraphQLField<unknown, unknown>) {
  const definitions = field.args.map((arg) => `$${arg.name}: ${arg.type}`).join(", ");
  const argumentsText = field.args.map((arg) => `${arg.name}: $${arg.name}`).join(", ");
  const named = getNamedType(field.type);
  let selection = "";
  if (isCompositeType(named)) {
    const candidates = (isObjectType(named) || isInterfaceType(named)) ? Object.values(named.getFields()).filter((item) => !item.args.some((arg) => isNonNullType(arg.type)) && (isScalarType(getNamedType(item.type)) || isEnumType(getNamedType(item.type)))).slice(0, 4).map((item) => item.name) : [];
    selection = ` {\n    ${["__typename", ...candidates].join("\n    ")}\n  }`;
  }
  const name = operationName(field.name);
  return { name, query: `${kind} ${name}${definitions ? `(${definitions})` : ""} {\n  ${field.name}${argumentsText ? `(${argumentsText})` : ""}${selection}\n}`, variables: "{}" };
}
function containsList(type: unknown): boolean {
  if (!type || typeof type !== "object" || !("ofType" in type)) return false;
  return isListType(type as never) || containsList((type as { ofType: unknown }).ofType);
}
function analysis(type: GraphQLNamedType) {
  const fields: Array<GraphQLField<unknown, unknown> | GraphQLInputField> = isObjectType(type) || isInterfaceType(type) || isInputObjectType(type) ? Object.values(type.getFields()) : [];
  const deprecatedPaths = fields.filter((field) => "deprecationReason" in field && field.deprecationReason != null).map((field) => field.name);
  if (isEnumType(type)) deprecatedPaths.push(...type.getValues().filter((value) => value.deprecationReason != null).map((value) => value.name));
  const listPaths = fields.filter((field) => containsList(field.type)).map((field) => field.name);
  const deepest = (current: GraphQLNamedType, seen = new Set<string>()): string[] => {
    if (seen.has(current.name) || seen.size >= 12) return [];
    const nextSeen = new Set(seen).add(current.name);
    const currentFields = isObjectType(current) || isInterfaceType(current) || isInputObjectType(current) ? Object.values(current.getFields()) : [];
    return currentFields.reduce<string[]>((longest, field) => {
      const child = getNamedType(field.type);
      const path = [field.name, ...(isCompositeType(child) ? deepest(child, nextSeen) : [])];
      return path.length > longest.length ? path : longest;
    }, []);
  };
  const depthPath = deepest(type);
  return { fields: fields.length, deprecated: deprecatedPaths.length, lists: listPaths.length, depth: depthPath.length, depthPath, listPaths, deprecatedPaths };
}

export function SchemaExplorer({ document, source, variables, workspaceConfig, cookieJar, setSourceDraft, onChange, onWorkspaceAuthChange, onCreateRequest }: {
  document: SchemaDocument; source?: RequestDocument; variables: Record<string, string>; cookieJar: SessionCookieJar;
  workspaceConfig: WorkspaceRequestConfig;
  setSourceDraft: Dispatch<SetStateAction<RequestDraft>>; onChange: (patch: Partial<SchemaDocument>) => void;
  onWorkspaceAuthChange: (profileId: string, auth: RequestAuth) => void;
  onCreateRequest: (operation: { name: string; query: string; variables: string }) => void;
}) {
  const { httpTransport, responseContent } = useApplicationServices();
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [format, setFormat] = useState<"sdl" | "json">("sdl");
  const workspaceAuthEntries = useMemo(() => getWorkspaceAuthProfiles(workspaceConfig, "graphql"), [workspaceConfig]);
  const workspaceProfiles = useMemo(() => workspaceAuthEntries.map((entry) => ({ id: entry.id, name: entry.name || "Workspace", auth: entry.value })), [workspaceAuthEntries]);
  const workspaceAuthEntry = useMemo(() => getWorkspaceAuth(workspaceConfig, "graphql",
    source?.request.auth.type === "inherit" ? source.request.auth.inherit.profileId : undefined), [source?.request.auth, workspaceConfig]);
  const workspaceAuth = useMemo(() => (source?.request.workspace.authEnabled ?? true) && workspaceAuthEntry
    ? { id: workspaceAuthEntry.id, name: workspaceAuthEntry.name || "Workspace", auth: workspaceAuthEntry.value } : undefined,
  [source?.request.workspace.authEnabled, workspaceAuthEntry]);
  const [context, setContext] = useState<AuthContext>({ variables, workspace: workspaceAuth, workspaceProfiles });
  useEffect(() => setContext((current) => ({ ...current, variables, workspace: workspaceAuth, workspaceProfiles })), [variables, workspaceAuth, workspaceProfiles]);
  const upload = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const endpoint = source?.request.url || document.endpoint || (document.source === "introspection" ? document.sourceLabel : "");
  const schemaDraft = useMemo<RequestDraft>(() => source?.request ?? {
    ...initialRequestDraft,
    method: "POST",
    url: endpoint,
    graphql: { query: "", variables: "", operationName: "" },
  }, [endpoint, source?.request]);
  const setSchemaDraft = useCallback<Dispatch<SetStateAction<RequestDraft>>>((change) => {
    const next = typeof change === "function" ? change(schemaDraft) : change;
    if (source) setSourceDraft(next);
    onChange({ endpoint: next.url, ...(document.schemaSource && "endpoint" in document.schemaSource ? { schemaSource: { ...document.schemaSource, endpoint: next.url } } : {}),
      ...(next.url !== endpoint && document.pinned === false ? { sdl: "", loadedAt: null } : {}) });
  }, [document.pinned, document.schemaSource, endpoint, onChange, schemaDraft, setSourceDraft, source]);
  const runtime = useAuthRuntime(schemaDraft, setSchemaDraft, context, setContext, onWorkspaceAuthChange);
  const parsed = useMemo(() => { try { return { schema: document.sdl ? parseGraphqlSchema(document.sdl) : undefined, error: "" }; } catch (cause) { return { schema: undefined, error: String(cause) }; } }, [document.sdl]);
  const schema = parsed.schema;
  const types = useMemo(() => schema ? Object.values(schema.getTypeMap()).filter((type) => !type.name.startsWith("__")) : [], [schema]);
  const selected = schema?.getType(document.ui.selectedType ?? "") ?? schema?.getQueryType() ?? types[0];
  const code = useMemo(() => !schema || !selected ? "" : format === "json" ? JSON.stringify(introspectionFromSchema(schema), null, 2)
    : selected.astNode ? [print(selected.astNode), ...(selected.extensionASTNodes ?? []).map((node) => print(node))].join("\n\n") : printType(selected), [schema, selected, format]);
  useEffect(() => setCopied(false), [code]);
  const selectType = (name: string) => onChange({ ui: { ...document.ui, selectedType: name, selectedField: null } });
  const selectField = (type: string, field: string) => onChange({ ui: { ...document.ui, selectedType: type, selectedField: field } });
  const install = (text: string, sourceKind: "file" | "introspection", sourceLabel: string) => {
    const sdl = normalizeSchema(text); if (!mounted.current) return;
    const loadedAt = new Date().toISOString(); onChange({ sdl, saved: true, source: sourceKind, sourceLabel, loadedAt, updatedAt: loadedAt,
      schemaSource: sourceKind === "introspection" ? { type: "introspection", endpoint, ...(source ? { requestId: source.id } : {}) }
        : { type: text.trim().startsWith("{") ? "introspection-json" : "sdl-file", location: sourceLabel, endpoint } }); setError("");
  };
  const introspect = async () => {
    if (!endpoint.trim() || pending.current) return; pending.current = true; setBusy(true); setError("");
    try {
      const request = applyWorkspaceRequestConfig({ ...schemaDraft, url: endpoint, graphql: { ...schemaDraft.graphql!, query: getIntrospectionQuery(), variables: "", operationName: "IntrospectionQuery" } }, "graphql", workspaceConfig);
      const result = await executeRequest(
        request,
        context,
        cookieJar,
        runtime,
        httpTransport,
        responseContent,
      );
      if (!isInlineHttpResponse(result)) {
        await responseContent.release(result.content).catch(() => {});
        throw new Error("GraphQL introspection responses at or above 1 MiB are not supported yet.");
      }
      if (result.status < 200 || result.status >= 300) throw new Error(`Introspection failed: HTTP ${result.status} ${result.statusText}`);
      install(result.text, "introspection", result.url);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const loadFile = async (file?: File) => {
    if (!file || pending.current) return; pending.current = true; setBusy(true); setError("");
    try { install(await file.text(), "file", file.name); } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const download = () => {
    if (!schema) return; const json = format === "json"; const content = json ? JSON.stringify(introspectionFromSchema(schema), null, 2) : document.sdl;
    const url = URL.createObjectURL(new Blob([content], { type: json ? "application/json" : "text/plain" })); const link = globalThis.document.createElement("a"); link.href = url; link.download = `schema.${json ? "json" : "graphql"}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const roots: Array<{ label: string; kind: RootKind; type?: ReturnType<GraphQLSchema["getQueryType"]> }> = [
    { label: "Queries", kind: "query", type: schema?.getQueryType() }, { label: "Mutations", kind: "mutation", type: schema?.getMutationType() }, { label: "Subscriptions", kind: "subscription", type: schema?.getSubscriptionType() },
  ];
  const rootTypes = roots.map((item) => item.type).filter(Boolean);
  const groups = [
    { label: "Objects & Types", types: types.filter((type) => isObjectType(type) && !rootTypes.includes(type)), root: false }, { label: "Inputs", types: types.filter(isInputObjectType), root: false },
    { label: "Enums", types: types.filter(isEnumType), root: false }, { label: "Interfaces", types: types.filter(isInterfaceType), root: false }, { label: "Unions", types: types.filter(isUnionType), root: false }, { label: "Scalars", types: types.filter(isScalarType), root: false },
  ];
  const searchResults: SearchResult[] = filter && schema ? types.flatMap((type): SearchResult[] => {
    const own: SearchResult[] = type.name.toLowerCase().includes(filter.toLowerCase()) ? [{ path: type.name, type }] : [];
    const fields: SearchResult[] = isObjectType(type) || isInterfaceType(type) || isInputObjectType(type) ? Object.values(type.getFields()).filter((field) => field.name.toLowerCase().includes(filter.toLowerCase())).map((field) => ({ path: `${type.name}.${field.name}`, type, field })) : [];
    return [...own, ...fields];
  }) : [];
  return <section aria-label="GraphQL schema explorer" className="flex h-full min-h-0 flex-col gap-ui-2 overflow-hidden p-ui-2">
    <div className="flex shrink-0 flex-wrap items-center gap-x-ui-3 gap-y-ui-1 rounded-ui-lg border border-border-subtle bg-purr-elevated px-ui-3 py-ui-2">
      <Network className="size-ui-4 shrink-0 text-action-graphql" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-ui-3"><span className="shrink-0 text-ui-md font-medium">GraphQL Schema</span><Input aria-label="GraphQL schema endpoint" variant="transparent" className="h-control-md min-w-0 flex-1 font-code text-ui-sm" placeholder="Enter endpoint or use {{base_url}}" value={endpoint}
          onChange={(event) => setSchemaDraft({ ...schemaDraft, url: event.target.value })} spellCheck="false" /></div>
        <div className="mt-ui-1 flex min-w-0 flex-wrap items-center gap-ui-3 text-ui-xs text-content-tertiary"><span>Source: <span className="text-content-secondary">{document.source === "introspection" ? "Introspection" : document.source === "file" ? document.sourceLabel : "Not loaded"}</span></span>
          {document.loadedAt && <span title={new Date(document.loadedAt).toLocaleString()}>Updated {updatedLabel(document.loadedAt)}</span>}
        </div>
      </div>
      <Button variant="secondary" size="sm" onClick={() => void introspect()} disabled={busy || !endpoint.trim()}>{busy ? <LoaderCircle className="size-ui-3-5 animate-spin" /> : <RefreshCw className="size-ui-3-5 text-action-graphql" />}Reload</Button>
      <Popover><PopoverTrigger asChild><Button variant="secondary" size="sm">Change source<ChevronDown className="size-ui-3" /></Button></PopoverTrigger>
        <PopoverContent align="end" className="w-ui-workspace-menu rounded-ui-lg border border-border bg-purr-overlay p-ui-1 shadow-popover">
          <Button variant="ghost" className="w-full justify-start" disabled={!endpoint.trim()} onClick={() => void introspect()}><RefreshCw className="size-ui-3-5" />Introspection</Button>
          <Button variant="ghost" className="w-full justify-start" onClick={() => upload.current?.click()}><Upload className="size-ui-3-5" />SDL or introspection file</Button>
        </PopoverContent></Popover>
      <input ref={upload} type="file" accept=".graphql,.gql,.graphqls,.sdl,.json,text/plain,application/json" aria-label="Schema file" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void loadFile(file); }} />
      <Button variant="ghost" size="icon" aria-label={document.ui.sourcePaneOpen ? "Hide SDL pane" : "Show SDL pane"} title={document.ui.sourcePaneOpen ? "Hide source pane" : "Show source pane"} aria-pressed={document.ui.sourcePaneOpen} onClick={() => onChange({ ui: { ...document.ui, sourcePaneOpen: !document.ui.sourcePaneOpen } })}>{document.ui.sourcePaneOpen ? <PanelRightClose className="size-ui-4" /> : <PanelRightOpen className="size-ui-4" />}</Button>
      <Button variant="ghost" size="icon" aria-label="Download schema" onClick={download} disabled={!schema}><Download className="size-ui-4" /></Button>
      <Button variant="ghost" size="icon" aria-label="Pin schema SDL to project" title="Pinned schemas are saved as SDL in the workspace and stay available after restarting Purr" aria-pressed={document.pinned !== false} className={document.pinned !== false ? "text-action-brand" : undefined} onClick={() => onChange({ pinned: document.pinned === false })} disabled={!schema}><Pin className="size-ui-4" /></Button>
    </div>
    {(error || parsed.error) && <p role="alert" className="shrink-0 whitespace-pre-wrap rounded-ui-md bg-purr-elevated px-ui-3 py-ui-2 text-ui-sm text-accent-red">{error || parsed.error}</p>}
    {!schema ? <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-ui-3 rounded-ui-xl border border-border-subtle bg-purr-surface p-ui-6 text-center"><Network className="size-ui-10 text-action-graphql" /><p className="text-ui-md text-content-secondary">No schema loaded</p><p className="text-ui-sm text-content-tertiary">Reload through introspection or choose an SDL / introspection JSON source.</p></div>
      : <div className={cn("grid min-h-0 flex-1 gap-ui-2 overflow-x-auto", document.ui.sourcePaneOpen ? "grid-cols-ui-schema" : "grid-cols-ui-schema-compact")}>
      <aside aria-label="Schema type registry" className="flex min-h-0 flex-col overflow-hidden rounded-ui-lg border border-border-subtle bg-purr-surface">
        <div className="flex items-center justify-between px-ui-3 py-ui-2 text-ui-md text-content-tertiary"><span>Type registry</span><span className="font-code text-ui-sm">{types.length}</span></div>
        <div className="relative mx-ui-2 mb-ui-1"><Search className="pointer-events-none absolute left-ui-2 top-1/2 size-ui-3-5 -translate-y-1/2 text-content-tertiary" /><Input className="h-control-md pl-ui-7 text-ui-md" aria-label="Search schema types" placeholder="Search types or fields…" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
        <div className="min-h-0 flex-1 overflow-y-auto p-ui-1">
          {filter ? searchResults.map((result) => <div key={result.path} className="flex items-center rounded-ui-md hover:bg-purr-elevated">
            <button type="button" className="ui-focus-ring min-w-0 flex-1 truncate px-ui-2 py-ui-1 text-left font-code text-ui-md text-content-secondary" onClick={() => result.field ? selectField(result.type.name, result.field.name) : selectType(result.type.name)}>{result.path}</button>
            {result.field && <button type="button" aria-label={`Open return type ${getNamedType(result.field.type).name}`} className="ui-focus-ring max-w-ui-document-tab truncate px-ui-2 font-code text-ui-xs text-syntax-string hover:underline" onClick={() => selectType(getNamedType(result.field!.type).name)}>{String(result.field.type)}</button>}
          </div>) : <>
            {roots.filter((root) => root.type).map((root) => <details key={root.kind} open><summary className="ui-focus-ring flex cursor-pointer list-none items-center gap-ui-2 rounded-ui-md px-ui-2 py-ui-1 text-ui-md text-content-secondary"><ChevronDown className="size-ui-3" />{root.label}<span className="ml-auto font-code text-ui-sm text-action-graphql">{Object.keys(root.type!.getFields()).length}</span></summary>
              {Object.values(root.type!.getFields()).map((field) => <div key={field.name} className="group flex items-center pl-ui-3 hover:bg-purr-elevated"><button className="ui-focus-ring min-w-0 flex-1 truncate px-ui-2 py-ui-1 text-left font-code text-ui-md text-content-secondary" onClick={() => selectField(root.type!.name, field.name)}>{field.name}</button><button type="button" aria-label={`Open return type ${getNamedType(field.type).name}`} className="ui-focus-ring max-w-ui-document-tab truncate font-code text-ui-xs text-syntax-string hover:underline" onClick={() => selectType(getNamedType(field.type).name)}>{String(field.type)}</button>{root.kind !== "subscription" && <Button size="icon" variant="ghost" className="size-control-xs opacity-ui-hidden group-hover:opacity-ui-visible focus-visible:opacity-ui-visible" aria-label={`Create request for ${field.name}`} onClick={() => onCreateRequest(operationForField(root.kind, field))}><Play className="size-ui-3 text-action-graphql" /></Button>}</div>)}
            </details>)}
            {groups.map((group) => group.types.length ? <details key={group.label} open><summary className="ui-focus-ring flex cursor-pointer list-none items-center gap-ui-2 rounded-ui-md px-ui-2 py-ui-1 text-ui-md text-content-secondary"><ChevronDown className="size-ui-3" />{group.label}<span className="ml-auto font-code text-ui-sm text-action-graphql">{group.types.length}</span></summary>
              {group.types.map((type) => <button key={type.name} type="button" className={cn("ui-focus-ring flex w-full items-center rounded-ui-md px-ui-4 py-ui-1 text-left font-code text-ui-md hover:bg-purr-elevated", selected?.name === type.name ? "bg-purr-highlight text-action-graphql" : "text-content-secondary")} aria-pressed={selected?.name === type.name} onClick={() => selectType(type.name)}>{type.name}</button>)}
            </details> : null)}
          </>}
          {filter && !searchResults.length && <p className="p-ui-3 text-ui-sm text-content-tertiary">No matching types or fields.</p>}
        </div>
      </aside>
      <div className="min-h-0 overflow-y-auto rounded-ui-lg border border-border-subtle bg-purr-surface p-ui-2">{selected && <TypeDetails type={selected} schema={schema} selectedField={document.ui.selectedField} onSelect={selectType} onSelectField={(field) => selectField(selected.name, field)} onCreateRequest={onCreateRequest} />}</div>
      {document.ui.sourcePaneOpen && <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-ui-lg border border-border-subtle bg-purr-codefield">
        <div className="flex shrink-0 items-center gap-ui-1 border-b border-border-subtle bg-purr-elevated p-ui-1"><span className="mr-auto truncate px-ui-2 font-code text-ui-sm text-content-secondary">{format === "sdl" ? `${selected?.name}.graphql` : "schema.json"}</span>
          <Button variant="ghost" size="xs" aria-pressed={format === "sdl"} className={cn(format === "sdl" && "bg-action-graphql-surface text-action-graphql")} onClick={() => setFormat("sdl")}>SDL</Button><Button variant="ghost" size="xs" aria-pressed={format === "json"} className={cn(format === "json" && "bg-action-graphql-surface text-action-graphql")} onClick={() => setFormat("json")}>JSON</Button>
          <Button variant="ghost" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(code); setCopied(true); } catch { setError("Could not copy. Select the schema text and copy it manually."); } }}><Copy className="size-ui-3" />{copied ? "Copied" : "Copy"}</Button>
        </div><div className="min-h-0 flex-1"><GraphqlCodeEditor value={code} variables={format === "json"} readOnly label="Schema source" /></div>
      </div>}
    </div>}
    <footer className="flex shrink-0 flex-wrap items-center gap-ui-3 px-ui-2 font-code text-ui-xs text-content-tertiary"><span className="text-action-graphql">{schema ? `${types.length} types indexed` : "Schema explorer"}</span>{document.source && <span className="min-w-0 flex-1 truncate">{document.source === "file" ? "File" : "Introspection"}: {document.sourceLabel}</span>}</footer>
  </section>;
}

function TypeDetails({ type, schema, selectedField, onSelect, onSelectField, onCreateRequest }: { type: GraphQLNamedType; schema: GraphQLSchema; selectedField: string | null; onSelect: (name: string) => void; onSelectField: (name: string) => void; onCreateRequest: (operation: { name: string; query: string; variables: string }) => void }) {
  const fields: Array<GraphQLField<unknown, unknown> | GraphQLInputField> = isObjectType(type) || isInterfaceType(type) || isInputObjectType(type) ? Object.values(type.getFields()) : [];
  const metrics = analysis(type);
  const rootKind: RootKind | undefined = type === schema.getQueryType() ? "query" : type === schema.getMutationType() ? "mutation" : type === schema.getSubscriptionType() ? "subscription" : undefined;
  const reference = (name: string, label = name) => <button type="button" className="ui-focus-ring rounded-ui-sm font-code text-ui-md text-syntax-string hover:underline" onClick={() => onSelect(name)}>{label}</button>;
  const operation = rootKind && selectedField && isObjectType(type) ? type.getFields()[selectedField] : undefined;
  if (rootKind && operation) return <OperationDetails kind={rootKind} field={operation} onSelect={onSelect} onBack={() => onSelect(type.name)} onCreateRequest={onCreateRequest} />;
  return <section aria-label={`Type ${type.name}`}>
    <div className="flex flex-wrap items-center gap-ui-2 border-b border-border-subtle px-ui-2 pb-ui-2"><span className="rounded-ui-sm bg-action-graphql-surface px-ui-2 py-ui-1 text-ui-xs uppercase text-action-graphql">{typeKind(type)}</span><h2 className="m-ui-0 font-code text-ui-lg font-medium">{type.name}</h2>
      {(isObjectType(type) || isInterfaceType(type)) && type.getInterfaces().length > 0 && <span className="text-ui-sm text-content-tertiary">implements {type.getInterfaces().map((item) => <span key={item.name}>{reference(item.name)}</span>)}</span>}
    </div>
    {type.description && <p className="m-ui-0 border-b border-border-subtle px-ui-2 py-ui-2 text-ui-sm leading-relaxed text-content-secondary">{type.description}</p>}
    <dl className="grid grid-cols-4 gap-ui-1 border-b border-border-subtle p-ui-2 text-ui-xs"><Metric label="Depth" value={metrics.depth} detail={metrics.depthPath.join(" → ")} /><Metric label="Fields" value={metrics.fields} /><Metric label="Lists" value={metrics.lists} detail={metrics.listPaths.join(" · ")} /><Metric label="Deprecated" value={metrics.deprecated} detail={metrics.deprecatedPaths.join(" · ")} warning={metrics.deprecated > 0} /></dl>
    {fields.length > 0 && <div className="divide-y divide-border-subtle">{fields.map((field) => <div key={field.name} className="group grid min-w-0 grid-cols-ui-schema-field items-start gap-ui-2 px-ui-2 py-ui-2 hover:bg-purr-elevated">
      <div className="min-w-0">{rootKind && "args" in field ? <button type="button" className={cn("ui-focus-ring rounded-ui-sm font-code text-ui-md text-syntax-property hover:underline", field.deprecationReason && "line-through")} onClick={() => onSelectField(field.name)}>{field.name}</button> : <span className={cn("font-code text-ui-md text-syntax-property", "deprecationReason" in field && field.deprecationReason && "line-through")}>{field.name}</span>}{field.description && <p className="m-ui-0 mt-ui-1 line-clamp-2 text-ui-sm text-content-tertiary">{field.description}</p>}</div>
      <div className="min-w-0">{reference(getNamedType(field.type).name, String(field.type))}</div>
      <div className="min-w-0 truncate font-code text-ui-sm text-content-tertiary">{"args" in field && field.args.length ? field.args.map((arg) => `${arg.name}: ${arg.type}`).join(" · ") : "—"}</div>
      {rootKind && rootKind !== "subscription" && "args" in field ? <Button size="xs" variant="ghost" aria-label={`Create request for ${field.name}`} onClick={() => onCreateRequest(operationForField(rootKind, field))}><Play className="size-ui-3 text-action-graphql" />Request</Button> : <span />}
      {"deprecationReason" in field && field.deprecationReason != null && <p className="col-span-4 m-ui-0 text-ui-xs text-accent-orange">Deprecated: {field.deprecationReason || "No longer supported"}</p>}
    </div>)}</div>}
    {isEnumType(type) && <div className="divide-y divide-border-subtle">{type.getValues().map((value) => <div key={value.name} className="px-ui-2 py-ui-2"><span className="font-code text-ui-sm text-syntax-number">{value.name}</span>{value.description && <span className="ml-ui-3 text-ui-sm text-content-secondary">{value.description}</span>}{value.deprecationReason != null && <p className="m-ui-0 text-ui-xs text-accent-orange">Deprecated: {value.deprecationReason}</p>}</div>)}</div>}
    {(isUnionType(type) || isInterfaceType(type)) && <div className="flex flex-wrap gap-ui-2 p-ui-2 text-ui-sm"><span className="text-content-tertiary">Possible types</span>{schema.getPossibleTypes(type).map((item) => <span key={item.name}>{reference(item.name)}</span>)}</div>}
    {isScalarType(type) && type.specifiedByURL && <p className="break-all p-ui-2 font-code text-ui-sm text-content-tertiary">{type.specifiedByURL}</p>}
  </section>;
}

function OperationDetails({ kind, field, onSelect, onBack, onCreateRequest }: { kind: RootKind; field: GraphQLField<unknown, unknown>; onSelect: (name: string) => void; onBack: () => void; onCreateRequest: (operation: { name: string; query: string; variables: string }) => void }) {
  const prepared = operationForField(kind, field);
  return <section aria-label={`Operation ${field.name}`}>
    <div className="flex flex-wrap items-center gap-ui-2 border-b border-border-subtle px-ui-2 pb-ui-2">
      <button type="button" className="ui-focus-ring rounded-ui-sm text-ui-sm text-content-tertiary hover:text-content-primary" onClick={onBack}>{kind === "query" ? "Query" : kind === "mutation" ? "Mutation" : "Subscription"}</button>
      <span className="text-content-quaternary">/</span><h2 className="m-ui-0 font-code text-ui-lg font-medium text-syntax-property">{field.name}</h2>
      {kind !== "subscription" && <Button variant="graphql" size="sm" className="ml-auto" onClick={() => onCreateRequest(prepared)}><Play className="size-ui-3-5" />Create request</Button>}
    </div>
    {field.description ? <p className="m-ui-0 border-b border-border-subtle px-ui-2 py-ui-3 text-ui-md leading-relaxed text-content-secondary">{field.description}</p> : <p className="m-ui-0 border-b border-border-subtle px-ui-2 py-ui-3 text-ui-sm text-content-tertiary">No description provided.</p>}
    <dl className="grid gap-ui-2 border-b border-border-subtle p-ui-2 text-ui-sm sm:grid-cols-2">
      <div className="rounded-ui-md bg-purr-codefield px-ui-3 py-ui-2"><dt className="text-content-tertiary">Returns</dt><dd className="m-ui-0 mt-ui-1"><button type="button" className="ui-focus-ring rounded-ui-sm font-code text-ui-md text-syntax-string hover:underline" onClick={() => onSelect(getNamedType(field.type).name)}>{String(field.type)}</button></dd></div>
      <div className="rounded-ui-md bg-purr-codefield px-ui-3 py-ui-2"><dt className="text-content-tertiary">Operation</dt><dd className="m-ui-0 mt-ui-1 font-code text-ui-md text-action-graphql">{kind} {prepared.name}</dd></div>
    </dl>
    <div className="p-ui-2"><h3 className="m-ui-0 mb-ui-2 text-ui-sm font-medium text-content-secondary">Arguments {field.args.length}</h3>{field.args.length ? <div className="divide-y divide-border-subtle rounded-ui-md bg-purr-codefield">{field.args.map((argument) => <div key={argument.name} className="grid grid-cols-2 gap-ui-3 px-ui-3 py-ui-2 font-code text-ui-sm"><span className="text-syntax-attribute">{argument.name}</span><button type="button" className="ui-focus-ring justify-self-start rounded-ui-sm text-syntax-string hover:underline" onClick={() => onSelect(getNamedType(argument.type).name)}>{String(argument.type)}</button>{argument.description && <span className="col-span-2 font-ui text-content-tertiary">{argument.description}</span>}</div>)}</div> : <p className="m-ui-0 text-ui-sm text-content-tertiary">This operation has no arguments.</p>}</div>
  </section>;
}

function Metric({ label, value, detail, warning = false }: { label: string; value: number; detail?: string; warning?: boolean }) {
  return <div className="min-w-0 rounded-ui-md bg-purr-codefield px-ui-2 py-ui-1"><dt className="text-content-tertiary">{label}</dt><dd className={cn("m-ui-0 font-code text-ui-sm", warning ? "text-accent-orange" : "text-content-primary")}>{value}</dd>{detail && <dd className="m-ui-0 mt-ui-1 break-words font-code text-ui-2xs leading-relaxed text-content-tertiary" title={detail}>{detail}</dd>}</div>;
}
