import { Pencil, Plus, Trash2, Unplug } from "lucide-react";
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import { AuthEditor } from "../../request-workbench/components/auth-editor";
import { KeyValueEditor, type KeyValueEntry } from "../../request-workbench/components/key-value-editor";
import { useAuthRuntime } from "../../request-workbench/hooks/use-auth-runtime";
import { authTypeOptions, createRequestAuth, type AuthContext } from "../../request-workbench/model/request-auth";
import { initialRequestDraft, isRequestHeaderNameValid, type RequestDraft } from "../../request-workbench/model/request";
import {
  requestScopeOptions,
  type RequestScope,
  type WorkspaceRequestConfig,
  type WorkspaceSharedAuth,
} from "../../request-workbench/model/request-workspace-config";
import { commonHttpHeaders } from "../../../shared/config/http-headers";
import { Button } from "../../../shared/components/ui/button";
import { Checkbox } from "../../../shared/components/ui/checkbox";
import { FormField } from "../../../shared/components/ui/form-field";
import { SegmentedTabs } from "../../../shared/components/ui/segmented-tabs";
import { SelectField } from "../../../shared/components/ui/select-field";
import type { TemplateVariableActions } from "../../request-workbench/components/template-variable-popover";
import type { IntegrationDefinition } from "../../../domain/project";

type SettingsTab = "general" | "headers" | "auth" | "integrations";

const scopeLabel = (scope: RequestScope) => scope === "all" ? "All requests" : `${scope === "graphql" ? "GraphQL" : "HTTP"} requests`;
const authLabel = (auth: WorkspaceSharedAuth) => authTypeOptions.find((option) => option.value === auth.value.type)?.label ?? auth.value.type;

function availableAuthScopes(_auth: WorkspaceSharedAuth[], _editingId?: string) {
  return requestScopeOptions.map((option) => option.value);
}

