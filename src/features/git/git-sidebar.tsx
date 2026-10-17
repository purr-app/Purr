import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, GitBranch, GitCommitHorizontal, Archive, Network, RefreshCw, Plus, Minus, RotateCcw, FileSymlink, GitMerge, AlertCircle, Check } from "lucide-react";
import { Button } from "../../shared/components/ui/button";
import { Modal } from "../../shared/components/ui/modal";
import { Input } from "../../shared/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../shared/components/ui/popover";
import { useApplicationServices } from "../../app/application-services-context";
import { isDocumentDirty } from "../workspaces/model/workspace";
import { cn } from "../../shared/lib/cn";
import type { GitFile } from "../../application/ports/git";
import type { GitController } from "./use-git-workspace";

export function GitSidebar({ controller: c, onOpenDocument }: { controller: GitController; onOpenDocument: (id: string) => void }) {
  const { persistence, runtime } = useApplicationServices();
  const [message, setMessage] = useState(""); const [branchOpen, setBranchOpen] = useState(false); const [search, setSearch] = useState("");
  const [discard, setDiscard] = useState<GitFile[] | null>(null);
  const [commitMenu, setCommitMenu] = useState(false);
  const s = c.status; const blocked = c.busy || Boolean(s?.operation || s?.recovery);
  const dirtyEditors = c.workspace?.documents.filter((document) => isDocumentDirty(document)).length ?? 0;
  const stage = (files: GitFile[], staged: boolean) => { void c.execute({ type: staged ? "unstage" : "stage", paths: [...new Set(files.flatMap((file) => [file.path, ...(file.oldPath && (staged ? file.index === "R" : file.worktree === "R") ? [file.oldPath] : [])]))] }); };
  const commit = async (push = false) => { if (message.trim()) { if (await c.commit(message.trim(), push)) setMessage(""); } };
  const fileName = (file: GitFile) => persistence.fileOwner(c.workspace!.id, file.path)?.name ?? file.path.split("/").pop() ?? file.path;
  const group = (title: string, files: GitFile[], staged: boolean) => {
    if (staged && !files.length) return null;
    const ActionIcon = staged ? Minus : Plus;
    return <section aria-label={title} className="border-t border-border-subtle px-ui-2 py-ui-2">
      <div className="flex items-center gap-ui-2 px-ui-2 py-ui-1">
        <h3 className="m-ui-0 flex-1 text-ui-sm font-medium text-content-primary">{title}</h3>
        <span className="font-code text-ui-xs text-content-secondary">{files.length}</span>
        {!staged && <Button variant="ghost" size="icon" aria-label="Discard all changes" title="Discard all changes" disabled={blocked || c.indexWorking || !files.length} onClick={() => setDiscard(files)}><RotateCcw className="size-ui-3-5" /></Button>}
        <Button variant="ghost" size="icon" aria-label={staged ? "Unstage all files" : "Stage all files"} title={staged ? "Unstage all files" : "Stage all files"} disabled={blocked || !files.length} onClick={() => stage(files, staged)}><ActionIcon className="size-ui-4" /></Button>
      </div>
      <div className="space-y-ui-1">{files.map((file) => {
        const owner = persistence.fileOwner(c.workspace!.id, file.path);
        return <div key={file.path} className={cn("group flex items-center gap-ui-1 rounded-ui-md px-ui-2 py-ui-2 hover:bg-purr-elevated", c.selected?.path === file.path && c.selected.scope === (staged ? "staged" : "working") && c.view === "diff" && "bg-purr-highlight")}>
          <button className="ui-focus-ring min-w-0 flex-1 rounded-ui-md text-left" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} onClick={() => { void c.selectFile({ path: file.path, oldPath: file.oldPath, scope: staged ? "staged" : "working" }); }}>
            <span className="block truncate text-ui-sm text-content-primary">{fileName(file)}</span><span className="block truncate font-code text-ui-2xs text-content-secondary">{file.path}</span>
          </button>
          <div className="hidden shrink-0 items-center group-hover:flex group-focus-within:flex">
            {owner && <Button variant="ghost" size="icon" aria-label={`Open ${fileName(file)} document`} title="Open document" onClick={() => onOpenDocument(owner.id)}><FileSymlink className="size-ui-3-5" /></Button>}
            {!staged && <Button variant="ghost" size="icon" aria-label={`Discard ${fileName(file)} changes`} title="Discard changes" disabled={blocked || c.indexWorking} onClick={() => setDiscard([file])}><RotateCcw className="size-ui-3-5" /></Button>}
            <Button variant="ghost" size="icon" aria-label={`${staged ? "Unstage" : "Stage"} ${fileName(file)}`} title={staged ? "Unstage changes" : "Stage changes"} disabled={blocked} onClick={() => stage([file], staged)}><ActionIcon className="size-ui-4" /></Button>
          </div>
          <span className={cn("w-ui-3 text-center font-code text-ui-xs", file.index === "?" || file.index === "A" ? "text-status-success" : file.index === "D" || file.worktree === "D" ? "text-accent-red" : "text-action-brand")}>{file.index === "?" ? "U" : staged ? file.index : file.worktree}</span>
        </div>;
      })}</div>
      {!files.length && <p className="m-ui-0 px-ui-2 py-ui-2 text-ui-xs text-content-secondary">No changes</p>}
    </section>;
  };
  return <aside id="workspace-sidebar" aria-label="Source control" className="flex h-full min-h-0 min-w-ui-sidebar-min w-ui-sidebar-dynamic max-w-ui-sidebar-max flex-col bg-purr-base">
    <div className="flex items-center gap-ui-2 px-ui-3 py-ui-3"><GitBranch className="size-ui-4 text-action-brand" /><h2 className="m-ui-0 flex-1 text-ui-sm font-medium">Source control</h2><Button variant="ghost" size="icon" disabled={c.busy || runtime.kind !== "desktop"} aria-label="Refresh Git" title="Refresh Git" onClick={() => { void c.refresh(); }}><RefreshCw className="size-ui-3-5" /></Button></div>
    {runtime.kind !== "desktop" ? <p className="px-ui-3 text-ui-sm text-content-secondary">Git integration requires the Purr desktop app.</p> : !s ? <p className="px-ui-3 text-ui-sm text-content-tertiary">{c.error || "Reading repository…"}</p> : !s.initialized ? <div className="space-y-ui-3 px-ui-3 py-ui-4"><p className="text-ui-sm text-content-secondary">Track saved requests, environments, schemas and project files with Git.</p><Button variant="brand" className="w-full" disabled={c.busy} onClick={() => { void c.execute({ type: "init" }); }}><GitBranch className="size-ui-4" />Initialize Git</Button></div> : <>
      <div className="space-y-ui-2 border-b border-border-subtle px-ui-3 pb-ui-3">
        <Popover open={branchOpen} onOpenChange={(open) => { setBranchOpen(open); if (!open) setSearch(""); }}><PopoverTrigger asChild><Button variant="secondary" size="sm" className="w-full justify-between" title="Switch or create branch" aria-label="Select Git branch" disabled={blocked}><GitBranch className="size-ui-3-5" /><span className="flex-1 truncate text-left font-code">{s.branch ?? `Detached ${s.head?.slice(0, 7) ?? "HEAD"}`}</span><ChevronDown className="size-ui-3-5" /></Button></PopoverTrigger>
          <PopoverContent className="ui-popover-match-anchor overflow-hidden rounded-ui-lg border border-border bg-purr-overlay shadow-popover" align="start">
            <div className="border-b border-border-subtle p-ui-3"><Input autoFocus className="ui-focus-ring font-code" aria-label="Search Git branches" placeholder="Type to search or create branch…" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
            <div className="max-h-ui-variable-list overflow-y-auto p-ui-2">
              {s.branches.some((branch) => branch.name.toLowerCase().includes(search.trim().toLowerCase())) ? <>
                <p className="m-ui-0 px-ui-2 py-ui-2 text-ui-xs font-medium uppercase tracking-wide text-content-secondary">Branches</p>
                {s.branches.filter((branch) => branch.name.toLowerCase().includes(search.trim().toLowerCase())).map((branch) => <Button key={`${branch.remote}:${branch.name}`} variant="ghost" className={cn("w-full justify-start font-code", branch.current && "bg-purr-highlight")} aria-current={branch.current ? "true" : undefined} onClick={() => { if (branch.current) return; setBranchOpen(false); setSearch(""); void c.execute({ type: "switchBranch", name: branch.name }); }}>
                  {branch.current ? <Check className="size-ui-4 text-action-brand" /> : <GitBranch className="size-ui-4" />}<span className="flex-1 truncate text-left">{branch.name}</span>{branch.current && <span className="font-ui text-ui-2xs text-action-brand">Current</span>}
                </Button>)}
              </> : <Button variant="ghost" className="h-auto min-h-control-md w-full justify-start py-ui-2 text-action-brand" disabled={!search.trim() || !s.head} onClick={() => { const name = search.trim(); setBranchOpen(false); setSearch(""); void c.execute({ type: "createBranch", name }).then((result) => { if (result) return c.execute({ type: "switchBranch", name, allowDirty: true }); }); }}><Plus className="size-ui-4 shrink-0" /><span className="min-w-0 whitespace-normal break-words text-left">Create “{search.trim()}” branch</span></Button>}
            </div>
          </PopoverContent>
        </Popover>
        <div className="flex items-center gap-ui-2"><Button variant="secondary" size="sm" className="flex-1" disabled={blocked || !s.remotes.length} onClick={() => { c.network("fetch"); }}><RefreshCw className="size-ui-3-5" />Fetch</Button><Button variant="secondary" size="sm" className="flex-1" disabled={blocked || !s.upstream} onClick={() => { void c.sync(); }} aria-label={`Sync ${s.ahead} ahead ${s.behind} behind`}><GitMerge className="size-ui-3-5" />Sync<span className="font-code text-ui-2xs text-action-brand">↑{s.ahead} ↓{s.behind}</span></Button></div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {(s.operation || s.recovery || s.files.some((file) => file.conflicted)) && <button className="ui-focus-ring flex w-full items-center gap-ui-2 border-b border-border-subtle bg-purr-elevated px-ui-3 py-ui-3 text-left text-ui-sm text-accent-orange" onClick={() => c.openView("conflicts")}><GitMerge className="size-ui-4" /><span>{s.files.some((file) => file.conflicted) ? `Resolve ${s.files.filter((file) => file.conflicted).length} conflicts` : "Review pending operation"}</span></button>}
        {Object.keys(c.workspace?.editorConflicts ?? {}).length > 0 && <button className="ui-focus-ring flex w-full items-center gap-ui-2 px-ui-3 py-ui-3 text-left text-ui-sm text-accent-orange" onClick={() => c.openView("editor-conflicts")}><AlertCircle className="size-ui-4" />Review local editor conflicts</button>}
        {c.afterCommit && <div className="flex items-center gap-ui-2 bg-purr-elevated px-ui-3 py-ui-2 text-ui-xs text-content-secondary"><span className="min-w-0 flex-1">After commit: {c.afterCommit.type === "switchBranch" ? `switch to ${c.afterCommit.name}` : "pull changes"}</span><Button variant="ghost" size="xs" disabled={c.busy} onClick={c.cancelAfterCommit}>Cancel</Button></div>}
        <form className="space-y-ui-2 px-ui-3 py-ui-3" onSubmit={(event) => { event.preventDefault(); void commit(); }}>
          <textarea aria-label="Commit message" placeholder="Describe your changes…" value={message} onChange={(event) => setMessage(event.target.value)} disabled={blocked} className="ui-focus-ring h-ui-16 w-full resize-y rounded-ui-md border border-border-subtle bg-purr-elevated px-ui-2 py-ui-2 font-ui text-ui-sm text-content-primary placeholder:text-content-tertiary" onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void commit(); } }} />
          <div className="flex items-stretch gap-ui-1">
            <Button type="submit" variant="brand" className="flex-1" disabled={blocked || !message.trim() || !s.files.some((file) => file.index !== "." && file.index !== "?" && !file.conflicted)}><Check className="size-ui-4" />Commit</Button>
            <Popover open={commitMenu} onOpenChange={setCommitMenu}><PopoverTrigger asChild><Button variant="brand" className="w-control-md px-ui-0" aria-label="More commit actions" disabled={blocked}><ChevronDown className="size-ui-4" /></Button></PopoverTrigger>
              <PopoverContent align="end" className="rounded-ui-lg border border-border bg-purr-overlay p-ui-1 shadow-popover">
                <Button variant="ghost" size="sm" className="flex w-full justify-start" disabled={!s.remotes.length || !message.trim()} onClick={() => { setCommitMenu(false); void commit(true); }}><ArrowUp className="size-ui-4" />Commit and Push</Button>
                <Button variant="ghost" size="sm" className="flex w-full justify-start" disabled={!s.head || !s.files.length} onClick={() => { setCommitMenu(false); void c.execute({ type: "stash", message: message.trim() }).then((result) => { if (result) { setMessage(""); c.openView("stashes"); } }); }}><Archive className="size-ui-4" />Stash changes</Button>
              </PopoverContent>
            </Popover>
          </div>
          {dirtyEditors > 0 && <p className="m-ui-0 text-ui-2xs text-content-tertiary">{dirtyEditors} unsaved editor{dirtyEditors === 1 ? "" : "s"}. Git includes saved files only.</p>}
        </form>
        {group("Staged changes", s.files.filter((file) => file.index !== "." && file.index !== "?" && !file.conflicted), true)}
        {group("Changes", s.files.filter((file) => file.worktree !== "." && !file.conflicted), false)}
      </div>
      <div className="space-y-ui-1 border-t border-border-subtle px-ui-2 py-ui-2">{([{ view: "history", label: "Commits", icon: GitCommitHorizontal }, { view: "stashes", label: "Stashes", icon: Archive }, { view: "remotes", label: "Remotes", icon: Network }] as const).map(({ view, label, icon: Icon }) => <Button key={view} variant="ghost" size="sm" className={cn("w-full justify-start", c.view === view && "bg-purr-highlight text-content-primary")} onClick={() => c.openView(view)}><Icon className="size-ui-4" />{label}</Button>)}
        <div className="flex gap-ui-1 border-t border-border-subtle pt-ui-2"><Button variant="ghost" size="sm" className="flex-1" disabled={blocked || !s.remotes.length} onClick={() => { c.network("pull"); }}><ArrowDown className="size-ui-3-5" />Pull</Button><Button variant="ghost" size="sm" className="flex-1" disabled={blocked || !s.remotes.length || !s.head || !s.branch} onClick={() => { c.network("push"); }}><ArrowUp className="size-ui-3-5" />Push</Button></div>
      </div>
    </>}
    {c.error && s && <div role="alert" className="shrink-0 break-words border-t border-border-subtle px-ui-3 py-ui-2 text-ui-xs text-accent-red">{c.error}</div>}
    {c.busy && <div role="status" className="flex items-center gap-ui-2 border-t border-border-subtle px-ui-3 py-ui-2 text-ui-xs text-content-secondary"><RefreshCw className="size-ui-3-5 animate-spin text-action-brand" /><span className="min-w-0 flex-1 truncate">{c.progress || "Working…"}</span><Button variant="ghost" size="xs" onClick={c.cancel}>Cancel</Button></div>}
    {discard && <Modal title="Discard saved changes" onClose={() => setDiscard(null)} className="w-ui-name-dialog"><div className="space-y-ui-4 p-ui-5"><p className="text-ui-sm text-content-secondary">Discard changes to {discard.length === 1 ? `“${fileName(discard[0])}”` : `${discard.length} files`}? New files will be removed. Unsaved editors stay local.</p><div className="flex justify-end gap-ui-2"><Button variant="ghost" onClick={() => setDiscard(null)}>Cancel</Button><Button variant="secondary" className="text-accent-red" disabled={blocked} onClick={() => { const paths = [...new Set(discard.flatMap((file) => [file.path, ...(file.oldPath ? [file.oldPath] : [])]))]; setDiscard(null); void c.execute({ type: "discard", paths }); }}>Discard changes</Button></div></div></Modal>}

  </aside>;
}
