import { secretProtectionScope } from "../../../storage/secrets";
import { protectedStorageMessage } from "../model/protected-storage-message";
import { useEffect, useMemo, useState } from "react";
import type { Project } from "../../../domain/project";
import type { SecureStore } from "../../../application/ports/credentials";
import type { ProtectedState } from "../../../application/ports/persistence";
import { buildSecretInventory, resolveSecretInventory, type SecretInventoryItem } from "../../../application/secret-inventory";
import type { Variable, Workspace } from "../model/workspace";
import { Button } from "../../../shared/components/ui/button";
import { FormField } from "../../../shared/components/ui/form-field";

export type RequiredLocalSecretsProps = {
  workspace: Workspace;
  project?: Project;
  globalVariables: readonly Variable[];
  secure: SecureStore;
  migrationRequired: boolean;
  protectedState: ProtectedState;
  runtimeProtectedState?: ProtectedState;
  onOpenOwner: (ownerId: string, environmentId?: string, field?: string) => void;
  onSetValue: (ref: string, value: string | null) => Promise<void>;
  onRetry: () => Promise<ProtectedState>;
};
const statusLabel = (item: SecretInventoryItem) => item.declaration === "external-provider" ? "External provider unavailable"
  : item.declaration === "unsaved-value" ? "Save the owner to create its local reference"
    : item.declaration === "missing-variable" ? "Variable not defined or disabled"
      : ({ available: "Available locally", missing: "Missing locally", locked: "Locked", unavailable: "Unavailable", corrupt: "Cannot read protected value", denied: "Access denied", unchecked: "Checking…" })[item.status.status];

