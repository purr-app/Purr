import { useEffect, useState } from "react";
import { Archive, ArrowDown, ArrowLeft, ArrowUp, GitBranch, GitCommitHorizontal, Network, Plus, RefreshCw, Trash2, Pencil } from "lucide-react";
import { Button } from "../../shared/components/ui/button";
import { Input } from "../../shared/components/ui/input";
import { Modal } from "../../shared/components/ui/modal";
import { GitDiffView } from "./git-diff";
import { GitConflicts } from "./git-conflicts";
import { EditorConflicts } from "./local-editor-conflicts";
import type { GitCommit, GitFile, GitStash } from "../../application/ports/git";
import type { GitController } from "./use-git-workspace";

export function GitWorkbench(props: { controller: GitController; onResolveEditor: (id: string, choice: "incoming" | "local" | "draft") => void }) {
  const c = props.controller;
  return <div className="flex h-full min-h-0 flex-col">
    {c.view !== "overview" && <div className="shrink-0 border-b border-border-subtle bg-purr-elevated px-ui-3 py-ui-2"><Button variant="ghost" size="sm" onClick={() => c.openView("overview")}><ArrowLeft className="size-ui-4" />Overview</Button></div>}
    <div className="min-h-0 flex-1"><GitWorkbenchContent {...props} /></div>
  </div>;
}
function GitWorkbenchContent({ controller: c, onResolveEditor }: { controller: GitController; onResolveEditor: (id: string, choice: "incoming" | "local" | "draft") => void }) {
  const [commits, setCommits] = useState<GitCommit[]>([]); const [selectedCommit, setSelectedCommit] = useState<string | null>(null); const [files, setFiles] = useState<GitFile[]>([]);
  const [stashes, setStashes] = useState<GitStash[]>([]); const [loading, setLoading] = useState(false);
  const [remoteDialog, setRemoteDialog] = useState<{ name: string; url: string; editing: boolean } | null>(null); const [dropStash, setDropStash] = useState<GitStash | null>(null);
  const id = c.workspace?.id; const s = c.status; const blocked = c.busy || Boolean(s?.operation || s?.recovery);
  useEffect(() => {
    if (!id || !s?.initialized || c.busy || !["overview", "history", "stashes"].includes(c.view)) return;
    let active = true; setLoading(true);
    const work = c.view === "stashes" ? c.git.stashes(id).then((items) => { if (active) setStashes(items); }) : c.git.history(id).then((items) => { if (active) setCommits(items); });
    void work.catch((cause) => { if (active) c.setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, c.git, c.view, c.status, c.busy]);
  useEffect(() => {
    setFiles([]);
    if (!id || !selectedCommit) return;
    let active = true;
    void c.git.commitFiles(id, selectedCommit).then((items) => { if (active) setFiles(items); }).catch((cause) => { if (active) c.setError(String(cause)); });
    return () => { active = false; };
  }, [id, c.git, selectedCommit]);
  if (c.view === "conflicts") return <GitConflicts controller={c} />;
  if (c.view === "editor-conflicts") return <EditorConflicts workspace={c.workspace!} onResolve={onResolveEditor} />;
  if (c.view === "diff") return c.diff ? <GitDiffView diff={c.diff} names={Object.fromEntries(c.workspace?.documents.map((document) => [document.id, document.name]) ?? [])} /> : <p className="p-ui-4 text-ui-sm text-content-secondary">{c.error || "Loading diff…"}</p>;
  const title = c.view === "history" ? "Commits" : c.view === "stashes" ? "Stashes" : c.view === "remotes" ? "Remotes" : "Source control";
  const history = <div className="divide-y divide-border-subtle rounded-ui-lg border border-border-subtle">{(c.view === "overview" ? commits.slice(0, 5) : commits).map((commit) => <div key={commit.id}>
    <button type="button" className="ui-focus-ring flex w-full items-start gap-ui-3 rounded-ui-md px-ui-4 py-ui-3 text-left hover:bg-purr-elevated" onClick={() => setSelectedCommit(selectedCommit === commit.id ? null : commit.id)}>
      <GitCommitHorizontal className="mt-ui-1 size-ui-4 shrink-0 text-action-brand" /><span className="min-w-0 flex-1"><span className="block truncate text-ui-sm text-content-primary">{commit.message}</span><span className="block text-ui-xs text-content-tertiary">{commit.author} · {new Date(commit.timestamp).toLocaleString()}</span></span><span className="font-code text-ui-xs text-content-tertiary">{commit.shortId}</span>
    </button>
    {selectedCommit === commit.id && <div className="space-y-ui-1 border-t border-border-subtle bg-purr-surface px-ui-4 py-ui-2">{files.map((file) => <Button key={file.path} variant="ghost" size="sm" className="w-full justify-start font-code text-ui-xs" onClick={() => { void c.selectFile({ path: file.path, oldPath: file.oldPath, scope: "commit", commit: commit.id }); }}><span className="text-action-brand">{file.index}</span><span className="truncate">{file.oldPath ? `${file.oldPath} → ` : ""}{file.path}</span></Button>)}</div>}
  </div>)}</div>;
  return <div className="flex h-full min-h-0 flex-col overflow-y-auto">
    {c.view !== "overview" && <h2 className="m-ui-0 border-b border-border-subtle px-ui-5 py-ui-3 text-ui-lg font-medium">{title}</h2>}
    <div className={`mx-auto w-full max-w-ui-dialog shrink-0 space-y-ui-5 p-ui-5 ${c.view === "overview" ? "my-auto" : ""}`}>
      {c.error && <p role="alert" className="rounded-ui-md border border-border-subtle bg-purr-elevated p-ui-3 text-ui-sm text-accent-red">{c.error}</p>}
      {!s ? <p className="text-ui-sm text-content-secondary">{c.error || "Reading repository…"}</p> : !s.initialized ? <div className="space-y-ui-4 rounded-ui-lg border border-border-subtle bg-purr-surface p-ui-5"><GitBranch className="size-ui-8 text-action-brand" /><h3 className="m-ui-0 text-ui-lg font-medium">Keep your project in Git</h3><p className="text-ui-sm text-content-secondary">Review and share saved requests, environments, schemas and project files. Unsaved editors, history and credential values stay local.</p><p className="break-all font-code text-ui-xs text-content-tertiary">{s.directory}</p><Button variant="brand" disabled={c.busy} onClick={() => { void c.execute({ type: "init" }); }}>Initialize Git</Button></div> : c.view === "overview" ? <>
        <div className="space-y-ui-4 rounded-ui-lg border border-border-subtle bg-purr-surface p-ui-4">
          <div className="flex items-center gap-ui-2"><GitBranch className="size-ui-4 text-action-brand" /><span className="font-code text-ui-md">{s.branch ?? "Detached HEAD"}</span><span className="ml-auto font-code text-ui-xs text-content-secondary">↑ {s.ahead} ahead · ↓ {s.behind} behind</span></div>
          <p className="m-ui-0 text-ui-sm text-content-secondary">{s.upstream ? `Tracking ${s.upstream}` : s.remotes.length ? "Push this branch to set its upstream." : "Add a remote to share this workspace."}</p>
          <div className="flex flex-wrap gap-ui-2"><Button variant="secondary" disabled={blocked || !s.remotes.length} onClick={() => { c.network("fetch"); }}><RefreshCw className="size-ui-4" />Fetch</Button><Button variant="secondary" disabled={blocked || !s.remotes.length} onClick={() => { c.network("pull"); }}><ArrowDown className="size-ui-4" />Pull</Button><Button variant="brand" disabled={blocked || !s.remotes.length || !s.head || !s.branch} onClick={() => { c.network("push"); }}><ArrowUp className="size-ui-4" />Push</Button>{!s.remotes.length && <Button variant="secondary" onClick={() => c.openView("remotes")}><Network className="size-ui-4" />Add remote</Button>}</div>
          <p className="m-ui-0 text-ui-xs text-content-tertiary">Last fetched: {s.lastFetched ? new Date(s.lastFetched).toLocaleString() : "Never"}</p>
        </div>
        <p className="text-ui-sm text-content-secondary">{s.files.length ? `${s.files.length} changed files. Select a file from Source control to review its semantic or YAML diff.` : "Your working tree is clean."}</p>
        {!!Object.keys(c.workspace?.editorConflicts ?? {}).length && <Button variant="secondary" onClick={() => c.openView("editor-conflicts")}>Review local editor conflicts</Button>}
        <div className="flex items-center justify-between"><h3 className="m-ui-0 text-ui-md font-medium">Recent commits</h3><Button variant="ghost" size="sm" onClick={() => c.openView("history")}>View all</Button></div>{commits.length ? history : <p className="text-ui-sm text-content-tertiary">{loading ? "Loading commits…" : "Create your first commit from staged changes."}</p>}
      </> : c.view === "history" ? <>{commits.length ? history : <p className="text-ui-sm text-content-tertiary">{loading ? "Loading commits…" : "No commits yet."}</p>}{commits.length >= 50 && <Button variant="secondary" disabled={loading} onClick={() => { if (!id) return; setLoading(true); void c.git.history(id, commits.length).then((more) => setCommits((current) => [...current, ...more])).catch((cause) => c.setError(String(cause))).finally(() => setLoading(false)); }}>Load more</Button>}</> : c.view === "stashes" ? <>
        <p className="text-ui-sm text-content-secondary">Apply a saved stash here. Create stashes from the menu beside Commit.</p>
        {stashes.map((stash) => <div key={stash.id} className="flex items-center gap-ui-3 rounded-ui-lg border border-border-subtle p-ui-3"><Archive className="size-ui-4 shrink-0 text-content-tertiary" /><div className="min-w-0 flex-1"><p className="m-ui-0 truncate text-ui-sm" title={stash.message}>{stash.message}</p><p className="m-ui-0 font-code text-ui-xs text-content-tertiary">{stash.id.slice(0, 7)}</p></div><Button variant="secondary" size="sm" disabled={blocked} onClick={() => { void c.execute({ type: "applyStash", id: stash.id }); }}>Apply</Button><Button variant="ghost" size="icon" disabled={blocked} aria-label={`Drop stash ${stash.message}`} onClick={() => setDropStash(stash)}><Trash2 className="size-ui-4 text-accent-red" /></Button></div>)}{!stashes.length && <p className="text-ui-sm text-content-tertiary">{loading ? "Loading stashes…" : "No stashes."}</p>}
      </> : c.view === "remotes" ? <>
        <div className="flex items-center justify-between"><p className="m-ui-0 text-ui-sm text-content-secondary">HTTPS and SSH use your system Git credentials.</p><Button variant="brand" size="sm" disabled={blocked} onClick={() => setRemoteDialog({ name: "origin", url: "", editing: false })}><Plus className="size-ui-4" />Add remote</Button></div>
        {s.remotes.map((remote) => <div key={remote.name} className="flex items-center gap-ui-3 rounded-ui-lg border border-border-subtle p-ui-3"><Network className="size-ui-4 shrink-0 text-action-brand" /><div className="min-w-0 flex-1"><p className="m-ui-0 font-code text-ui-sm">{remote.name}</p><p className="m-ui-0 break-all font-code text-ui-xs text-content-tertiary">{remote.url}</p></div><Button variant="ghost" size="icon" disabled={blocked} aria-label={`Edit remote ${remote.name}`} onClick={() => setRemoteDialog({ ...remote, editing: true })}><Pencil className="size-ui-4" /></Button><Button variant="ghost" size="icon" disabled={blocked} aria-label={`Remove remote ${remote.name}`} onClick={() => { void c.execute({ type: "removeRemote", name: remote.name }); }}><Trash2 className="size-ui-4 text-accent-red" /></Button></div>)}{!s.remotes.length && <p className="text-ui-sm text-content-tertiary">Connect an empty remote for a new workspace, or a repository with the same workspace ID and shared history.</p>}
      </> : null}
    </div>
    {remoteDialog && <Modal title={remoteDialog.editing ? "Edit remote" : "Add remote"} onClose={() => { if (!c.busy) setRemoteDialog(null); }} className="w-ui-name-dialog"><form className="space-y-ui-4 p-ui-5" onSubmit={(event) => { event.preventDefault(); void c.execute({ type: "setRemote", name: remoteDialog.name.trim(), url: remoteDialog.url.trim() }).then((result) => { if (result) setRemoteDialog(null); }); }}>
      <label className="block space-y-ui-2 text-ui-sm text-content-secondary">Remote name<Input className="ui-focus-ring font-code" aria-label="Remote name" value={remoteDialog.name} disabled={c.busy || remoteDialog.editing} onChange={(event) => setRemoteDialog({ ...remoteDialog, name: event.target.value })} required /></label>
      <label className="block space-y-ui-2 text-ui-sm text-content-secondary">Repository URL<Input className="ui-focus-ring font-code" aria-label="Remote repository URL" placeholder="https://host/team/project.git" value={remoteDialog.url} disabled={c.busy} onChange={(event) => setRemoteDialog({ ...remoteDialog, url: event.target.value })} required /></label>
      {c.error && <p role="alert" className="text-ui-sm text-accent-red">{c.error}</p>}<div className="flex justify-end gap-ui-2"><Button type="button" variant="ghost" disabled={c.busy} onClick={() => setRemoteDialog(null)}>Cancel</Button><Button type="submit" variant="brand" disabled={c.busy || !remoteDialog.name.trim() || !remoteDialog.url.trim()}>{c.busy ? "Checking…" : "Save remote"}</Button></div>
    </form></Modal>}
    {dropStash && <Modal title="Drop stash" onClose={() => setDropStash(null)} className="w-ui-name-dialog"><div className="space-y-ui-4 p-ui-5"><p className="text-ui-sm text-content-secondary">Permanently remove “{dropStash.message}” from the stash list?</p><div className="flex justify-end gap-ui-2"><Button variant="ghost" onClick={() => setDropStash(null)}>Cancel</Button><Button variant="secondary" className="text-accent-red" disabled={c.busy} onClick={() => { void c.execute({ type: "dropStash", id: dropStash.id }).then((result) => { if (result) setDropStash(null); }); }}>Drop stash</Button></div></div></Modal>}
  </div>;
}
