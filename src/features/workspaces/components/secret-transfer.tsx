import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, ListChecks, ShieldCheck, KeyRound, FileKey } from "lucide-react";
import { useApplicationServices } from "../../../app/application-services-context";
import { SecretTransferError, validTransferPassword, type SecretTransferInventory, type SecretTransferPreview, type SelectedRecoveryPackages } from "../../../application/ports/secret-transfer";
import { Button } from "../../../shared/components/ui/button";
import { Checkbox } from "../../../shared/components/ui/checkbox";
import { FormField } from "../../../shared/components/ui/form-field";
import { Modal } from "../../../shared/components/ui/modal";
import { SettingsRow } from "../../../shared/components/ui/settings-section";

type Mode = "export" | "import" | "key" | "backup" | "recover";
const titles: Record<Mode, string> = {
  export: "Export selected secrets", import: "Import secrets", key: "Export recovery key",
  backup: "Export credential backup", recover: "Recover secrets",
};
const description = "Share saved workspace secrets in a password-protected .purrsecrets file. Unsaved values, globals, cookies, OAuth sessions and history stay on this device.";
function transferFailureMessage(error: unknown): string | undefined {
  if (!(error instanceof SecretTransferError)) return;
  const messages = {
    "recovery-files-invalid": "Choose one recovery-key file and its matching credential-backup file. A selected-secret package belongs in Import secrets.",
    "recovery-key-unlock-failed": "Could not unlock the recovery key. Its password is incorrect or the file is damaged.",
    "recovery-backup-unlock-failed": "Could not unlock the credential backup. Its password is incorrect or the file is damaged.",
    "recovery-workspace-mismatch": "These recovery files belong to another workspace. Import the matching workspace folder first.",
    "recovery-key-mismatch": "The recovery key does not match this credential backup. Choose the key exported for this backup.",
    "recovery-payload-invalid": "These recovery files contain invalid or unsupported data. Choose an intact matching backup.",
    "transfer-selection-expired": "The file selection has expired. Choose the files again.",
    "transfer-file-kind-invalid": "This is not a selected-secret package. Recovery keys and credential backups must be opened through Recovery.",
    "transfer-authentication-failed": "Could not unlock this package. Its password is incorrect or the file is damaged.",
  };
  return `${messages[error.code]} No values were imported.`;
}

function exportPasswordError(password: string, confirmation: string) {
  if (!password) return "Enter a package password.";
  if (Array.from(password).length < 12) return "Use at least 12 characters.";
  if (new TextEncoder().encode(password).byteLength > 1024) return "Password exceeds 1024 UTF-8 bytes.";
  if (!confirmation) return "Confirm the package password.";
  if (password !== confirmation) return "Passwords do not match.";
  return "";
}
function secretName(owners: readonly string[], fallback: string) {
  const name = owners[0]?.replace(/^.*?\s\/\s/, "").replace(/\s*\[[^\]]+\]$/, "").trim();
  return name || fallback;
}