export function RequiredLocalSecrets({ workspace, project, globalVariables, secure, migrationRequired, protectedState, runtimeProtectedState, onOpenOwner, onSetValue, onRetry }: RequiredLocalSecretsProps) {
  const input = useMemo(() => ({ workspace, project, globalVariables }), [workspace, project, globalVariables]);
  const base = useMemo(() => buildSecretInventory(input), [input]);
  const [resolved, setResolved] = useState<{ input: typeof input; inventory: typeof base } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const available = protectedState.status === "available";
  useEffect(() => {
    let current = true;
    if (available) void resolveSecretInventory(input, secure).then((inventory) => { if (current) setResolved({ input, inventory }); })
      .catch(() => { if (current) setError("Could not inspect the current secret declarations. Retry or open their owners."); });
    return () => { current = false; };
  }, [input, secure, refresh, available]);
  const inventory = resolved?.input === input && available ? resolved.inventory : base;
  const recoveryState = available ? runtimeProtectedState ?? protectedState : protectedState;
  const needsRetry = recoveryState.status !== "available" || inventory.items.some((item) => ["locked", "denied", "unavailable", "corrupt"].includes(item.status.status));
  const omitted = inventory.items.filter((item) => item.ref).length;
  const missing = inventory.items.filter((item) => item.status.status !== "available" && item.status.status !== "unchecked").length;
  const pending = inventory.items.filter((item) => item.status.status === "unchecked").length;
  const commit = async (item: SecretInventoryItem, next: string | null) => {
    if (!item.ref) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await onSetValue(item.ref, next);
      setEditing(null); setValue(""); setResolved(null); setRefresh((current) => current + 1);
      setNotice(next === null ? "Local value removed. Its declaration is preserved." : "Local value saved.");
    } catch { setError("Could not change this local value. Your entry is preserved; retry or open its owner."); }
    finally { setBusy(false); }
  };
  return <section aria-label="Required local secrets" className="space-y-ui-4 font-ui">
    <div className="flex items-start justify-between gap-ui-3">
      <div><h3 className="m-ui-0 text-ui-md font-medium text-content-primary">Required local secrets</h3>
        <p className="mb-ui-0 mt-ui-2 text-ui-sm text-content-secondary">References describe what a workspace needs. Values stay on this device. Existing values are never filled into this panel.</p></div>
      {needsRetry || inventory.items.length || error ? <Button type="button" variant={needsRetry ? "brand" : "secondary"} size="sm" disabled={busy} onClick={async () => {
        setBusy(true); setError(""); setNotice(""); setEditing(null); setValue("");
        try {
          if (needsRetry) {
            const state = await onRetry();
            if (state.status !== "available") { setError(`${protectedStorageMessage(state)} Existing local values have been preserved.`); return; }
          }
          const checked = await resolveSecretInventory(input, secure);
          setResolved({ input, inventory: checked });
          const inaccessible = checked.items.some((item) => ["locked", "denied", "unavailable", "corrupt"].includes(item.status.status));
          setNotice(inaccessible ? "Access rechecked. Some secret values remain unavailable; see their status below."
            : needsRetry ? "Protected storage access restored. Secret statuses refreshed." : "Secret statuses refreshed.");
        }
        catch { setError("Protected storage is still unavailable. Existing local values have been preserved."); }
        finally { setBusy(false); }
      }}>{busy ? "Checking…" : needsRetry ? "Retry / Unlock" : "Refresh status"}</Button> : null}
    </div>
    {!available ? <p role="status" className="rounded-ui-lg border border-border-subtle bg-purr-elevated p-ui-3 text-ui-sm text-content-secondary">{protectedStorageMessage(protectedState)} Editing is disabled until the stored baseline can be read. Public definitions remain available.</p> : null}
    {available && recoveryState.status !== "available" ? <p role="status" className="rounded-ui-lg border border-border-subtle bg-purr-elevated p-ui-3 text-ui-sm text-content-secondary">{protectedStorageMessage(recoveryState)} Protected response storage is unavailable until access is restored.</p> : null}
    {migrationRequired ? <p role="status" className="rounded-ui-lg border border-border-subtle bg-purr-elevated p-ui-3 text-ui-sm text-content-secondary">This workspace still uses format v1. Known legacy credential literals may remain in its public files until an explicit Save or Upgrade succeeds. Updating current files does not remove previous Git history or copies.</p> : null}
    <div className="rounded-ui-lg border border-border-subtle bg-purr-elevated p-ui-3 text-ui-sm text-content-secondary">
      <p className="m-ui-0 font-medium text-content-primary">Configuration sharing preview</p>
      <p className="mb-ui-0 mt-ui-2">{inventory.publicValueCount} public credential, header and static-variable values included · {omitted} referenced secret values omitted · {available ? missing : inventory.items.length} missing or unavailable declarations{available && pending ? ` · ${pending} checking` : ""}.</p>
      <p className="mb-ui-0 mt-ui-2">Public definitions and assets remain shareable. References and declarations are preserved. Global dependencies are identified and are not included in workspace files. Dependencies inside unavailable values can be checked after restoration. No archive is created here.</p>
    </div>
    {error ? <p role="alert" className="text-ui-sm text-accent-red">{error}</p> : null}
    {notice ? <p role="status" className="text-ui-sm text-content-secondary">{notice}</p> : null}
    {!inventory.items.length ? <p className="text-ui-sm text-content-tertiary">No local secret references are declared in the current definitions or working copies.</p> : <ul className="m-ui-0 list-none space-y-ui-3 p-ui-0">
      {inventory.items.map((item) => {
        const owner = item.usages[0];
        let scoped = false;
        if (item.ref) try { secretProtectionScope(item.ref); scoped = true; } catch { /* Old project refs require an owner edit to publish a scoped identity. */ }
        const canEdit = available && scoped && ["available", "missing"].includes(item.status.status) && !busy;
        const open = editing === item.key && canEdit;
        return <li key={item.key} className="space-y-ui-3 rounded-ui-lg border border-border-subtle p-ui-3">
          <div className="flex flex-wrap items-start justify-between gap-ui-3">
            <div className="min-w-0"><p className="m-ui-0 text-ui-sm font-medium text-content-primary">{owner.ownerLabel}</p>
              <p className="mb-ui-0 mt-ui-1 text-ui-xs text-content-secondary">{available ? statusLabel(item) : `Storage ${protectedState.status}`}{!item.usages.some((usage) => usage.enabled) ? " · Disabled" : ""}{item.ref?.startsWith("purr/global/") ? " · Global dependency" : ""}</p>
              {item.ref ? <p className="mb-ui-0 mt-ui-1 break-all font-code text-ui-xs text-content-tertiary">{item.ref}</p> : null}</div>
            <div className="flex flex-wrap gap-ui-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => onOpenOwner(owner.ownerId, owner.environmentId, owner.field)}>Open owner</Button>
              {item.ref ? <Button type="button" variant="brand" size="sm" disabled={!canEdit} aria-label={`Set value for ${owner.ownerLabel}`} onClick={() => { setEditing(item.key); setValue(""); setError(""); setNotice(""); }}>Set value</Button> : null}
              {item.ref ? <Button type="button" variant="ghost" size="sm" disabled={!canEdit || item.status.status !== "available"} aria-label={`Remove local value for ${owner.ownerLabel}`} onClick={() => void commit(item, null)}>Remove local value</Button> : null}
            </div>
          </div>
          {item.ref && !scoped ? <p className="m-ui-0 text-ui-xs text-content-secondary">This reference belongs to an older storage format. Choose Open owner, enter the value in its field, then save to create a new local secret.</p> : null}
          <ul className="m-ui-0 list-none space-y-ui-1 p-ui-0 text-ui-xs text-content-tertiary">{item.usages.map((usage, index) => <li key={`${usage.ownerId}:${usage.field}:${usage.environmentId}:${index}`}>{usage.ownerLabel} · {usage.field}{usage.environmentLabel ? ` · ${usage.environmentLabel}` : ""}{!usage.enabled ? " · Disabled" : ""}</li>)}</ul>
          {open ? <form className="space-y-ui-3" onSubmit={(event) => { event.preventDefault(); void commit(item, value); }}>
            <FormField secret label={`New local value for ${owner.ownerLabel}`} value={value} onChange={(event) => setValue(event.target.value)} hint="An empty value is valid. Saving an empty value does not remove it." />
            <div className="flex gap-ui-2"><Button type="submit" variant="brand" size="sm" disabled={!canEdit}>Save local value</Button><Button type="button" variant="secondary" size="sm" onClick={() => { setEditing(null); setValue(""); }}>Cancel</Button></div>
          </form> : null}
        </li>;
      })}
    </ul>}
  </section>;
}
