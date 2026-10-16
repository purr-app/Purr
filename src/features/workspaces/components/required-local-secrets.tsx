import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../../../domain/project";
import type { SecretInspection, SecureStore } from "../../../application/ports/credentials";
import type { ProtectedState } from "../../../application/ports/persistence";
import { buildSecretInventory, type SecretInventoryItem } from "../../../application/secret-inventory";
import { secretProtectionScope } from "../../../storage/secrets";
import type { Variable, Workspace } from "../model/workspace";
import { protectedStorageMessage } from "../model/protected-storage-message";
import { Button } from "../../../shared/components/ui/button";
import { FormField } from "../../../shared/components/ui/form-field";
import { Modal } from "../../../shared/components/ui/modal";
import { SettingsRow } from "../../../shared/components/ui/settings-section";
import { Input } from "../../../shared/components/ui/input";
import { SelectField } from "../../../shared/components/ui/select-field";
import { Eye, EyeOff, ExternalLink, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";

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
  onCreateSecret: (name: string, value: string) => Promise<void>;
};

function statusLabel(item: SecretInventoryItem, status?: SecretInspection) {
  if (item.declaration === "external-provider") return "External provider unavailable";
  if (item.declaration === "unsaved-value") return "Save owner first";
  if (item.declaration === "missing-variable") return "Variable not defined";
  if (!status) return "Checking…";
  return status.status === "available" ? status.empty ? "Empty saved value" : "Saved value"
    : status.status === "missing" ? "Missing locally" : status.status === "corrupt" ? "Cannot read value"
      : status.status === "denied" ? "Access denied" : status.status === "locked" ? "Locked" : "Unavailable";
}
function displayName(item: SecretInventoryItem) {
  const owner = item.usages[0];
  if (owner.field === "Variable") return owner.ownerLabel.split(" / ").slice(-1)[0] || "Variable";
  return owner.field.replace(/\s*\[[^\]]+\]$/, "");
}

