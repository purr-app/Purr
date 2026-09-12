import { useEffect, useId, useRef, useState } from "react";
import { Braces, Check, ChevronDown, Cloud, Copy, Eye, EyeOff, FileText, Globe2, LockKeyhole, Plus, RefreshCw, Save, Trash2, X, Zap } from "lucide-react";

import { Button } from "../../../shared/components/ui/button";
import { Checkbox } from "../../../shared/components/ui/checkbox";
import { FormField } from "../../../shared/components/ui/form-field";
import { Input } from "../../../shared/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../../shared/components/ui/popover";
import { SelectField } from "../../../shared/components/ui/select-field";
import { Switch } from "../../../shared/components/ui/switch";
import { cn } from "../../../shared/lib/cn";
import { getHttpMethodStyle } from "../../../shared/model/http-method";
import { secretRef } from "../../../storage/secrets";
import type { DynamicVariableRequest } from "../services/dynamic-variable-resolver";
import { dynamicVariableCacheKey, inspectDynamicVariableGraph } from "../services/dynamic-variable-resolver";
import { getEffectiveVariables, type Environment, type Variable, type Workspace } from "../model/workspace";

export type VariableScope = "effective" | "workspace" | "global" | `environment:${string}`;
type VariableKind = Variable["kind"];

const kindLabels: Record<VariableKind, string> = {
  static: "Static",
  "dynamic-request": "Dynamic Request",
  "external-secret": "External Secret",
};

function createStaticVariable(name = "", value = ""): Extract<Variable, { kind: "static" }> {
  return { id: crypto.randomUUID(), name, enabled: true, sensitive: false, kind: "static", value };
}

export function createDynamicVariable(name = "", documentId = "", expression = "$"): Variable {
  return { id: crypto.randomUUID(), name, enabled: true, sensitive: false, kind: "dynamic-request", documentId, expression,
    language: "jsonpath", refresh: "every-time", environment: { type: "current" } };
}

function scopeLabel(scope: VariableScope, workspace: Workspace) {
  if (scope === "effective") return "Effective";
  if (scope === "workspace") return "Workspace";
  if (scope === "global") return "Global";
  return workspace.environments.find((environment) => scope === `environment:${environment.id}`)?.name ?? "Environment";
}

function definitionScope(variable: Variable, workspace: Workspace, globalVariables: readonly Variable[]): VariableScope {
  if (globalVariables.some((item) => item.id === variable.id)) return "global";
  if (workspace.variables.some((item) => item.id === variable.id)) return "workspace";
  const environment = workspace.environments.find((item) => item.variables.some((candidate) => candidate.id === variable.id));
  return environment ? `environment:${environment.id}` : "workspace";
}

function variableSummary(variable: Variable, workspace: Workspace) {
  if (variable.kind === "static") return variable.sensitive ? "********" : variable.value || "Empty value";
  if (variable.kind === "external-secret") return `${variable.provider}: ${variable.key}`;
  const request = workspace.documents.find((document) => document.id === variable.documentId);
  return `${request?.name ?? "Missing request"} → ${variable.expression}`;
}

function usedBy(variable: Variable, documents: readonly DynamicVariableRequest[]) {
  return documents.filter((document) => JSON.stringify(document.request).includes(`{{${variable.name}}}`));
}

