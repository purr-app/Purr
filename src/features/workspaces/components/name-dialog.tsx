import { useState } from "react";
import { Button } from "../../../shared/components/ui/button";
import { Input } from "../../../shared/components/ui/input";
import { Modal } from "../../../shared/components/ui/modal";

export function NameDialog({ title, label, initial, validate, onSave, onClose }: {
  title: string; label: string; initial: string; validate?: (name: string) => string | null; onSave: (name: string) => void | Promise<void>; onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const error = name.trim() ? validate?.(name.trim()) : null;
  return <Modal title={title} onClose={() => { if (!saving) onClose(); }} className="w-ui-name-dialog">
    <form className="space-y-ui-4 p-ui-5" onSubmit={async (event) => {
      event.preventDefault(); if (!name.trim() || error || saving) return;
      setSaving(true); setSaveError("");
      try { await onSave(name.trim()); } catch (cause) { setSaveError(cause instanceof Error ? cause.message : "Could not save. Please retry."); }
      finally { setSaving(false); }
    }}>
      <label className="block space-y-ui-2 text-ui-sm text-content-secondary">{label}
        <Input className="ui-focus-ring" aria-label={label} aria-invalid={Boolean(error)} autoFocus value={name} onChange={(event) => setName(event.target.value)} onFocus={(event) => event.target.select()} maxLength={160} required />
      </label>
      {(error || saveError) && <p role="alert" className="text-ui-sm text-accent-red">{error || saveError}</p>}
      <div className="flex justify-end gap-ui-2"><Button type="button" variant="ghost" disabled={saving} onClick={onClose}>Cancel</Button><Button type="submit" variant="brand" disabled={saving || !name.trim() || Boolean(error)}>Save</Button></div>
    </form>
  </Modal>;
}