export function RequiredLocalSecrets({ workspace, project, globalVariables, secure, migrationRequired, protectedState, runtimeProtectedState, onOpenOwner, onSetValue, onRetry, onCreateSecret }: RequiredLocalSecretsProps) {
  const inventory = useMemo(() => buildSecretInventory({ workspace, project, globalVariables }), [workspace, project, globalVariables]);
  const refs = useMemo(() => [...new Set(inventory.items.flatMap((item) => item.ref ? [item.ref] : []))], [inventory]);
  const [statuses, setStatuses] = useState<Record<string, SecretInspection>>({});
  const inspectionEpoch = useRef(0);
  const [refresh, setRefresh] = useState(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "variables" | "request" | "other">("all");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const duplicateName = workspace.variables.some((variable) => variable.name.trim() === newName.trim());
  const saved = refs.filter((ref) => statuses[ref]?.status === "available" && !statuses[ref].empty).length;
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealedValue, setRevealedValue] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const available = protectedState.status === "available";
  useEffect(() => {
    let current = true;
    const epoch = ++inspectionEpoch.current;
    if (available && refs.length) void secure.inspect(refs).then((items) => {
      if (current && epoch === inspectionEpoch.current) setStatuses(Object.fromEntries(items.map((item) => [item.ref, item])));
    }).catch(() => { if (current && epoch === inspectionEpoch.current) setError("Could not inspect local secrets. Refresh status to retry."); });
    return () => { current = false; };
  }, [secure, refs, refresh, available, open]);
  const missing = inventory.items.filter((item) => item.ref ? available && statuses[item.ref]?.status === "missing" : Boolean(item.declaration)).length;
  const unavailable = !available ? refs.length : inventory.items.filter((item) => item.ref && statuses[item.ref] && !["available", "missing"].includes(statuses[item.ref].status)).length;
  const checked = refs.filter((ref) => statuses[ref]).length;
  const recoveryState = available ? runtimeProtectedState ?? protectedState : protectedState;
  const needsRetry = recoveryState.status !== "available" || unavailable > 0;
  const itemKind = (item: SecretInventoryItem) => item.usages.some((usage) => usage.field === "Variable") ? "variables"
    : item.usages.some((usage) => workspace.documents.some((document) => document.id === usage.ownerId)
      || usage.ownerId === workspace.id || workspace.requestConfig.auth.some((profile) => profile.id === usage.ownerId)) ? "request" : "other";
  const filtered = inventory.items.filter((item) => (kind === "all" || itemKind(item) === kind) && `${item.usages.map((usage) => `${usage.ownerLabel} ${usage.field}`).join(" ")} ${item.ref ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const closeManager = () => {
    if (busy) return;
    setOpen(false); setCreating(false); setNewName(""); setNewValue(""); setEditing(null); setRevealed(null); setRevealedValue(""); setConfirmRemove(null); setValue(""); setError(""); setNotice("");
  };
  const create = async () => {
    if (!newName.trim() || !newValue || duplicateName || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await onCreateSecret(newName.trim(), newValue);
      setCreating(false); setNewName(""); setNewValue(""); setQuery(""); setKind("all");
      setRefresh((current) => current + 1);
      setNotice("Workspace secret saved.");
    } catch { setError("Could not create this secret. Your entry is preserved; try again."); }
    finally { setBusy(false); }
  };
  const retry = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      if (needsRetry) {
        const state = await onRetry();
        if (state.status !== "available") { setError(`${protectedStorageMessage(state)} Existing local values were preserved.`); return; }
      }
      ++inspectionEpoch.current;
      const items = await secure.inspect(refs);
      setStatuses(Object.fromEntries(items.map((item) => [item.ref, item])));
      setRefresh((current) => current + 1);
      setNotice("Secret statuses refreshed.");
    } catch { setError("Protected storage is unavailable. Existing values were preserved."); }
    finally { setBusy(false); }
  };
  const commit = async (item: SecretInventoryItem, next: string | null) => {
    if (!item.ref) return;
    if (next === "") { setError("Enter a value, or remove the saved value to leave this secret missing."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      await onSetValue(item.ref, next);
      ++inspectionEpoch.current;
      const [status] = await secure.inspect([item.ref]);
      setStatuses((current) => ({ ...current, [item.ref!]: status }));
      setRefresh((current) => current + 1);
      setEditing(null); setRevealed(null); setRevealedValue(""); setConfirmRemove(null); setValue("");
      setNotice(next === null ? "Local value removed. Declaration preserved." : "Local value saved.");
    } catch { setError("Could not save this value. Your entry is preserved; retry or open its owner."); }
    finally { setBusy(false); }
  };
  const reveal = async (item: SecretInventoryItem) => {
    if (!item.ref) return;
    if (revealed === item.key) { setRevealed(null); setRevealedValue(""); return; }
    setRevealed(null); setRevealedValue("");
    setBusy(true); setError("");
    try {
      const result = await secure.resolve(item.ref);
      if (result.status !== "available") { setError(`Local secret is ${result.status}. Refresh status or restore it.`); return; }
      setRevealedValue(result.value); setRevealed(item.key);
    } catch { setError("Could not read this secret. Existing value was preserved."); }
    finally { setBusy(false); }
  };
  return <>
    <SettingsRow label="Local secrets" description={`${inventory.items.length} references · ${missing} missing · ${unavailable} unavailable${checked < refs.length ? ` · ${refs.length - checked} checking` : ""}`}>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>Manage secrets</Button>
    </SettingsRow>
    {open ? <Modal title="Manage local secrets" onClose={closeManager} className="ui-scroll-dialog" surface="layered"
      footer={<div className="flex items-center justify-between gap-ui-3"><span className="text-ui-xs text-content-secondary">{saved} saved · AES-256-GCM</span><Button type="button" variant="brand" className="px-ui-5" disabled={busy} onClick={closeManager}>Done</Button></div>}>
      <div className="space-y-ui-3 overflow-auto p-ui-5">
        <div className="flex items-start gap-ui-3 rounded-ui-md bg-purr-elevated p-ui-3"><ShieldCheck className="mt-ui-1 size-ui-4 shrink-0 text-content-secondary" /><p className="m-ui-0 text-ui-sm text-content-secondary">Secret values stay in this device’s encrypted vault. Use the pencil to replace a value or the eye to reveal it.</p></div>
        {!available ? <p role="status" className="text-ui-sm text-content-secondary">{protectedStorageMessage(protectedState)}</p> : null}
        {migrationRequired ? <p role="status" className="text-ui-sm text-content-secondary">This workspace uses the older format. Upgrade it after saving any legacy values.</p> : null}
        <div className="flex flex-wrap items-end gap-ui-3">
          <div className="min-w-0 flex-1"><FormField label="Find local secrets" placeholder="Search secret names…" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <SelectField size="lg" label="Secret type" value={kind} onValueChange={setKind} options={[{ value: "all", label: "All types" }, { value: "variables", label: "Variables" }, { value: "request", label: "Request values" }, { value: "other", label: "Other values" }]} />
          <div className="flex h-control-lg items-center"><Button type="button" variant="brand" disabled={!available || busy || creating} onClick={() => { setCreating(true); setEditing(null); setValue(""); setRevealed(null); setRevealedValue(""); setConfirmRemove(null); setError(""); }}><Plus className="size-ui-4" />New secret</Button></div>
          {needsRetry ? <Button type="button" variant="secondary" disabled={busy} onClick={() => void retry()}>{busy ? "Checking…" : "Retry / Unlock"}</Button> : null}
        </div>
        {creating ? <form className="space-y-ui-3 rounded-ui-md bg-purr-codefield p-ui-3" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <p className="m-ui-0 text-ui-sm text-content-secondary">Add a secret variable to this workspace.</p>
          <div className="grid grid-cols-2 gap-ui-3"><FormField label="Secret name" value={newName} onChange={(event) => setNewName(event.target.value)} autoFocus disabled={busy} /><FormField label="New secret value" secret value={newValue} onChange={(event) => setNewValue(event.target.value)} disabled={busy} /></div>
          {duplicateName ? <p role="alert" className="m-ui-0 text-ui-xs text-accent-red">A workspace variable with this name already exists.</p> : null}
          <div className="flex justify-end gap-ui-2"><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setCreating(false); setNewName(""); setNewValue(""); setError(""); }}>Cancel</Button><Button type="submit" variant="brand" size="sm" disabled={busy || !newName.trim() || !newValue || duplicateName}>Save secret</Button></div>
        </form> : null}
        {error ? <p role="alert" className="text-ui-sm text-accent-red">{error}</p> : null}
        {notice ? <p role="status" className="text-ui-sm text-content-secondary">{notice}</p> : null}
        {!inventory.items.length ? <p className="text-ui-sm text-content-secondary">No local secret references are declared.</p> : null}
        {inventory.items.length && !filtered.length ? <p className="text-ui-sm text-content-secondary">No secrets match this search.</p> : null}
        <div className="space-y-ui-2 rounded-ui-md bg-purr-codefield p-ui-3">
          <div className="flex items-center gap-ui-2 pb-ui-1 text-ui-xs text-content-secondary"><span className="min-w-0 flex-1">Secret name</span><span className="min-w-0 flex-1">Value</span><span className="relative flex h-ui-4 shrink-0 gap-ui-2"><span className="absolute inset-0 text-right">Actions</span>{[0, 1, 2, 3].map((slot) => <span key={slot} className="w-control-sm" />)}</span></div>
          {filtered.map((item) => {
          const owner = item.usages[0];
          const status = item.ref ? statuses[item.ref] : undefined;
          let scoped = false;
          if (item.ref) try { secretProtectionScope(item.ref); scoped = true; } catch { /* Legacy reference. */ }
          const canEdit = available && scoped && (!status || ["available", "missing"].includes(status.status)) && !busy;
          return <div key={item.key}>
            {confirmRemove === item.key ? <div className="flex h-control-sm items-center justify-between gap-ui-3">
              <span className="min-w-0 truncate text-ui-sm text-content-secondary" title={`Remove local value for “${displayName(item)}”?`}>Remove local value for “{displayName(item)}”?</span>
              <div className="flex shrink-0 items-center gap-ui-2"><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmRemove(null)}>Cancel</Button><Button type="button" variant="secondary" className="border-accent-red text-accent-red hover:text-accent-red" size="sm" disabled={busy} onClick={() => void commit(item, null)}>Confirm remove</Button></div>
            </div> : <div className="flex h-control-sm items-center gap-ui-2">
              <Input aria-label={`Secret name ${displayName(item)}`} className="h-control-sm min-w-0 flex-1 font-code text-ui-sm" value={displayName(item)} disabled />
              <Input key={`${item.key}-${editing === item.key ? "edit" : "view"}`} aria-label={`Secret value ${displayName(item)}`} className="h-control-sm min-w-0 flex-1 font-code text-ui-sm" type={revealed === item.key ? "text" : "password"}
                disabled={editing !== item.key || !canEdit} autoComplete="off" autoFocus={editing === item.key}
                value={editing === item.key ? value : revealed === item.key ? revealedValue : status?.status === "available" && !status.empty ? "••••••••" : ""}
                placeholder={editing === item.key ? "Enter replacement value…" : available ? statusLabel(item, status) : `Storage ${protectedState.status}`}
                onChange={(event) => setValue(event.target.value)} />
              <Button type="button" variant="ghost" size="icon" aria-label={`Edit ${displayName(item)}`} disabled={!canEdit || editing === item.key} onClick={() => { setCreating(false); setNewName(""); setNewValue(""); setEditing(item.key); setValue(""); setRevealed(null); setRevealedValue(""); setConfirmRemove(null); setError(""); }}><Pencil className="size-ui-4" /></Button>
              <Button type="button" variant="ghost" size="icon" aria-label={`${revealed === item.key ? "Hide" : "Reveal"} ${displayName(item)}`} disabled={!canEdit || status?.status !== "available" || editing !== null} onClick={() => void reveal(item)}>{revealed === item.key ? <EyeOff className="size-ui-4" /> : <Eye className="size-ui-4" />}</Button>
              <Button type="button" variant="ghost" size="icon" aria-label={`Open owner of ${displayName(item)}`} onClick={() => { closeManager(); onOpenOwner(owner.ownerId, owner.environmentId, owner.field); }}><ExternalLink className="size-ui-4" /></Button>
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${displayName(item)}`} disabled={!canEdit || !item.ref || status?.status !== "available"} onClick={() => { setEditing(null); setValue(""); setRevealed(null); setRevealedValue(""); setConfirmRemove(item.key); }}><Trash2 className="size-ui-4" /></Button>
            </div>}
            {editing === item.key ? <div className="mt-ui-2 flex justify-end gap-ui-2"><Button type="button" variant="ghost" size="sm" onClick={() => { setEditing(null); setRevealed(null); setRevealedValue(""); setValue(""); }}>Cancel</Button><Button type="button" variant="brand" size="sm" disabled={!canEdit || !value} onClick={() => void commit(item, value)}>Save value</Button></div> : null}

            {!scoped && item.ref ? <p className="mb-ui-0 mt-ui-1 text-ui-xs text-content-secondary">Open this field to update an older secret reference.</p> : null}
          </div>;
        })}</div>
      </div>
    </Modal> : null}
  </>;
}