export function VariablesExplorer({ workspace, globalVariables, scope, selectedId, draft, documents,
  onWorkspaceVariablesChange, onGlobalVariablesChange, onEnvironmentChange, onDeleteEnvironment, onOpenRequest, onResolveVariable, onScopeChange, onSelectionChange, onDraftChange }: {
  workspace: Workspace;
  globalVariables: Variable[];
  scope: VariableScope;
  selectedId: string | null;
  draft: Variable | null;
  documents: readonly DynamicVariableRequest[];
  onWorkspaceVariablesChange: (variables: Variable[]) => void;
  onGlobalVariablesChange: (variables: Variable[]) => void;
  onEnvironmentChange: (environment: Environment) => void;
  onDeleteEnvironment: (id: string) => void;
  onOpenRequest: (id: string) => void;
  onResolveVariable: (variable: Variable) => Promise<void>;
  onScopeChange: (scope: VariableScope) => void;
  onSelectionChange: (id: string | null) => void;
  onDraftChange: (draft: Variable | null) => void;
}) {
  const [search, setSearch] = useState("");
  const [type, setType] = useState<"all" | VariableKind>("all");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmEnvironmentDelete, setConfirmEnvironmentDelete] = useState(false);
  const selectedEnvironment = scope.startsWith("environment:")
    ? workspace.environments.find((environment) => scope === `environment:${environment.id}`) : undefined;

  useEffect(() => setConfirmEnvironmentDelete(false), [scope]);

  const variables = scope === "effective" ? getEffectiveVariables(workspace, globalVariables)
    : scope === "workspace" ? workspace.variables : scope === "global" ? globalVariables : selectedEnvironment?.variables ?? [];
  const selected = variables.find((variable) => variable.id === selectedId) ?? null;
  const activeDraft = draft ?? (selected ? structuredClone(selected) : null);
  const cacheFor = (variable: Variable) => variable.kind === "dynamic-request"
    ? workspace.dynamicVariableCache[dynamicVariableCacheKey(variable.id, variable.environment.type === "specific" ? variable.environment.environmentId : workspace.activeEnvironmentId)] : undefined;
  const filtered = variables.filter((variable) => (!search.trim() || `${variable.name} ${variableSummary(variable, workspace)}`.toLowerCase().includes(search.toLowerCase()))
    && (type === "all" || variable.kind === type));

  const replaceInScope = (next: Variable[]) => {
    if (scope === "workspace") onWorkspaceVariablesChange(next);
    else if (scope === "global") onGlobalVariablesChange(next);
    else if (selectedEnvironment) onEnvironmentChange({ ...selectedEnvironment, variables: next });
  };
  const selectScope = (next: VariableScope, id: string | null = null) => {
    onScopeChange(next); onSelectionChange(id); onDraftChange(null); setConfirmDeleteId(null);
  };
  const openVariable = (variable: Variable) => {
    if (dirty && activeDraft?.id !== variable.id) return;
    onSelectionChange(variable.id); onDraftChange(structuredClone(variable));
  };
  const add = () => { onSelectionChange(null); onDraftChange(createStaticVariable()); };
  const persisted = activeDraft ? variables.find((variable) => variable.id === activeDraft.id) : undefined;
  const dirty = Boolean(activeDraft && (!persisted || JSON.stringify(activeDraft) !== JSON.stringify(persisted)));
  const nameError = activeDraft ? validateVariableName(activeDraft, scope, workspace, globalVariables) : "";
  const canSave = Boolean(activeDraft?.name.trim() && !nameError
    && (activeDraft.kind !== "dynamic-request" || activeDraft.documentId && activeDraft.expression.trim()));
  const saveDraft = () => {
    if (!activeDraft || !canSave || scope === "effective") return;
    let next = structuredClone(activeDraft);
    if (next.kind === "static") {
      next = next.sensitive ? { ...next, secretRef: next.secretRef ?? variableSecretRef(scope, workspace, next.id), loaded: true }
        : { id: next.id, name: next.name.trim(), enabled: next.enabled, sensitive: false, kind: "static", value: next.value };
    } else next = { ...next, name: next.name.trim() };
    replaceInScope(persisted ? variables.map((variable) => variable.id === next.id ? next : variable) : [...variables, next]);
    onSelectionChange(next.id); onDraftChange(structuredClone(next));
  };
  const cancelDraft = () => { onDraftChange(null); onSelectionChange(null); setConfirmDeleteId(null); };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && dirty) { event.preventDefault(); saveDraft(); }
      if (event.key === "Escape" && activeDraft) { event.preventDefault(); cancelDraft(); }
    };
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  });
  const toggle = (variable: Variable, enabled: boolean) => {
    replaceInScope(variables.map((candidate) => candidate.id === variable.id ? { ...candidate, enabled } : candidate));
    if (activeDraft?.id === variable.id) onDraftChange({ ...activeDraft, enabled });
  };
  const remove = (variable: Variable) => {
    replaceInScope(variables.filter((candidate) => candidate.id !== variable.id));
    if (selectedId === variable.id || draft?.id === variable.id) { onSelectionChange(null); onDraftChange(null); }
    setConfirmDeleteId(null);
  };
  const persistStatic = (candidate: Extract<Variable, { kind: "static" }>, existing = false) => {
    const next: Extract<Variable, { kind: "static" }> = candidate.sensitive
      ? { ...candidate, name: candidate.name.trim(), secretRef: candidate.secretRef ?? variableSecretRef(scope, workspace, candidate.id), loaded: true }
      : { id: candidate.id, name: candidate.name.trim(), enabled: candidate.enabled, sensitive: false, kind: "static", value: candidate.value };
    replaceInScope(existing ? variables.map((variable) => variable.id === next.id ? next : variable) : [...variables, next]);
  };
  const showDetails = scope === "effective" ? Boolean(selected) : Boolean(activeDraft);

  return <section aria-label="Variables" className="h-full min-h-0 bg-purr-base p-ui-2">
    <div className={cn("grid h-full min-h-0 overflow-hidden rounded-ui-xl border border-border-subtle bg-purr-surface shadow-panel", showDetails ? "grid-cols-ui-variables" : "grid-cols-ui-variables-compact")}>
      <aside className="min-h-0 overflow-auto border-r border-border-subtle p-ui-3">
        <h1 className="mb-ui-3 mt-ui-0 flex items-center gap-ui-2 text-ui-lg font-medium"><Braces className="size-ui-4 text-action-brand" />Variables</h1>
        <nav aria-label="Variable scopes" className="space-y-ui-1">
          {(["effective", "workspace"] as const).map((value) => <Button key={value} variant="ghost" className={cn("w-full justify-start", scope === value && "bg-purr-highlight text-content-primary")} onClick={() => selectScope(value)}>{value === "effective" ? <RefreshCw className="size-ui-4" /> : <Braces className="size-ui-4" />}{scopeLabel(value, workspace)}</Button>)}
          <div className="pt-ui-2 text-ui-xs font-medium text-content-tertiary">Environments</div>
          {workspace.environments.map((environment) => <Button key={environment.id} variant="ghost" className={cn("w-full justify-start", scope === `environment:${environment.id}` && "bg-purr-highlight text-content-primary")} onClick={() => selectScope(`environment:${environment.id}`)}><Globe2 className="size-ui-4" /><span className="truncate">{environment.name}</span></Button>)}
          <div className="border-t border-border-subtle pt-ui-2"><Button variant="ghost" className={cn("w-full justify-start", scope === "global" && "bg-purr-highlight text-content-primary")} onClick={() => selectScope("global")}><Globe2 className="size-ui-4" />Global</Button></div>
        </nav>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-col">
        <header className="flex shrink-0 items-center gap-ui-2 border-b border-border-subtle p-ui-3" onClick={() => { if (showDetails) cancelDraft(); }}>
          <div className="min-w-0 flex-1">{selectedEnvironment
            ? <EnvironmentName environment={selectedEnvironment} siblings={workspace.environments} onChange={onEnvironmentChange} />
            : <h2 className="m-ui-0 text-ui-lg font-medium">{scopeLabel(scope, workspace)}</h2>}</div>
          {scope !== "effective" ? <Button variant="brand" size="lg" className="px-ui-3 text-ui-sm" disabled={dirty} onClick={(event) => { event.stopPropagation(); add(); }}><Plus className="size-ui-4" />Variable</Button> : null}
        </header>
        <div className="flex shrink-0 items-center gap-ui-2 border-b border-border-subtle p-ui-2" onClick={() => { if (showDetails) cancelDraft(); }}>
          <Input aria-label="Search variables" className="min-w-0 flex-1" value={search} placeholder="Search variables…" onChange={(event) => setSearch(event.target.value)} />
          <SelectField label="Variable kind filter" value={type} options={[{ value: "all", label: "All kinds" }, { value: "static", label: "Static" },
            ...(scope === "workspace" || scope === "effective" ? [{ value: "dynamic-request" as const, label: "Dynamic Request" }] : [])]}
            onValueChange={setType} size="lg" className="w-method-popover" />
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-ui-2" onClick={(event) => { if (event.target === event.currentTarget && showDetails) cancelDraft(); }}>
          {scope === "effective" ? <EffectiveTable variables={filtered} workspace={workspace} globalVariables={globalVariables} selectedId={selectedId}
              onSelect={(variable) => { onSelectionChange(variable.id); onDraftChange(null); }} onDefinition={(variable) => selectScope(definitionScope(variable, workspace, globalVariables), variable.id)} />
            : <ScopeTable variables={filtered} scope={scope} workspace={workspace} globalVariables={globalVariables}
              detailsVariableId={activeDraft?.id ?? null} inlineDisabled={dirty} onCreate={persistStatic} onStaticChange={(variable) => persistStatic(variable, true)}
              onInlineStart={() => { onSelectionChange(null); onDraftChange(null); }} onSelect={openVariable} onToggle={toggle}
              confirmDeleteId={confirmDeleteId} onConfirmDelete={setConfirmDeleteId} onDelete={remove} documents={documents} />}
        </div>
        {selectedEnvironment ? <footer className="flex shrink-0 items-center justify-between border-t border-border-subtle p-ui-3">
          <span className="text-ui-xs text-content-tertiary">Static definitions are saved to Git; sensitive values stay encrypted locally.</span>
          {!confirmEnvironmentDelete ? <Button variant="ghost" size="sm" className="text-accent-red" onClick={() => setConfirmEnvironmentDelete(true)}><Trash2 className="size-ui-4" />Delete environment</Button>
            : <div className="flex items-center gap-ui-2"><span className="text-ui-xs text-accent-red">Delete {selectedEnvironment.name}?</span><Button variant="ghost" size="sm" onClick={() => setConfirmEnvironmentDelete(false)}>Cancel</Button><Button variant="secondary" size="sm" className="text-accent-red" onClick={() => onDeleteEnvironment(selectedEnvironment.id)}>Delete</Button></div>}
        </footer> : null}
      </div>

      {showDetails ? <aside className="flex min-h-0 flex-col overflow-hidden border-l border-border-subtle bg-purr-base">
        {scope === "effective" ? <EffectiveDetails variable={selected} workspace={workspace} globalVariables={globalVariables} documents={documents} onDefinition={(variable) => selectScope(definitionScope(variable, workspace, globalVariables), variable.id)} onOpenRequest={onOpenRequest} />
          : activeDraft ? <VariableDetails variable={activeDraft} persisted={persisted} scope={scope} workspace={workspace} globalVariables={globalVariables}
            documents={documents} cached={cacheFor(activeDraft)} onChange={(variable) => onDraftChange(variable)} onToggle={(enabled) => persisted ? toggle(persisted, enabled) : onDraftChange({ ...activeDraft, enabled })}
            onSave={saveDraft} onCancel={cancelDraft} canSave={canSave} dirty={dirty} nameError={nameError} onDelete={() => persisted && (confirmDeleteId === persisted.id ? remove(persisted) : setConfirmDeleteId(persisted.id))}
            deletePending={confirmDeleteId === activeDraft.id} onOpenRequest={onOpenRequest} onResolve={onResolveVariable} />
          : null}
      </aside> : null}
    </div>
  </section>;
}

