import { SelectField } from "../../shared/components/ui/select-field";
import { useState } from "react";
import { Modal } from "../../shared/components/ui/modal";
import { Button } from "../../shared/components/ui/button";
import { Input } from "../../shared/components/ui/input";
import type { GitAction } from "../../application/ports/git";
import type { GitController } from "./use-git-workspace";
export function GitDialogs({ controller: c }: { controller: GitController }) {
  const [name, setName] = useState(""); const [email, setEmail] = useState("");
  return <>
    {c.dirtyAction && <Modal title="Uncommitted changes" onClose={() => { if (!c.busy) c.setDirtyAction(null); }} className="w-ui-name-dialog">
      <div className="space-y-ui-4 p-ui-5"><p className="text-ui-sm text-content-secondary">Commit or stash your saved changes before {c.dirtyAction.type === "pull" ? "pulling" : "switching branches"}. Unsaved editors remain local.</p>
        {c.error && <p role="alert" className="text-ui-sm text-accent-red">{c.error}</p>}
        <div className="flex flex-wrap justify-end gap-ui-2"><Button variant="ghost" disabled={c.busy} onClick={() => c.setDirtyAction(null)}>Cancel</Button>
          {!("allowDirty" in c.dirtyAction && c.dirtyAction.allowDirty) && <Button variant="secondary" disabled={c.busy} onClick={() => { const action = { ...c.dirtyAction!, allowDirty: true } as GitAction; c.setDirtyAction(null); void c.execute(action); }}>Continue safely</Button>}
          <Button variant="secondary" disabled={c.busy} onClick={c.commitBeforeContinue}>Commit…</Button><Button variant="brand" disabled={c.busy || !c.status?.head} onClick={() => { void c.stashAndContinue(); }}>Stash and continue</Button>
        </div>
        <p className="m-ui-0 text-ui-xs text-content-tertiary">Continue lets Git preserve compatible changes. If files would be overwritten, the operation stops.</p>
      </div>
    </Modal>}
    {c.networkAction && <Modal title={`${c.networkAction.type[0].toUpperCase()}${c.networkAction.type.slice(1)} changes`} onClose={() => { if (!c.busy) c.setNetworkAction(null); }} className="w-ui-name-dialog">
      <form className="space-y-ui-4 p-ui-5" onSubmit={(event) => { event.preventDefault(); const action = c.networkAction!; c.setNetworkAction(null); void c.execute({ type: action.type, remote: action.remote, ...(action.branch.trim() ? { branch: action.branch.trim() } : {}) }); }}>
        <label className="block space-y-ui-2 text-ui-sm text-content-secondary">Remote<SelectField label="Git remote" value={c.networkAction.remote} options={(c.status?.remotes ?? []).map((remote) => ({ value: remote.name, label: remote.name }))} onValueChange={(remote) => c.setNetworkAction({ ...c.networkAction!, remote })} /></label>
        {c.networkAction.type !== "fetch" && <label className="block space-y-ui-2 text-ui-sm text-content-secondary">Remote branch<Input className="ui-focus-ring font-code" aria-label="Remote branch" value={c.networkAction.branch} onChange={(event) => c.setNetworkAction({ ...c.networkAction!, branch: event.target.value })} required /></label>}
        <p className="text-ui-sm text-content-secondary">{c.networkAction.type === "push" ? `Push from ${c.status?.branch} to ${c.networkAction.remote}/${c.networkAction.branch}.` : c.networkAction.type === "pull" ? `Merge ${c.networkAction.remote}/${c.networkAction.branch} into ${c.status?.branch}.` : `Fetch branches from ${c.networkAction.remote}.`}</p>
        <div className="flex justify-end gap-ui-2"><Button type="button" variant="ghost" onClick={() => c.setNetworkAction(null)}>Cancel</Button><Button type="submit" variant="brand" disabled={c.busy || !c.networkAction.remote}>{c.networkAction.type[0].toUpperCase() + c.networkAction.type.slice(1)}</Button></div>
      </form>
    </Modal>}
    {c.authorAction && <Modal title="Git author" onClose={() => { if (!c.busy) c.setAuthorAction(null); c.cancelAfterCommit(); }} className="w-ui-name-dialog">
      <form className="space-y-ui-4 p-ui-5" onSubmit={(event) => { event.preventDefault(); void c.execute({ ...c.authorAction!, author: { name, email } }).then((result) => { if (result) void c.continueAfterCommit(); }); }}>
        <p className="text-ui-sm text-content-secondary">Set the commit author for this repository.</p>
        <label className="block space-y-ui-2 text-ui-sm text-content-secondary">Name<Input className="ui-focus-ring" aria-label="Git author name" value={name} onChange={(event) => setName(event.target.value)} required /></label>
        <label className="block space-y-ui-2 text-ui-sm text-content-secondary">Email<Input className="ui-focus-ring" aria-label="Git author email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
        {c.error && <p role="alert" className="text-ui-sm text-accent-red">{c.error}</p>}
        <div className="flex justify-end gap-ui-2"><Button type="button" variant="ghost" disabled={c.busy} onClick={() => c.setAuthorAction(null)}>Cancel</Button><Button type="submit" variant="brand" disabled={c.busy || !name.trim() || !email.trim()}>Save and commit</Button></div>
      </form>
    </Modal>}
  </>;
}