export function WorkspaceSettings({
  name,
  description,
  config,
  integrations,
  variables,
  variableActions,
  onNameChange,
  onDescriptionChange,
  onConfigChange,
  onIntegrationChange,
  onIntegrationDelete,
  onDelete,
}: {
  name: string;
  description: string;
  config: WorkspaceRequestConfig;
  integrations: readonly IntegrationDefinition[];
  variables: Record<string, string>;
  variableActions?: TemplateVariableActions;
  onNameChange: (name: string) => void;
  onDescriptionChange: (description: string) => void;
  onConfigChange: (config: WorkspaceRequestConfig) => void;
  onIntegrationChange: (id: string, change: Partial<Pick<IntegrationDefinition, "enabled">>) => void;
  onIntegrationDelete: (id: string) => void;
  onDelete: () => Promise<void>;
}) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [editingAuth, setEditingAuth] = useState<WorkspaceSharedAuth | null>(null);
  const [authContext, setAuthContext] = useState<AuthContext>({ variables });
  const [emptyHeaderId, setEmptyHeaderId] = useState(() => crypto.randomUUID());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDeleteIntegration, setConfirmDeleteIntegration] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => setAuthContext((current) => ({ ...current, variables })), [variables]);
  const authDraft: RequestDraft = {
    ...initialRequestDraft,
    auth: editingAuth?.value ?? createRequestAuth(),
  };
  const setAuthDraft: Dispatch<SetStateAction<RequestDraft>> = (change) => {
    setEditingAuth((current) => {
      if (!current) return current;
      const currentDraft = { ...initialRequestDraft, auth: current.value };
      const next = typeof change === "function" ? change(currentDraft) : change;
      return { ...current, value: next.auth };
    });
  };
  const authRuntime = useAuthRuntime(authDraft, setAuthDraft, authContext, setAuthContext);
  const headerEntries: KeyValueEntry[] = [
    ...config.headers.map((header) => ({
      id: header.id,
      key: header.name,
      value: header.value,
      enabled: header.enabled,
      scope: header.scope,
    })),
    { id: emptyHeaderId, key: "", value: "", enabled: false, scope: "all" },
  ];
  const scopes = availableAuthScopes(config.auth, editingAuth?.id);
  const canSaveAuth = Boolean(
    editingAuth?.name.trim()
      && editingAuth.value.type !== "none"
      && editingAuth.value.type !== "inherit"
      && scopes.includes(editingAuth.scope),
  );

  return (
    <section aria-label="Workspace settings" className="flex h-full min-h-0 flex-col overflow-hidden bg-purr-base p-ui-2">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-ui-xl border border-border-subtle bg-purr-surface shadow-panel">
        <header className="flex shrink-0 items-center justify-between border-b border-border-subtle px-ui-5 py-ui-3">
          <div>
            <h1 className="m-ui-0 text-ui-xl font-medium text-content-primary">Workspace settings</h1>
            <p className="mb-ui-0 mt-ui-1 text-ui-xs text-content-tertiary">Configure identity and request defaults for this workspace.</p>
          </div>
        </header>
        <div className="shrink-0 border-b border-border-subtle px-ui-4 py-ui-2">
          <SegmentedTabs id="workspace-settings" panelId="workspace-settings-panel" label="Workspace settings"
            value={tab} options={[{ value: "general", label: "General" }, { value: "headers", label: "Shared headers" }, { value: "auth", label: "Shared auth" }, { value: "integrations", label: "Integrations" }]} onValueChange={setTab} />
        </div>
        <div id="workspace-settings-panel" role="tabpanel" className="min-h-0 flex-1 overflow-auto p-ui-5">
          {tab === "general" ? (
            <div className="max-w-ui-dialog space-y-ui-5">
              <FormField label="Workspace name" value={name} placeholder="Workspace name" onChange={(event) => onNameChange(event.target.value)} />
              <div className="space-y-ui-2">
                <label htmlFor="workspace-description" className="block text-ui-xs font-medium text-content-secondary">Description</label>
                <textarea id="workspace-description" aria-label="Workspace description" className="ui-focus-ring h-ui-16 w-full resize-y rounded-ui-lg border border-border-subtle bg-purr-elevated px-ui-3 py-ui-2 font-ui text-ui-md text-content-primary outline-none placeholder:text-content-tertiary"
                  value={description} placeholder="What is this workspace used for?" onChange={(event) => onDescriptionChange(event.target.value)} />
              </div>
              <div className="border-t border-border-subtle pt-ui-5">
                <h2 className="m-ui-0 text-ui-md font-medium text-accent-red">Delete workspace</h2>
                <p className="mb-ui-3 mt-ui-1 text-ui-xs text-content-tertiary">Removes Purr’s local state and managed project directory. An attached external directory is left on disk.</p>
                {!confirmDelete ? <Button variant="secondary" className="text-accent-red" onClick={() => setConfirmDelete(true)}><Trash2 className="size-ui-4" />Delete workspace</Button>
                  : <div className="flex items-center gap-ui-2"><span className="text-ui-sm text-accent-red">Delete “{name}”?</span><Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button><Button variant="secondary" className="text-accent-red" disabled={deleting} onClick={async () => { setDeleting(true); try { await onDelete(); } finally { setDeleting(false); } }}>{deleting ? "Deleting…" : "Delete permanently"}</Button></div>}
              </div>
            </div>
          ) : tab === "headers" ? (
            <div className="space-y-ui-3">
              <div>
                <h2 className="m-ui-0 text-ui-md font-medium text-content-primary">Shared headers</h2>
                <p className="mb-ui-0 mt-ui-1 text-ui-xs text-content-tertiary">The final empty row creates a header. Local request headers with the same name take precedence.</p>
              </div>
              <div className="overflow-visible rounded-ui-lg border border-border-subtle bg-purr-codefield">
                <KeyValueEditor entries={headerEntries} createEmptyEntry={() => ({ id: emptyHeaderId, key: "", value: "", enabled: false, scope: "all" })}
                  onEntriesChange={(entries) => {
                    if (entries.some((entry) => entry.id === emptyHeaderId && (entry.key || entry.value))) setEmptyHeaderId(crypto.randomUUID());
                    onConfigChange({ ...config, headers: entries.filter((entry) => entry.key || entry.value).map((entry) => ({
                    id: entry.id,
                    name: entry.key,
                    value: entry.value,
                    enabled: entry.enabled,
                    scope: (entry.scope ?? "all") as RequestScope,
                  })) });
                  }}
                  keyLabel="shared header" keyPlaceholder="Header-name" valuePlaceholder="value or {{variable}}" keyTextClassName="text-syntax-property"
                  keySuggestions={commonHttpHeaders} isKeyValid={isRequestHeaderNameValid}
                  validationMessage="Header names may only use valid HTTP token symbols." valueFont="code"
                  scopeOptions={requestScopeOptions} scopeLabel={(entry) => `Requests for ${entry.key || "shared header"}`} />
              </div>
            </div>
          ) : tab === "auth" ? (
            <div className="space-y-ui-4">
              <div className="flex items-start justify-between gap-ui-4">
                <div>
                  <h2 className="m-ui-0 text-ui-md font-medium text-content-primary">Shared authentication</h2>
                  <p className="mb-ui-0 mt-ui-1 text-ui-xs text-content-tertiary">Add reusable profiles and select the required profile from each request’s Inherit authentication.</p>
                </div>
                <Button variant="secondary" size="sm" disabled={Boolean(editingAuth)} onClick={() => {
                  const available = availableAuthScopes(config.auth);
                  setEditingAuth({ id: crypto.randomUUID(), name: "", enabled: true, scope: available[0] ?? "all", value: createRequestAuth() });
                }}><Plus className="size-ui-4" />Add shared auth</Button>
              </div>
              {editingAuth ? (
                <div className="space-y-ui-4 rounded-ui-lg border border-border-subtle bg-purr-codefield p-ui-4">
                  <div className="grid gap-ui-4 md:grid-cols-2">
                    <FormField label="Auth name" value={editingAuth.name} placeholder="Production API auth" onChange={(event) => setEditingAuth((current) => current ? { ...current, name: event.target.value } : current)} />
                    <div className="space-y-ui-2">
                      <span className="block text-ui-xs font-medium text-content-secondary">Applies to</span>
                      <SelectField<RequestScope> label="Requests using this authentication" size="lg" value={editingAuth.scope}
                        options={requestScopeOptions.filter((option) => scopes.includes(option.value))}
                        onValueChange={(scope) => setEditingAuth((current) => current ? { ...current, scope } : current)} className="w-full" />
                    </div>
                  </div>
                  <div className="overflow-hidden rounded-ui-lg border border-border-subtle">
                    <AuthEditor auth={editingAuth.value} onAuthChange={(value) => setEditingAuth((current) => current ? { ...current, value } : current)}
                      context={authContext} runtime={authRuntime} variableActions={variableActions} allowInherit={false} idPrefix="workspace-shared" ariaLabel="Workspace shared authentication" />
                  </div>
                  <div className="flex justify-end gap-ui-2">
                    <Button variant="ghost" onClick={() => setEditingAuth(null)}>Cancel</Button>
                    <Button variant="brand" disabled={!canSaveAuth} onClick={() => {
                      if (!editingAuth || !canSaveAuth) return;
                      const saved = { ...editingAuth, name: editingAuth.name.trim() };
                      onConfigChange({ ...config, auth: [...config.auth.filter((entry) => entry.id !== saved.id), saved] });
                      setEditingAuth(null);
                    }}>Save authentication</Button>
                  </div>
                </div>
              ) : null}
              <div className="space-y-ui-2">
                {config.auth.map((auth) => (
                  <div key={auth.id} className="flex items-center gap-ui-3 rounded-ui-lg border border-border-subtle bg-purr-codefield px-ui-3 py-ui-2">
                    <Checkbox checked={auth.enabled} hideLabel label={`Enable ${auth.name}`} onCheckedChange={(enabled) => onConfigChange({ ...config, auth: config.auth.map((entry) => entry.id === auth.id ? { ...entry, enabled } : entry) })} />
                    <div className="min-w-0 flex-1">
                      <p className="m-ui-0 truncate text-ui-sm font-medium text-content-primary">{auth.name}</p>
                      <p className="m-ui-0 font-code text-ui-xs text-content-tertiary">{authLabel(auth)} · {scopeLabel(auth.scope)}</p>
                    </div>
                    <Button variant="ghost" size="icon" aria-label={`Edit ${auth.name}`} onClick={() => setEditingAuth(structuredClone(auth))}><Pencil className="size-ui-4" /></Button>
                    <Button variant="ghost" size="icon" className="text-accent-red" aria-label={`Delete ${auth.name}`} onClick={() => onConfigChange({ ...config, auth: config.auth.filter((entry) => entry.id !== auth.id) })}><Trash2 className="size-ui-4" /></Button>
                  </div>
                ))}
                {!config.auth.length && !editingAuth ? <p className="rounded-ui-lg border border-dashed border-border-subtle p-ui-5 text-center text-ui-sm text-content-tertiary">No shared authentication profiles.</p> : null}
              </div>
            </div>
          ) : (
            <div className="space-y-ui-4">
              <div>
                <h2 className="m-ui-0 text-ui-md font-medium text-content-primary">Integrations</h2>
                <p className="mb-ui-0 mt-ui-1 text-ui-xs text-content-tertiary">Integration settings are preserved even when their provider is unavailable in this build. Credential values remain in secure storage.</p>
              </div>
              <div className="space-y-ui-2">
                {integrations.map((integration) => (
                  <div key={integration.id} className="rounded-ui-lg border border-border-subtle bg-purr-codefield px-ui-3 py-ui-3">
                    <div className="flex items-center gap-ui-3">
                      <Checkbox checked={integration.enabled} hideLabel label={`Enable ${integration.name}`} onCheckedChange={(enabled) => onIntegrationChange(integration.id, { enabled })} />
                      <div className="min-w-0 flex-1">
                        <p className="m-ui-0 truncate text-ui-sm font-medium text-content-primary">{integration.name}</p>
                        <p className="m-ui-0 truncate font-code text-ui-xs text-content-tertiary">{integration.provider} · config v{integration.configVersion} · {Object.keys(integration.credentials).length} credential slots</p>
                      </div>
                      <span className="flex shrink-0 items-center gap-ui-1 rounded-ui-md bg-purr-elevated px-ui-2 py-ui-1 text-ui-xs text-content-tertiary"><Unplug className="size-ui-3" />Provider unavailable</span>
                      {confirmDeleteIntegration !== integration.id
                        ? <Button variant="ghost" size="icon" className="text-accent-red" aria-label={`Delete ${integration.name}`} onClick={() => setConfirmDeleteIntegration(integration.id)}><Trash2 className="size-ui-4" /></Button>
                        : null}
                    </div>
                    {confirmDeleteIntegration === integration.id ? <div className="mt-ui-3 flex items-center justify-end gap-ui-2 border-t border-border-subtle pt-ui-3">
                      <span className="mr-auto text-ui-xs text-accent-red">Delete this integration configuration?</span>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteIntegration(null)}>Cancel</Button>
                      <Button variant="secondary" size="sm" className="text-accent-red" onClick={() => { onIntegrationDelete(integration.id); setConfirmDeleteIntegration(null); }}>Delete permanently</Button>
                    </div> : null}
                  </div>
                ))}
                {!integrations.length ? <p className="rounded-ui-lg border border-dashed border-border-subtle p-ui-5 text-center text-ui-sm text-content-tertiary">No integrations are configured for this workspace.</p> : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