function validateVariableName(variable: Variable, scope: VariableScope, workspace: Workspace, globals: readonly Variable[]) {
  const name = variable.name.trim();
  if (!name) return "Enter a variable name.";
  if (/[{}]/.test(name)) return "Variable names cannot contain braces.";
  const same = scope === "workspace" ? workspace.variables : scope === "global" ? globals
    : workspace.environments.find((environment) => scope === `environment:${environment.id}`)?.variables ?? [];
  if (same.some((candidate) => candidate.id !== variable.id && candidate.name.trim() === name)) return `Variable “${name}” already exists.`;
  if (scope === "workspace" && (globals.some((candidate) => candidate.name.trim() === name)
    || workspace.environments.some((environment) => environment.variables.some((candidate) => candidate.name.trim() === name)))) return `Variable “${name}” already exists in an effective namespace.`;
  if (scope === "global" && (workspace.variables.some((candidate) => candidate.name.trim() === name)
    || workspace.environments.some((environment) => environment.variables.some((candidate) => candidate.name.trim() === name)))) return `Variable “${name}” already exists in this workspace.`;
  if (scope.startsWith("environment:") && (globals.some((candidate) => candidate.name.trim() === name)
    || workspace.variables.some((candidate) => candidate.name.trim() === name))) return `Variable “${name}” already exists in the effective namespace.`;
  return "";
}

function variableSecretRef(scope: VariableScope, workspace: Workspace, id: string) {
  if (scope === "global") return secretRef("global", "variables", id);
  if (scope.startsWith("environment:")) return secretRef(workspace.id, `environments/${scope.slice("environment:".length)}`, id);
  return secretRef(workspace.id, "variables", id);
}

function VariableIcon({ variable }: { variable: Variable }) {
  return variable.kind === "dynamic-request" ? <RefreshCw className="size-ui-3" />
    : variable.kind === "external-secret" ? <Cloud className="size-ui-3" /> : null;
}

function EffectiveTable({ variables, workspace, globalVariables, selectedId, onSelect, onDefinition }: { variables: Variable[]; workspace: Workspace; globalVariables: Variable[]; selectedId: string | null; onSelect: (variable: Variable) => void; onDefinition: (variable: Variable) => void }) {
  return <div><div className="grid grid-cols-4 gap-ui-2 border-b border-border-subtle px-ui-2 py-ui-1 text-ui-xs text-content-tertiary"><span>Name</span><span>Value / source</span><span>Kind</span><span>Definition</span></div>
    {variables.map((variable) => <div key={variable.id} className={cn("mb-ui-1 grid cursor-pointer grid-cols-4 items-center gap-ui-2 rounded-ui-md px-ui-2 py-ui-1 hover:bg-purr-highlight", selectedId === variable.id && "bg-purr-highlight")} onClick={() => onSelect(variable)}><span className="truncate font-code text-ui-sm text-syntax-property">{variable.name}</span><span className="truncate font-code text-ui-sm text-content-secondary">{variableSummary(variable, workspace)}</span><span className="flex items-center gap-ui-1 text-ui-xs text-content-tertiary"><VariableIcon variable={variable} />{variable.sensitive ? <LockKeyhole className="size-ui-3" /> : null}{kindLabels[variable.kind]}</span><Button variant="ghost" size="xs" className="justify-start" title="Open definition" onClick={(event) => { event.stopPropagation(); onDefinition(variable); }}>{scopeLabel(definitionScope(variable, workspace, globalVariables), workspace)}</Button></div>)}
    {!variables.length ? <p className="p-ui-6 text-center text-ui-sm text-content-tertiary">No enabled variables are effective here.</p> : null}</div>;
}