/** Incoming values are revealed individually on demand and discarded when the preview closes. */
export function SecretTransfer({ workspaceId, onImported, onBeforeTransfer }: { workspaceId: string; onImported: (references: readonly string[]) => void; onBeforeTransfer: () => Promise<void> }) {
  const { secretTransfer: transfer, workspaceShell } = useApplicationServices();
  const [mode, setMode] = useState<Mode | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [notice, setNotice] = useState("");
  return <section aria-label="Secret transfer and recovery" className="divide-y divide-border-subtle">
    <SettingsRow label="Export secrets" description="Create a password-protected package of selected saved secrets.">
      <Button variant="secondary" disabled={!transfer.available} onClick={() => { setNotice(""); setMode("export"); }}>Export secrets</Button>
    </SettingsRow>
    <SettingsRow label="Import secrets" description="Restore selected values to a copy of this workspace.">
      <Button variant="secondary" disabled={!transfer.available} onClick={() => { setNotice(""); setMode("import"); }}>Import secrets</Button>
    </SettingsRow>
    <SettingsRow label="Recovery" description="Keep a recovery key and a matching credential backup.">
      <Button variant="secondary" disabled={!transfer.available} onClick={() => { setNotice(""); setRecoveryOpen(true); }}>Recovery options</Button>
    </SettingsRow>
    {!transfer.available ? <p role="status" className="text-ui-sm text-content-secondary">Secret transfer and recovery require the Purr desktop app.</p> : null}
    {notice ? <p role="status" className="text-ui-sm text-content-secondary">{notice}</p> : null}
    {recoveryOpen ? <Modal title="Recovery" surface="layered" initialFocus="dialog" onClose={() => setRecoveryOpen(false)}><div className="flex flex-col gap-ui-5 p-ui-5">
      <div className="flex flex-col gap-ui-3 text-ui-sm text-content-secondary">
        <p className="m-ui-0">Recovery restores secrets if this device or its OS keychain is lost.</p>
        <p className="m-ui-0">Keep both the recovery key and credential backup, with their passwords, outside this device. Update the backup after changing secrets.</p>
        <p className="m-ui-0">Moving to another device? Use Export secrets and Import secrets.</p>
        <a href="https://usepurr.com/docs/" className="ui-focus-ring self-start rounded-ui-sm text-action-brand underline" onClick={(event) => { event.preventDefault(); void workspaceShell.openExternalUrl("https://usepurr.com/docs/").catch(() => setNotice("Could not open documentation. Visit https://usepurr.com/docs/ in your browser.")); }}>Purr documentation</a>
      </div>
      <div className="flex w-full justify-between gap-ui-3">{(["key", "backup", "recover"] as const).map((action) => <Button key={action} variant="secondary" className="min-w-0 flex-1" onClick={() => { setRecoveryOpen(false); setMode(action); }}>{titles[action]}</Button>)}</div>
    </div></Modal> : null}
    {mode ? <TransferDialog key={`${workspaceId}:${mode}`} workspaceId={workspaceId} mode={mode} onImported={onImported} onBeforeTransfer={onBeforeTransfer} onClose={() => { setMode(null); if (["key", "backup", "recover"].includes(mode)) setRecoveryOpen(true); }} onNotice={setNotice} /> : null}
  </section>;
}

export function WorkspaceExport({ workspaceId, onBeforeTransfer }: { workspaceId: string; onBeforeTransfer: () => Promise<void> }) {
  const { secretTransfer } = useApplicationServices();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), [workspaceId]);
  const exportWorkspace = async () => {
    if (controller.current) return;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setNotice("");
    try {
      await onBeforeTransfer(); abort.signal.throwIfAborted();
      const result = await secretTransfer.exportConfiguration(workspaceId, abort.signal);
      if (!abort.signal.aborted) setNotice(result.status === "written" ? "Export workspace completed." : "Export cancelled.");
    } catch { if (!abort.signal.aborted) setNotice("Could not export workspace. Check the destination and try again."); }
    finally { if (controller.current === abort) { controller.current = null; setBusy(false); } }
  };
  return <section className="space-y-ui-2">
    <SettingsRow label="Export workspace" description="Copy saved YAML and assets to an empty folder for sharing or Git. Secret values, drafts and session state are excluded; secret references and workspace identity are preserved.">
      <Button variant="secondary" disabled={!secretTransfer.available || busy} onClick={() => void exportWorkspace()}>{busy ? "Exporting…" : "Export workspace"}</Button>
    </SettingsRow>
    {notice ? <p role="status" className="text-ui-sm text-content-secondary">{notice}</p> : null}
  </section>;
}

