import { useState } from "react";
import { Button } from "../../../shared/components/ui/button";
import { Input } from "../../../shared/components/ui/input";
import { Modal } from "../../../shared/components/ui/modal";

export function NameDialog({ title, label, initial, onSave, onClose }: {
  title: string; label: string; initial: string; onSave: (name: string) => void; onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  return <Modal title={title} onClose={onClose} className="w-ui-name-dialog">
    <form className="space-y-ui-4 p-ui-5" onSubmit={(event) => { event.preventDefault(); if (name.trim()) onSave(name.trim()); }}>
      <label className="block space-y-ui-2 text-ui-sm text-content-secondary">{label}
        <Input className="ui-focus-ring" aria-label={label} autoFocus value={name} onChange={(event) => setName(event.target.value)} onFocus={(event) => event.target.select()} maxLength={160} required />
      </label>
      <div className="flex justify-end gap-ui-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" variant="brand" disabled={!name.trim()}>Save</Button></div>
    </form>
  </Modal>;
}