function ScopeTable({ variables, scope, workspace, globalVariables, detailsVariableId, inlineDisabled, onCreate, onStaticChange, onInlineStart, onSelect, onToggle, confirmDeleteId, onConfirmDelete, onDelete, documents }: {
  variables: Variable[];
  scope: VariableScope;
  workspace: Workspace;
  globalVariables: readonly Variable[];
  detailsVariableId: string | null;
  inlineDisabled: boolean;
  onCreate: (variable: Extract<Variable, { kind: "static" }>) => void;
  onStaticChange: (variable: Extract<Variable, { kind: "static" }>) => void;
  onInlineStart: () => void;
  onSelect: (variable: Variable) => void;
  onToggle: (variable: Variable, enabled: boolean) => void;
  confirmDeleteId: string | null;
  onConfirmDelete: (id: string | null) => void;
  onDelete: (variable: Variable) => void;
  documents: readonly DynamicVariableRequest[];
}) {
  const [quickOpen, setQuickOpen] = useState(false);
  const [quick, setQuick] = useState(() => createStaticVariable());
  const quickName = useRef<HTMLInputElement>(null); const quickValue = useRef<HTMLInputElement>(null);
  const quickError = quick.name || quick.value ? validateVariableName(quick, scope, workspace, globalVariables) : "";
  const commitQuick = () => {
    if (!quick.name.trim() || quickError) return;
    onCreate(quick); setQuick(createStaticVariable()); setQuickOpen(false);
  };
  const closeQuick = () => { setQuick(createStaticVariable()); setQuickOpen(false); };
  useEffect(() => { setQuick(createStaticVariable()); setQuickOpen(false); }, [scope]);
  useEffect(() => { if (quickOpen) requestAnimationFrame(() => quickName.current?.focus()); }, [quickOpen]);

  return <div>
    <div className="grid grid-cols-ui-variable-row gap-ui-2 border-b border-border-subtle px-ui-2 py-ui-1 text-ui-xs text-content-tertiary">
      <span className="text-center">Enabled</span><span className="px-ui-2">Name</span><span className="px-ui-2">Value / source</span><span className="px-ui-2">Kind</span><span aria-label="Actions" />
    </div>
    {variables.map((variable) => {
      const usages = usedBy(variable, documents);
      if (variable.kind === "static") return <StaticVariableRow key={variable.id} variable={variable} scope={scope} workspace={workspace}
        globalVariables={globalVariables} selected={detailsVariableId === variable.id} inlineDisabled={inlineDisabled} onInlineStart={onInlineStart} onChange={onStaticChange}
        onSelect={() => onSelect(variable)} onToggle={(enabled) => onToggle(variable, enabled)} confirmDelete={confirmDeleteId === variable.id}
        onConfirmDelete={() => onConfirmDelete(variable.id)} onDelete={() => onDelete(variable)} usages={usages.length} />;
      return <div key={variable.id} className={cn("group mb-ui-1 grid cursor-pointer grid-cols-ui-variable-row items-center gap-ui-2 rounded-ui-md px-ui-2 py-ui-1 hover:bg-purr-highlight", !variable.enabled && "opacity-ui-muted", detailsVariableId === variable.id && "bg-purr-highlight")} onClick={() => onSelect(variable)}>
        <span className="flex h-control-sm items-center justify-center" onClick={(event) => event.stopPropagation()}><Checkbox hideLabel label={`Enable ${variable.name}`} checked={variable.enabled} onCheckedChange={(enabled) => onToggle(variable, enabled)} /></span>
        <span className="truncate px-ui-2 font-code text-ui-sm text-syntax-property">{variable.name}</span>
        <span className="truncate px-ui-2 font-code text-ui-sm text-content-secondary">{variableSummary(variable, workspace)}</span>
        <span className="flex items-center gap-ui-1 px-ui-2 text-ui-xs text-content-tertiary"><VariableIcon variable={variable} />{variable.sensitive ? <LockKeyhole className="size-ui-3" /> : null}{kindLabels[variable.kind]}</span>
        <span className="flex justify-end" onClick={(event) => event.stopPropagation()}>{confirmDeleteId === variable.id
          ? <Button variant="ghost" size="xs" className="text-accent-red" title={usages.length ? `Used by ${usages.length} requests` : "Delete variable"} onClick={() => onDelete(variable)}>Confirm</Button>
          : <Button variant="ghost" size="icon" className="text-accent-red opacity-ui-hidden transition-opacity duration-ui-fast group-hover:opacity-ui-visible group-focus-within:opacity-ui-visible" aria-label={`Delete ${variable.name}`} onClick={() => onConfirmDelete(variable.id)}><Trash2 className="size-ui-3" /></Button>}</span>
      </div>;
    })}
    {quickOpen ? <div className="mb-ui-1 mt-ui-2 grid grid-cols-ui-variable-row items-start gap-ui-2 rounded-ui-lg border border-action-brand bg-action-brand-surface p-ui-2" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeQuick(); } }}>
      <span className="flex h-control-sm items-center justify-center"><Checkbox hideLabel label="Enable new variable" checked={quick.enabled} onCheckedChange={(enabled) => setQuick({ ...quick, enabled })} /></span>
      <div><Input ref={quickName} disabled={inlineDisabled} aria-label="New variable name" aria-invalid={Boolean(quickError)} className="ui-focus-ring h-control-sm rounded-ui-sm px-ui-2 font-code text-syntax-property" value={quick.name} placeholder="variable_name"
        onChange={(event) => setQuick({ ...quick, name: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); quickValue.current?.focus(); } }} />
        {quickError ? <p role="alert" className="mb-ui-0 mt-ui-1 text-ui-xs text-accent-red">{quickError}</p> : null}</div>
      <Input ref={quickValue} disabled={inlineDisabled} aria-label="New variable value" className="ui-focus-ring h-control-sm rounded-ui-sm px-ui-2 font-code" type={quick.sensitive ? "password" : "text"} value={quick.value} placeholder="Value"
        onChange={(event) => setQuick({ ...quick, value: event.target.value, loaded: true })} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitQuick(); } }} />
      <Button variant="ghost" size="sm" disabled={inlineDisabled} aria-label="Toggle new variable sensitive" aria-pressed={quick.sensitive} className="justify-start" title={quick.sensitive ? "Encrypted in local secure storage" : "Mark as sensitive"} onClick={() => setQuick({ ...quick, sensitive: !quick.sensitive })}>
        <LockKeyhole className={cn("size-ui-3", quick.sensitive ? "text-accent-orange" : "text-content-quaternary")} />Static
      </Button>
      <span className="flex items-center justify-end gap-ui-1"><Button variant="ghost" size="icon" aria-label="Cancel static variable" title="Cancel · Esc" onClick={closeQuick}><X className="size-ui-3" /></Button><Button variant="brand" size="sm" aria-label="Save static variable" disabled={inlineDisabled || !quick.name.trim() || Boolean(quickError)} onClick={commitQuick}><Save className="size-ui-3" />Save</Button></span>
    </div> : <Button variant="ghost" size="sm" className="mt-ui-2" disabled={inlineDisabled} onClick={() => { onInlineStart(); setQuick(createStaticVariable()); setQuickOpen(true); }}><Plus className="size-ui-3" />Add static variable</Button>}
  </div>;
}