function TransferDialog({ workspaceId, mode, onImported, onBeforeTransfer, onClose, onNotice }: {
  workspaceId: string; mode: Mode; onImported: (references: readonly string[]) => void; onBeforeTransfer: () => Promise<void>; onClose: () => void; onNotice: (message: string) => void;
}) {
  const { secretTransfer: transfer, persistence } = useApplicationServices();
  const [inventory, setInventory] = useState<SecretTransferInventory | null>(null);
  const [preview, setPreview] = useState<SecretTransferPreview | null>(null);
  const [staged, setStaged] = useState<{ id: string; name: string } | null>(null);
  const [recoveryFiles, setRecoveryFiles] = useState<SelectedRecoveryPackages | null>(null);
  const stagedRef = useRef<string | null>(null);
  const previewRef = useRef<string | null>(null);
  const beforeTransfer = useRef(onBeforeTransfer);
  beforeTransfer.current = onBeforeTransfer;
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(mode === "export");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [backupPassword, setBackupPassword] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [omitted, setOmitted] = useState<string[]>([]);
  const [pending, setPending] = useState<{ id: string; references: string[] } | null>(null);
  const [expired, setExpired] = useState(false);
  const [revealed, setRevealed] = useState<{ ref: string; value: string } | null>(null);
  const revealEpoch = useRef(0);
  const exporting = mode === "export" || mode === "key" || mode === "backup";
  const clearPasswords = () => { setPassword(""); setConfirmation(""); setBackupPassword(""); };
  const close = () => {
    if (pending) return;
    if (busy) { if (!preview) controller.current?.abort(); return; }
    if (stagedRef.current) void transfer.cancel(stagedRef.current).catch(() => {});
    clearPasswords(); onClose();
  };
  useEffect(() => {
    mounted.current = true;
    if (mode === "export") {
      void beforeTransfer.current().then(() => transfer.inventory(workspaceId)).then((value) => { if (mounted.current) { setInventory(value); setSelected(value.items.filter((item) => item.status === "available").map((item) => item.ref)); } })
        .catch(() => { if (mounted.current) setError("Could not inspect saved declarations. Close this dialog and retry."); })
        .finally(() => { if (mounted.current) setLoading(false); });
    }
    return () => {
      mounted.current = false;
      controller.current?.abort();
      if (previewRef.current) void transfer.cancel(previewRef.current).catch(() => {});
      if (stagedRef.current) void transfer.cancel(stagedRef.current).catch(() => {});
    };
  }, [transfer, workspaceId, mode]);
  useEffect(() => {
    if (!preview) return;
    const expire = () => { const stale = Date.now() >= preview.expiresAt; setExpired(stale); if (stale) { ++revealEpoch.current; setRevealed(null); } };
    expire(); const timer = window.setTimeout(expire, Math.max(0, preview.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [preview]);
  const toggle = (reference: string, value: boolean) => setSelected((current) => value ? [...current.filter((ref) => ref !== reference), reference] : current.filter((ref) => ref !== reference));
  const committed = (references: string[]) => {
    previewRef.current = null;
    onImported(references);
    onNotice("Secrets imported. Current device keys were preserved and secret statuses refreshed.");
    onClose();
  };
  const checkOutcome = async () => {
    if (!pending) return;
    setBusy(true); setError("");
    try {
      const result = await transfer.operationStatus(pending.id);
      if (result.status === "committed") committed(pending.references);
      else if (result.status === "aborted" || result.status === "missing") {
        setPending(null); setError("Import was not committed. Close this dialog and prepare a new preview before retrying."); setExpired(true);
      } else { setPending(null); setExpired(true); setError("Import needs recovery. Reload Purr to complete recovery before another import."); }
    } catch { setError("Could not confirm the import outcome. Check again before starting another import."); }
    finally { if (mounted.current) setBusy(false); }
  };
  const submit = async () => {
    ++revealEpoch.current; setRevealed(null);
    setBusy(true); setError("");
    const abort = new AbortController(); controller.current = abort;
    let started = false;
    try {
      if (!preview) { await onBeforeTransfer(); abort.signal.throwIfAborted(); }
      started = true;
      if (preview) {
        const operation = pending ?? { id: crypto.randomUUID(), references: [...selected] };
        setPending(operation);
        try {
          const result = await transfer.commitImport({ workspaceId, previewId: preview.id, operationId: operation.id, references: operation.references });
          if (result.status === "committed") committed(operation.references);
          else if (result.status === "aborted") { setPending(null); setExpired(true); setError("Import was not committed. Prepare a new preview to check current values."); }
          else { setPending(null); setExpired(true); setError("Import needs recovery. Reload Purr to complete recovery before another import."); }
        } catch { setError("Could not confirm the import outcome. Use Check outcome before retrying; the operation ID is preserved."); }
      } else if (mode === "recover" && !recoveryFiles) {
        const result = await transfer.selectRecoveryFiles(workspaceId, abort.signal);
        if (!result) { onNotice("Recovery cancelled. No values were changed."); onClose(); return; }
        if (!mounted.current) { void transfer.cancel(result.id).catch(() => {}); return; }
        stagedRef.current = result.id; setRecoveryFiles(result);
      } else if (mode === "import" && !staged) {
        const result = await transfer.selectImportFile(workspaceId, abort.signal);
        if (!result) { onNotice("Import cancelled. No values were changed."); onClose(); return; }
        if (!mounted.current) { void transfer.cancel(result.id).catch(() => {}); return; }
        stagedRef.current = result.id; setStaged(result);
      } else if (mode === "import" || mode === "recover") {
        const result = mode === "import" ? await transfer.prepareImport({ workspaceId, stagedId: staged!.id, password }, abort.signal) : await transfer.prepareRecovery({ workspaceId, stagedId: recoveryFiles!.id, keyPassword: password, backupPassword }, abort.signal);
        clearPasswords();
        if (!result) { onNotice("Import cancelled. No values were changed."); onClose(); return; }
        if (!mounted.current) { void transfer.cancel(result.id).catch(() => {}); return; }
        stagedRef.current = null; setStaged(null); setRecoveryFiles(null);
        previewRef.current = result.id; setPreview(result);
        setSelected(result.items.filter((item) => item.status === "missing").map((item) => item.ref));
      } else {
        const result = mode === "export" ? await transfer.exportSelected({ workspaceId, references: selected, omittedRefs: omitted, password }, abort.signal)
          : mode === "key" ? await transfer.exportRecoveryKey({ workspaceId, password }, abort.signal)
            : await transfer.exportCredentialBackup({ workspaceId, password }, abort.signal);
        clearPasswords();
        onNotice(result.status === "written" ? `${titles[mode]} completed.` : "Export cancelled."); onClose();
      }
    } catch (error) {
      clearPasswords();
      if (!started && abort.signal.aborted) { onNotice("Transfer cancelled before opening a file."); onClose(); return; }
      const failure = transferFailureMessage(error);
      if (error instanceof SecretTransferError && error.code === "transfer-selection-expired") {
        stagedRef.current = null; setStaged(null); setRecoveryFiles(null);
      }
      setError(failure ?? (mode === "import" && !staged ? "Could not open this package. Check file access and try again. No values were imported."
        : mode === "import" || mode === "recover" ? "Could not prepare this package. Check its password, workspace identity and file integrity. No values were imported."
          : "Export could not finish. Check access to saved credentials and the destination, then retry."));
    } finally { if (mounted.current) setBusy(false); }
  };
  const unavailableSelected = inventory?.items.some((item) => selected.includes(item.ref) && item.status !== "available");
  const availableRefs = inventory?.items.filter((item) => item.status === "available").map((item) => item.ref) ?? [];
  const allAvailableSelected = availableRefs.length > 0 && availableRefs.every((ref) => selected.includes(ref));
  const passwordError = exporting ? exportPasswordError(password, confirmation) : "";
  const visibleItems = inventory?.items.filter((item) => `${item.ref} ${item.owners.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  const importableRefs = preview?.items.filter((item) => item.status !== "unknown").map((item) => item.ref) ?? [];
  const allImportableSelected = importableRefs.length > 0 && importableRefs.every((ref) => selected.includes(ref));
  const revealSaved = async (reference: string) => {
    const epoch = ++revealEpoch.current;
    if (revealed?.ref === reference) { setRevealed(null); return; }
    setRevealed(null);
    try {
      const result = await persistence.secure.resolve(reference);
      if (!mounted.current || epoch !== revealEpoch.current) return;
      if (result.status === "available") setRevealed({ ref: reference, value: result.value });
      else setError(`Cannot reveal this secret: ${result.status}.`);
    } catch { if (mounted.current && epoch === revealEpoch.current) setError("Could not reveal this secret. Close and reopen the dialog to retry."); }
  };
  const revealIncoming = async (reference: string) => {
    const epoch = ++revealEpoch.current;
    if (revealed?.ref === reference) { setRevealed(null); return; }
    setRevealed(null);
    if (!preview || expired || busy || pending) return;
    try {
      const value = await transfer.revealPreviewValue({ workspaceId, previewId: preview.id, reference });
      if (mounted.current && epoch === revealEpoch.current && Date.now() < preview.expiresAt) setRevealed({ ref: reference, value });
    } catch { if (mounted.current && epoch === revealEpoch.current) setError("Could not reveal this value. The preview may have expired; reopen the package to retry."); }
  };
  const canSubmit = !loading && !busy && !pending && (preview ? selected.length > 0 && !expired
    : mode === "import" && !staged || mode === "recover" && !recoveryFiles ? true
      : exporting ? !passwordError && validTransferPassword(password) && (mode !== "export" || Boolean(inventory && selected.length && !unavailableSelected))
        : password.length > 0 && new TextEncoder().encode(password).byteLength <= 1024 && (mode !== "recover" || backupPassword.length > 0 && new TextEncoder().encode(backupPassword).byteLength <= 1024));
  return <Modal title={preview ? "Review secret import" : titles[mode]} onClose={close} surface="layered" className="ui-scroll-dialog" footer={
      <div className="flex items-center justify-between gap-ui-3">
        <Button variant="ghost" disabled={Boolean(pending) || busy && Boolean(preview)} onClick={close}>{pending ? "Close" : "Cancel"}</Button>
        {pending ? <Button variant="brand" disabled={busy} onClick={() => void checkOutcome()}>Check outcome</Button>
          : <Button variant="brand" disabled={!canSubmit} onClick={() => void submit()}>{busy ? "Working…" : preview ? "Import selected values" : mode === "import" ? staged ? "Preview secrets" : "Choose package" : mode === "recover" ? recoveryFiles ? "Preview secrets" : "Choose recovery files" : "Choose export file"}</Button>}
      </div>
    }>
    <div className="flex min-h-0 flex-col gap-ui-3 overflow-auto p-ui-5">
      {loading ? <p role="status" className="text-ui-sm text-content-secondary">Inspecting saved declarations…</p> : null}
      <div className="flex items-start gap-ui-3 rounded-ui-lg bg-purr-elevated p-ui-4">
        <ShieldCheck className="mt-ui-1 size-ui-5 shrink-0 text-action-brand" />
        <div className="min-w-0 space-y-ui-2">
          <h3 className="m-ui-0 text-ui-md font-medium">{preview ? "Review incoming secrets" : mode === "export" ? "Encrypted secret package" : mode === "import" ? "Import a secret package" : mode === "recover" ? "Restore from recovery files" : mode === "key" ? "Workspace recovery key" : "Encrypted credential backup"}</h3>
          <p className="m-ui-0 text-ui-sm leading-relaxed text-content-secondary">{preview ? "Check incoming values with the eye. New secrets are selected; existing values stay unchanged unless you select Replace. This preview expires in five minutes." : mode === "export" ? description : mode === "import" ? "Choose a .purrsecrets file, then unlock it with its package password. Review the secrets before importing." : mode === "recover" ? "Choose your recovery key and matching credential backup first. Then enter their passwords to review the values to restore." : "Keep the recovery key and matching credential backup outside this device, together with their passwords. Update the backup after changing secrets."}</p>
        </div>
      </div>
      {mode === "export" && inventory ? <>
        <div className="flex flex-wrap items-end gap-ui-3">
        <div className="min-w-0 flex-1"><FormField label="Find saved secrets" placeholder="Search secret names…" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <div className="flex h-control-lg items-center gap-ui-3"><span className="text-ui-xs text-content-secondary">{selected.length} of {availableRefs.length} selected</span>
        <Button variant="secondary" size="sm" disabled={busy || !availableRefs.length} onClick={() => setSelected(allAvailableSelected ? [] : availableRefs)}><ListChecks className="size-ui-4" />{allAvailableSelected ? "Clear selection" : "Select all"}</Button></div>
        </div>
        <div className="overflow-hidden rounded-ui-md bg-purr-codefield p-ui-3">{visibleItems.filter((item) => item.status === "available").map((item) => <div key={item.ref} className="py-ui-1">
          <div className="flex items-center justify-between gap-ui-2">
            <Checkbox label={secretName(item.owners, "Saved secret")} checked={selected.includes(item.ref)} disabled={busy} onCheckedChange={(checked) => toggle(item.ref, checked)} />
            <span aria-label={`Saved value ${secretName(item.owners, "secret")}`} className="ml-auto min-w-0 max-w-full truncate font-code text-ui-sm text-content-secondary">{revealed?.ref === item.ref ? revealed.value : "••••••••"}</span>
            <Button variant="ghost" size="icon" aria-label={`${revealed?.ref === item.ref ? "Hide" : "Reveal"} saved ${secretName(item.owners, "secret")}`} disabled={busy} onClick={() => void revealSaved(item.ref)}>{revealed?.ref === item.ref ? <EyeOff className="size-ui-4" /> : <Eye className="size-ui-4" />}</Button>
          </div>
        </div>)}</div>
        {inventory.items.some((item) => item.status !== "available") ? <section aria-label="Unavailable secrets" className="flex flex-col gap-ui-2">
          <h3 className="m-ui-0 text-ui-sm font-medium">Unavailable secrets</h3>
          <div className="rounded-ui-md bg-purr-codefield p-ui-3">{inventory.items.filter((item) => item.status !== "available").map((item) => <div key={item.ref} className="flex items-center justify-between gap-ui-3 px-ui-3 py-ui-2">
            <span className="text-ui-sm">{secretName(item.owners, "Saved secret")}<span className="ml-ui-2 text-content-secondary">{item.status === "missing" ? "No saved value on this device" : `Cannot read value: ${item.status}`}</span></span>
            <Checkbox label="Exclude missing value" checked={omitted.includes(item.ref)} disabled={busy} onCheckedChange={(checked) => setOmitted((current) => checked ? [...current.filter((ref) => ref !== item.ref), item.ref] : current.filter((ref) => ref !== item.ref))} />
          </div>)}</div>
        </section> : null}
        {!inventory.items.length ? <p className="text-ui-sm text-content-secondary">No saved secret references. Save the owning request or variable first.</p> : null}
        {inventory.items.length > 0 && !visibleItems.length ? <p role="status" className="text-ui-sm text-content-secondary">No saved secrets match this search. Selected secrets remain selected.</p> : null}
        {unavailableSelected ? <p role="alert" className="text-ui-sm text-accent-orange">Selected unavailable values cannot be exported. Restore them or explicitly omit them.</p> : null}
      </> : null}
      {preview ? <>
        <div className="flex flex-wrap items-end gap-ui-3">
        <div className="min-w-0 flex-1"><FormField label="Find incoming secrets" placeholder="Search secret names…" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <div className="flex h-control-lg items-center gap-ui-3"><span className="text-ui-xs text-content-secondary">{selected.length} of {importableRefs.length} selected</span>
        <Button variant="secondary" size="sm" disabled={busy || Boolean(pending) || expired || !importableRefs.length} onClick={() => setSelected(allImportableSelected ? [] : importableRefs)}><ListChecks className="size-ui-4" />{allImportableSelected ? "Clear selection" : "Select all"}</Button></div>
        </div>
        <div className="overflow-hidden rounded-ui-md bg-purr-codefield p-ui-3">{preview.items.filter((item) => secretName(item.owners, "").toLowerCase().includes(query.trim().toLowerCase())).map((item) => <div key={item.ref} className="py-ui-1">
          <div className="flex items-center justify-between gap-ui-2">
          <Checkbox label={`${item.status === "existing" ? "Replace" : item.status === "unknown" ? "Unavailable here" : "Import"}: ${secretName(item.owners, item.status === "unknown" ? "Secret from another workspace version" : "Saved secret")}`} checked={selected.includes(item.ref)} disabled={busy || Boolean(pending) || item.status === "unknown" || expired} onCheckedChange={(checked) => toggle(item.ref, checked)} />
          <span aria-label={`Incoming value ${secretName(item.owners, "secret")}`} className="ml-auto min-w-0 max-w-full truncate font-code text-ui-sm text-content-secondary">{revealed?.ref === item.ref ? revealed.value : "••••••••"}</span>
          <Button variant="ghost" size="icon" aria-label={`${revealed?.ref === item.ref ? "Hide" : "Reveal"} incoming ${secretName(item.owners, "secret")}`} disabled={busy || Boolean(pending) || expired} onClick={() => void revealIncoming(item.ref)}>{revealed?.ref === item.ref ? <EyeOff className="size-ui-4" /> : <Eye className="size-ui-4" />}</Button>
          </div>
          {item.status === "unknown" ? <p className="mb-ui-0 mt-ui-1 text-ui-xs text-content-secondary">This workspace has no matching secret definition. Copy or import its public workspace files first, then retry.</p> : null}
        </div>)}</div>
        <p className="text-ui-sm text-content-secondary">{selected.length} values to import · {preview.items.filter((item) => item.status === "existing" && !selected.includes(item.ref)).length} existing values kept</p>
        {preview.omissions.length ? <p className="text-ui-sm text-content-secondary">{preview.omissions.length} secret {preview.omissions.length === 1 ? "definition was" : "definitions were"} left out of this package.</p> : null}
        {expired ? <p role="alert" className="text-ui-sm text-accent-orange">Preview expired or invalidated. Close and reopen import to check current values.</p> : null}
      </> : null}
      {(preview?.dependencies ?? inventory?.dependencies)?.length ? <p className="break-words text-ui-sm text-content-secondary">Referenced dependencies (not evaluated; ensure they exist on the destination): {(preview?.dependencies ?? inventory?.dependencies)?.join(", ")}</p> : null}
      {!preview ? <>
        {mode === "import" && staged || mode === "recover" && recoveryFiles ? <div className="flex items-center justify-between gap-ui-3 rounded-ui-md bg-purr-codefield p-ui-3">
          <FileKey className="size-ui-5 shrink-0 text-content-secondary" />
          <div className="min-w-0 flex-1 font-code text-ui-sm">{recoveryFiles ? <><p className="m-ui-0 truncate"><span className="mr-ui-2 font-ui text-content-secondary">Recovery key</span>{recoveryFiles.keyName}</p><p className="m-ui-0 truncate"><span className="mr-ui-2 font-ui text-content-secondary">Credential backup</span>{recoveryFiles.backupName}</p></> : <span className="block truncate">{staged?.name}</span>}</div>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { if (stagedRef.current) void transfer.cancel(stagedRef.current).catch(() => {}); stagedRef.current = null; setStaged(null); setRecoveryFiles(null); clearPasswords(); }}>Change files</Button>
        </div> : null}
        {exporting || mode === "import" && staged || mode === "recover" && recoveryFiles ? <section aria-label="Package passwords" className="space-y-ui-3 rounded-ui-lg bg-purr-codefield p-ui-4">
          <h3 className="m-ui-0 flex items-center gap-ui-2 text-ui-md font-medium"><KeyRound className="size-ui-4 text-content-secondary" />{mode === "recover" ? "Recovery passwords" : "Package password"}</h3>
          <div className={`grid grid-cols-1 gap-ui-4 ${exporting || mode === "recover" ? "sm:grid-cols-2" : ""}`}>
            <FormField label={mode === "recover" ? "Recovery key password" : "Package password"} secret autoFocus={mode === "import" || mode === "recover"} value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} />
            {exporting ? <FormField label="Confirm password" secret value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} /> : null}
            {mode === "recover" ? <FormField label="Credential backup password" secret value={backupPassword} disabled={busy} onChange={(event) => setBackupPassword(event.target.value)} /> : null}
          </div>
          {exporting ? <p className="m-ui-0 text-ui-xs text-content-secondary">At least 12 characters; at most 1024 UTF-8 bytes. Spaces are preserved.</p> : null}
          {exporting && passwordError ? <p role={password || confirmation ? "alert" : "status"} className={`m-ui-0 text-ui-sm ${password || confirmation ? "text-accent-red" : "text-content-secondary"}`}>{passwordError}</p> : null}
          {!exporting && (new TextEncoder().encode(password).byteLength > 1024 || new TextEncoder().encode(backupPassword).byteLength > 1024) ? <p role="alert" className="text-ui-sm text-accent-red">Password exceeds 1024 UTF-8 bytes.</p> : null}
        </section> : null}
      </> : null}
      {error ? <p role="alert" className="text-ui-sm text-accent-red">{error}</p> : null}
      {pending ? <p role="status" className="break-all font-code text-ui-xs text-content-secondary">Operation: {pending.id}</p> : null}

    </div>
  </Modal>;
}