function StaticVariableRow({ variable, scope, workspace, globalVariables, selected, inlineDisabled, onInlineStart, onChange, onSelect, onToggle, confirmDelete, onConfirmDelete, onDelete, usages }: {
  variable: Extract<Variable, { kind: "static" }>;
  scope: VariableScope;
  workspace: Workspace;
  globalVariables: readonly Variable[];
  selected: boolean;
  inlineDisabled: boolean;
  onInlineStart: () => void;
  onChange: (variable: Extract<Variable, { kind: "static" }>) => void;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  confirmDelete: boolean;
  onConfirmDelete: () => void;
  onDelete: () => void;
  usages: number;
}) {
  const [name, setName] = useState(variable.name);
  useEffect(() => setName(variable.name), [variable.name]);
  const candidate = { ...variable, name }; const error = validateVariableName(candidate, scope, workspace, globalVariables);
  return <div className={cn("group mb-ui-1 grid cursor-pointer grid-cols-ui-variable-row items-start gap-ui-2 rounded-ui-md px-ui-2 py-ui-1 hover:bg-purr-highlight", !variable.enabled && "opacity-ui-muted", selected && "bg-purr-highlight")} onClick={onSelect}>
    <span className="flex h-control-sm items-center justify-center" onClick={(event) => event.stopPropagation()}><Checkbox hideLabel label={`Enable ${variable.name}`} checked={variable.enabled} onCheckedChange={onToggle} /></span>
    <div onClick={(event) => event.stopPropagation()}><Input variant="transparent" disabled={inlineDisabled} aria-label={`Variable name ${variable.name}`} aria-invalid={Boolean(error)} className="ui-focus-ring h-control-sm rounded-ui-sm px-ui-2 font-code text-syntax-property transition-colors duration-ui-fast focus:border-border-default focus:bg-purr-elevated" value={name}
      onFocus={onInlineStart} onChange={(event) => { const next = event.target.value; setName(next); const nextVariable = { ...variable, name: next }; if (!validateVariableName(nextVariable, scope, workspace, globalVariables)) onChange(nextVariable); }} />
      {error ? <p role="alert" className="mb-ui-0 mt-ui-1 text-ui-xs text-accent-red">{error}</p> : null}</div>
    <Input variant="transparent" disabled={inlineDisabled} aria-label={`Variable value ${variable.name}`} className="ui-focus-ring h-control-sm rounded-ui-sm px-ui-2 font-code transition-colors duration-ui-fast focus:border-border-default focus:bg-purr-elevated" type={variable.sensitive ? "password" : "text"} value={variable.value}
      onClick={(event) => event.stopPropagation()} onFocus={onInlineStart} onChange={(event) => onChange({ ...variable, value: event.target.value, loaded: true })} />
    <Button variant="ghost" size="sm" disabled={inlineDisabled} aria-label={`Toggle ${variable.name} sensitive`} aria-pressed={variable.sensitive} className="justify-start" title={variable.sensitive ? "Encrypted in local secure storage" : "Mark as sensitive"}
      onClick={(event) => { event.stopPropagation(); onInlineStart(); onChange({ ...variable, sensitive: !variable.sensitive }); }}><LockKeyhole className={cn("size-ui-3", variable.sensitive ? "text-accent-orange" : "opacity-ui-hidden transition-opacity duration-ui-fast group-hover:opacity-ui-visible group-focus-within:opacity-ui-visible")} />Static</Button>
    <span className="flex justify-end" onClick={(event) => event.stopPropagation()}>{confirmDelete
      ? <Button variant="ghost" size="xs" className="text-accent-red" title={usages ? `Used by ${usages} requests` : "Delete variable"} onClick={onDelete}>Confirm</Button>
      : <Button variant="ghost" size="icon" className="text-accent-red opacity-ui-hidden transition-opacity duration-ui-fast group-hover:opacity-ui-visible group-focus-within:opacity-ui-visible" aria-label={`Delete ${variable.name}`} onClick={onConfirmDelete}><Trash2 className="size-ui-3" /></Button>}</span>
  </div>;
}

function EffectiveDetails({ variable, workspace, globalVariables, documents, onDefinition, onOpenRequest }: { variable: Variable | null; workspace: Workspace; globalVariables: Variable[]; documents: readonly DynamicVariableRequest[]; onDefinition: (variable: Variable) => void; onOpenRequest: (id: string) => void }) {
  if (!variable) return <div className="flex h-full items-center justify-center p-ui-6 text-center text-ui-sm text-content-tertiary">Select a definition from the table.</div>;
  const usages = usedBy(variable, documents);
  const definition = scopeLabel(definitionScope(variable, workspace, globalVariables), workspace);
  return <div className="min-h-0 flex-1 overflow-auto p-ui-5">
    <div className="rounded-ui-xl border border-border-subtle bg-purr-surface p-ui-4 shadow-panel">
      <div className="flex items-start justify-between gap-ui-3"><div><p className="m-ui-0 text-ui-xs text-content-tertiary">Effective variable</p><h2 className="mb-ui-0 mt-ui-1 break-all font-code text-ui-xl text-syntax-property">{`{{${variable.name}}}`}</h2></div><span className="flex items-center gap-ui-1 rounded-ui-md bg-purr-highlight px-ui-2 py-ui-1 text-ui-xs text-content-secondary"><VariableIcon variable={variable} />{variable.sensitive ? <LockKeyhole className="size-ui-3 text-accent-orange" /> : null}{kindLabels[variable.kind]}</span></div>
      <div className="mt-ui-4 rounded-ui-lg border border-border-subtle bg-purr-codefield p-ui-3"><p className="m-ui-0 text-ui-xs text-content-tertiary">Resolved value / source</p><p className="mb-ui-0 mt-ui-2 break-all font-code text-ui-sm text-content-primary">{variableSummary(variable, workspace)}</p></div>
      <div className="mt-ui-4 flex items-center justify-between gap-ui-2 border-t border-border-subtle pt-ui-4"><div><p className="m-ui-0 text-ui-xs text-content-tertiary">Definition</p><p className="mb-ui-0 mt-ui-1 text-ui-sm text-content-primary">{definition}</p></div><Button variant="secondary" size="sm" title="Open definition" onClick={() => onDefinition(variable)}>Open definition</Button></div>
      {usages.length ? <div className="mt-ui-4 border-t border-border-subtle pt-ui-4"><p className="m-ui-0 text-ui-xs text-content-tertiary">Referenced in {usages.length} request{usages.length === 1 ? "" : "s"}</p>{usages.map((document) => <Button key={document.id} variant="ghost" size="sm" className="mt-ui-1 w-full justify-start font-code" onClick={() => onOpenRequest(document.id)}>{document.name}</Button>)}</div> : null}
    </div>
  </div>;
}

function VariableDetails({ variable, persisted, scope, workspace, globalVariables, documents, cached, onChange, onToggle, onSave, onCancel, canSave, dirty, nameError, onDelete, deletePending, onOpenRequest, onResolve }: { variable: Variable; persisted?: Variable; scope: VariableScope; workspace: Workspace; globalVariables: readonly Variable[]; documents: readonly DynamicVariableRequest[]; cached?: Workspace["dynamicVariableCache"][string]; onChange: (variable: Variable) => void; onToggle: (enabled: boolean) => void; onSave: () => void; onCancel: () => void; canSave: boolean; dirty: boolean; nameError: string; onDelete: () => void; deletePending: boolean; onOpenRequest: (id: string) => void; onResolve: (variable: Variable) => Promise<void> }) {
  const [revealed, setRevealed] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState("");
  const usages = usedBy(variable, documents);
  const graph = variable.kind === "dynamic-request" ? inspectDynamicVariableGraph(variable, getEffectiveVariables(workspace, globalVariables), documents) : undefined;
  const changeKind = (kind: "static" | "dynamic-request") => onChange(kind === "static" ? { id: variable.id, name: variable.name, enabled: variable.enabled, sensitive: variable.sensitive, kind: "static", value: "" } : { ...createDynamicVariable(variable.name), id: variable.id, enabled: variable.enabled, sensitive: variable.sensitive });
  const source = variable.kind === "dynamic-request" ? documents.find((document) => document.id === variable.documentId) : undefined;
  return <div className="flex h-full min-h-0 flex-col">
    <div className="min-h-0 flex-1 space-y-ui-5 overflow-auto p-ui-5">
      <h2 className="m-ui-0 text-ui-lg font-medium">Variable definition</h2>
      <div className="space-y-ui-2"><div className="flex items-center justify-between gap-ui-3"><label htmlFor={`variable-name-${variable.id}`} className="text-ui-sm font-medium text-content-primary">Name</label><span className="flex items-center gap-ui-2 text-ui-sm text-content-secondary">Enabled<Switch label="Enable variable" checked={variable.enabled} onCheckedChange={onToggle} /></span></div><Input id={`variable-name-${variable.id}`} autoFocus={!persisted} aria-label="Variable name" aria-invalid={Boolean(nameError)} className="font-code" value={variable.name} placeholder="variable_name" onChange={(event) => onChange({ ...variable, name: event.target.value })} /><p role={nameError ? "alert" : undefined} className={cn("m-ui-0 text-ui-xs", nameError ? "text-accent-red" : "text-content-tertiary")}>{nameError || `Referenced in requests as {{${variable.name || "variable_name"}}}`}</p></div>
      <VariableKindPicker value={variable.kind === "dynamic-request" ? "dynamic-request" : "static"} allowDynamic={scope === "workspace"} onChange={changeKind} />
      {variable.kind === "static" ? <StaticFields variable={variable} revealed={revealed} onReveal={() => setRevealed(!revealed)} onChange={onChange} /> : null}
      {variable.kind === "dynamic-request" ? <>
        <section aria-label="Source dependency request" className="space-y-ui-2"><div className="flex items-center justify-between gap-ui-2"><h3 className="m-ui-0 text-ui-sm font-medium">Source dependency request</h3><Button variant="ghost" size="sm" disabled={!source} onClick={() => source && onOpenRequest(source.id)}>Jump to request ↗</Button></div><RequestSelect value={variable.documentId} documents={documents} onChange={(documentId) => onChange({ ...variable, documentId })} /></section>
        <section aria-label="Extraction strategy" className="space-y-ui-2"><h3 className="m-ui-0 text-ui-sm font-medium">Extraction strategy</h3><SelectField label="Extractor type" size="lg" className="w-full" value={variable.language} options={[{ value: "jsonpath", label: "JSONPath" }, { value: "jq", label: "jq" }]} onValueChange={(language) => onChange({ ...variable, language })} /><Input aria-label="Response path" className="font-code" value={variable.expression} placeholder="Response path, e.g. $.media.url" onChange={(event) => onChange({ ...variable, expression: event.target.value })} /></section>
        <section className="space-y-ui-2"><h3 className="m-ui-0 text-ui-sm font-medium">Source environment</h3><SelectField label="Dynamic variable source environment" size="lg" className="w-full" value={variable.environment.type === "current" ? "current" : variable.environment.environmentId} options={[{ value: "current", label: "Current environment" }, ...workspace.environments.map((environment) => ({ value: environment.id, label: environment.name }))]} onValueChange={(value) => onChange({ ...variable, environment: value === "current" ? { type: "current" } : { type: "specific", environmentId: value } })} /></section>
        <section aria-label="Invalidation strategy" className="space-y-ui-2"><h3 className="m-ui-0 text-ui-sm font-medium">Invalidation strategy</h3><SelectField label="Invalidation strategy" size="lg" className="w-full" value={variable.refresh} options={[{ value: "every-time", label: "Every time" }, { value: "session", label: "Once per session" }, { value: "cache", label: "Cache for…" }]} onValueChange={(refresh) => onChange({ ...variable, refresh, ...(refresh === "cache" ? { cacheTtlSeconds: variable.cacheTtlSeconds ?? 300 } : {}) })} />{variable.refresh === "cache" ? <FormField label="Cache duration (seconds)" type="number" min="1" value={String(variable.cacheTtlSeconds ?? 300)} onChange={(event) => onChange({ ...variable, cacheTtlSeconds: Math.max(1, Number(event.target.value) || 1) })} /> : null}</section>
        <SensitiveToggle checked={variable.sensitive} title="Treat as sensitive value" description="Mask the resolved value and store its cache in the encrypted local secret vault." onChange={(sensitive) => onChange({ ...variable, sensitive })} />
        <ResolutionCard variable={variable} cached={cached} usages={usages} revealed={revealed} resolving={resolving} resolveError={resolveError} dirty={dirty} persisted={Boolean(persisted)} onReveal={() => setRevealed(!revealed)} onExecute={async () => { setResolving(true); setResolveError(""); try { await onResolve(variable); } catch (cause) { setResolveError(cause instanceof Error ? cause.message : String(cause)); } finally { setResolving(false); } }} />
        <div className="rounded-ui-lg border border-border-subtle bg-purr-codefield p-ui-3"><p className="m-ui-0 text-ui-xs text-content-tertiary">Dependencies</p>{graph?.edges.length ? graph.edges.map((edge) => <p key={edge} className="mb-ui-0 mt-ui-1 break-words font-code text-ui-sm text-content-secondary">{edge}</p>) : <p className="mb-ui-0 mt-ui-1 text-ui-sm text-content-tertiary">No dependencies.</p>}{graph?.cycle ? <p role="alert" className="mb-ui-0 mt-ui-2 break-words font-code text-ui-xs text-accent-red">Cycle: {graph.cycle}</p> : null}</div>
        {usages.length ? <div><p className="text-ui-xs text-content-tertiary">Used by</p>{usages.map((document) => <Button key={document.id} variant="ghost" size="sm" className="w-full justify-start font-code" onClick={() => onOpenRequest(document.id)}>{document.name}</Button>)}</div> : null}
      </> : null}
    </div>
    <footer className="flex shrink-0 items-center justify-between gap-ui-3 border-t border-border bg-purr-elevated p-ui-4"><Button variant="ghost" size="sm" className="text-accent-red" disabled={!persisted} onClick={onDelete}><Trash2 className="size-ui-4" />{deletePending ? `Confirm delete${usages.length ? ` · used by ${usages.length}` : ""}` : "Delete variable"}</Button><div className="flex gap-ui-2"><Button variant="ghost" aria-label="Cancel variable changes" onClick={onCancel}>Cancel <span className="font-code text-ui-2xs text-content-tertiary">Esc</span></Button><Button variant="brand" aria-label="Save variable" disabled={!dirty || !canSave} onClick={onSave}><Save className="size-ui-4" />Save changes <span className="font-code text-ui-2xs">⌘S</span></Button></div></footer>
  </div>;
}

function StaticFields({ variable, revealed, onReveal, onChange }: { variable: Extract<Variable, { kind: "static" }>; revealed: boolean; onReveal: () => void; onChange: (variable: Variable) => void }) {
  return <><div className="space-y-ui-2"><span className="block text-ui-sm font-medium text-content-primary">Value</span><div className="flex items-center gap-ui-1"><Input aria-label="Variable value" className="min-w-0 flex-1 font-code" type={variable.sensitive && !revealed ? "password" : "text"} value={variable.value} placeholder="Value" autoComplete="off" onChange={(event) => onChange({ ...variable, value: event.target.value, loaded: true })} />{variable.sensitive ? <Button variant="ghost" size="icon" aria-label={revealed ? "Hide value" : "Reveal value"} onClick={onReveal}>{revealed ? <EyeOff className="size-ui-4" /> : <Eye className="size-ui-4" />}</Button> : null}</div></div><SensitiveToggle checked={variable.sensitive} title="Sensitive & masked secret" description="Encrypt the value in Purr’s local secret vault. Excluded from workspace YAML, exports, and Git synchronization." onChange={(sensitive) => onChange({ ...variable, sensitive })} /></>;
}

function VariableKindPicker({ value, allowDynamic, onChange }: { value: "static" | "dynamic-request"; allowDynamic: boolean; onChange: (kind: "static" | "dynamic-request") => void }) {
  const options = [{ value: "static" as const, label: "Static", icon: FileText }, ...(allowDynamic ? [{ value: "dynamic-request" as const, label: "Dynamic Request", icon: Zap }] : [])];
  return <section className="space-y-ui-2"><div className="flex items-center justify-between"><h3 className="m-ui-0 text-ui-sm font-medium">Variable kind</h3><span className="text-ui-xs text-content-tertiary">Select evaluation strategy</span></div><div role="tablist" aria-label="Variable kind" className={cn("grid overflow-hidden rounded-ui-lg border border-border bg-purr-codefield p-ui-1", allowDynamic ? "grid-cols-2" : "grid-cols-1")}>{options.map((option) => { const Icon = option.icon; const active = value === option.value; return <Button key={option.value} role="tab" aria-selected={active} variant="ghost" size="sm" className={cn("h-control-lg flex-1 rounded-ui-md border px-ui-2", active ? "border-action-brand bg-action-brand-surface text-content-primary" : "border-transparent text-content-tertiary")} onClick={() => onChange(option.value)}><Icon className={cn("size-ui-4", active && "text-action-brand")} />{option.label}</Button>; })}</div></section>;
}

function SensitiveToggle({ checked, title, description, onChange }: { checked: boolean; title: string; description: string; onChange: (checked: boolean) => void }) {
  return <section className="flex items-center gap-ui-3 rounded-ui-xl border border-border bg-purr-codefield p-ui-4"><span className="flex size-ui-10 shrink-0 items-center justify-center rounded-ui-lg border border-border bg-purr-elevated text-accent-orange"><LockKeyhole className="size-ui-5" /></span><div className="min-w-0 flex-1"><h3 className="m-ui-0 text-ui-sm font-medium text-content-primary">{title}</h3><p className="mb-ui-0 mt-ui-1 text-ui-xs text-content-tertiary">{description}</p></div><Switch label={title} checked={checked} onCheckedChange={onChange} /></section>;
}

function RequestMethodBadge({ document }: { document: DynamicVariableRequest }) {
  const label = document.kind === "graphql" ? "GQL" : document.request.method;
  const color = document.kind === "graphql" ? "text-action-graphql" : getHttpMethodStyle(document.request.method).text;
  return <span className={cn("shrink-0 rounded-ui-md bg-purr-highlight px-ui-2 py-ui-1 font-code text-ui-xs font-medium", color)}>{label}</span>;
}

function RequestSelect({ value, documents, onChange }: { value: string; documents: readonly DynamicVariableRequest[]; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const listboxId = useId();
  const selected = documents.find((document) => document.id === value);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" role="combobox" aria-label="Dynamic variable source request" aria-expanded={open} aria-controls={listboxId}
        className="ui-focus-ring flex h-control-lg w-full min-w-0 items-center justify-between gap-ui-2 rounded-ui-lg border border-border-subtle bg-purr-elevated px-ui-2 text-content-secondary transition-colors duration-ui-fast hover:bg-purr-highlight hover:text-content-primary">
        <span className="flex min-w-0 items-center gap-ui-2">{selected ? <><RequestMethodBadge document={selected} /><span className="truncate font-code text-ui-sm">{selected.name}</span></> : <span className="truncate text-ui-sm text-content-tertiary">Select saved request…</span>}</span>
        <ChevronDown className={cn("size-ui-3 shrink-0 transition-transform duration-ui-fast", open && "rotate-180")} aria-hidden="true" />
      </button>
    </PopoverTrigger>
    <PopoverContent className="ui-popover-match-anchor z-50 overflow-hidden rounded-ui-md border border-border-default bg-purr-overlay p-ui-1 shadow-popover" side="bottom" align="start" sideOffset={4}>
      <div id={listboxId} role="listbox" aria-label="Dynamic variable source request" className="max-h-variable-list overflow-auto">
        <button type="button" role="option" aria-label="Select saved request" aria-selected={!value}
          className={cn("ui-focus-ring flex h-control-sm w-full items-center justify-between rounded-ui-sm px-ui-2 text-ui-sm text-content-tertiary hover:bg-purr-highlight hover:text-content-primary", !value && "bg-purr-highlight text-content-primary")}
          onClick={() => { onChange(""); setOpen(false); }}><span>Select saved request…</span>{!value ? <Check className="size-ui-3 text-action-brand" aria-hidden="true" /> : null}</button>
        {documents.map((document) => <button key={document.id} type="button" role="option" aria-label={document.name} aria-selected={document.id === value}
          className={cn("ui-focus-ring flex h-control-lg w-full items-center justify-between gap-ui-2 rounded-ui-sm px-ui-2 text-content-secondary hover:bg-purr-highlight hover:text-content-primary", document.id === value && "bg-purr-highlight text-content-primary")}
          onClick={() => { onChange(document.id); setOpen(false); }}><span className="flex min-w-0 items-center gap-ui-2"><RequestMethodBadge document={document} /><span className="truncate font-code text-ui-sm">{document.name}</span></span>{document.id === value ? <Check className="size-ui-3 shrink-0 text-action-brand" aria-hidden="true" /> : null}</button>)}
      </div>
    </PopoverContent>
  </Popover>;
}

function relativeResolutionTime(value: string) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function ResolutionCard({ variable, cached, usages, revealed, resolving, resolveError, dirty, persisted, onReveal, onExecute }: { variable: Extract<Variable, { kind: "dynamic-request" }>; cached?: Workspace["dynamicVariableCache"][string]; usages: DynamicVariableRequest[]; revealed: boolean; resolving: boolean; resolveError: string; dirty: boolean; persisted: boolean; onReveal: () => void; onExecute: () => Promise<void> }) {
  const value = cached?.status === "success" ? cached.value ?? "" : ""; const masked = variable.sensitive && !revealed;
  return <section className="rounded-ui-xl border border-border bg-purr-codefield p-ui-4"><div className="flex items-center justify-between gap-ui-3"><span className={cn("flex items-center gap-ui-2 font-code text-ui-sm", cached?.status === "error" ? "text-accent-red" : cached ? "text-status-success" : "text-content-tertiary")}><span className={cn("size-ui-2 rounded-full", cached?.status === "error" ? "bg-accent-red" : cached ? "bg-status-success" : "bg-content-quaternary")} />{cached ? `${cached.status === "success" ? "Resolved" : "Failed"} · ${relativeResolutionTime(cached.resolvedAt)}` : "Not resolved yet"}</span><Button variant="secondary" size="sm" disabled={resolving || dirty || !persisted} onClick={() => void onExecute()}><RefreshCw className={cn("size-ui-3", resolving && "animate-spin")} />{resolving ? "Executing…" : "Execute"}</Button></div>
    {cached?.status === "success" ? <div className="mt-ui-3 rounded-ui-lg bg-purr-elevated p-ui-3"><div className="flex items-center justify-between gap-ui-2"><p className="m-ui-0 font-code text-ui-xs text-content-tertiary">Resolved value ({new TextEncoder().encode(value).length} bytes)</p><div className="flex items-center gap-ui-1">{variable.sensitive ? <Button variant="ghost" size="icon" aria-label={revealed ? "Hide resolved value" : "Reveal resolved value"} onClick={onReveal}>{revealed ? <EyeOff className="size-ui-4" /> : <Eye className="size-ui-4" />}</Button> : null}<Button variant="ghost" size="sm" disabled={masked} onClick={() => void navigator.clipboard.writeText(value)}><Copy className="size-ui-3" />Copy</Button></div></div><p className="mb-ui-0 mt-ui-2 break-all font-code text-ui-sm text-syntax-string">{masked ? "********" : value}</p><p className="mb-ui-0 mt-ui-1 font-code text-ui-xs text-content-tertiary">{Math.round(cached.durationMs)} ms · {cached.environmentId ?? "current environment"}</p></div> : null}
    {cached?.status === "error" ? <p role="alert" className="mb-ui-0 mt-ui-3 break-words font-code text-ui-xs text-accent-red">{cached.error}</p> : null}{resolveError ? <p role="alert" className="mb-ui-0 mt-ui-3 text-ui-xs text-accent-red">{resolveError}</p> : null}
    <div className="mt-ui-3 flex items-center justify-between border-t border-border-subtle pt-ui-3 text-ui-xs text-content-tertiary"><span>Referenced in {usages.length} active request{usages.length === 1 ? "" : "s"}</span><span className={cached?.status === "success" ? "text-status-success" : undefined}>{cached?.status === "success" ? "Ready" : "Awaiting execution"}</span></div>
  </section>;
}

function EnvironmentName({ environment, siblings, onChange }: { environment: Environment; siblings: Environment[]; onChange: (environment: Environment) => void }) {
  const [draft, setDraft] = useState(environment.name);
  const duplicate = siblings.some((candidate) => candidate.id !== environment.id && candidate.name.trim() === draft.trim());
  useEffect(() => setDraft(environment.name), [environment.id, environment.name]);
  return <div><Input aria-label="Environment name" aria-invalid={duplicate || !draft.trim()} className="font-ui text-ui-lg font-medium" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft.trim() && !duplicate) onChange({ ...environment, name: draft.trim() }); }} />{duplicate ? <p role="alert" className="mb-ui-0 mt-ui-1 text-ui-xs text-accent-red">An environment with this name already exists.</p> : null}</div>;
}
