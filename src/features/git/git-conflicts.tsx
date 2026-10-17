import { useEffect, useState } from "react";
import { GitMerge } from "lucide-react";
import { Button } from "../../shared/components/ui/button";
import { Input } from "../../shared/components/ui/input";
import { SelectField } from "../../shared/components/ui/select-field";
import { SegmentedTabs } from "../../shared/components/ui/segmented-tabs";
import { YamlMergeEditor } from "./git-diff";
import type { GitConflict } from "../../application/ports/git";
import type { GitController } from "./use-git-workspace";
import { deserializeManifest, deserializeResource } from "../../storage/yaml";

export function GitConflicts({ controller: c }: { controller: GitController }) {
  const [conflicts, setConflicts] = useState<GitConflict[]>([]); const [path, setPath] = useState(""); const [source, setSource] = useState<"base" | "local" | "incoming">("incoming");
  const [result, setResult] = useState<string | null>(""); const [message, setMessage] = useState("Merge remote changes"); const [loading, setLoading] = useState(false);
  const selected = conflicts.find((conflict) => conflict.path === path) ?? conflicts[0];
  useEffect(() => {
    if (!c.workspace || c.busy) return; let active = true; setLoading(true);
    void c.git.conflicts(c.workspace.id).then((files) => { if (active) { setConflicts(files); setPath((current) => files.some((file) => file.path === current) ? current : files[0]?.path ?? ""); } }).catch((cause) => { if (active) c.setError(String(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [c.git, c.workspace?.id, c.status, c.busy]);
  useEffect(() => {
    if (!selected || !c.workspace) return; let active = true;
    void c.git.diff(c.workspace.id, { path: selected.path, scope: "working" }).then((diff) => { if (active) setResult(diff.after); }).catch((cause) => { if (active) c.setError(String(cause)); });
    return () => { active = false; };
  }, [selected?.path, selected?.revision, c.git, c.workspace?.id]);
  const externalOperation = c.status?.operation && c.status.operation !== "merge";
  const resolve = () => {
    if (!selected) return;
    try {
      if (result !== null && selected.path === "purr.yaml") {
        if (deserializeManifest(result).id !== c.workspace?.id) throw new Error("The workspace identity cannot change during a merge.");
      } else if (result !== null && /^(documents|requests|graphql|schemas|environments|folders|integrations)\/.*\.yaml$/.test(selected.path)) {
        // Validate this definition's shape before hiding it from the editor.
        // Cross-resource/sidecar checks run natively when finishing the project.
        deserializeResource(result, () => "");
      }
      void c.execute({ type: "resolveConflict", path: selected.path, content: result, revision: selected.revision });
    } catch (cause) { c.setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex flex-wrap items-center gap-ui-3 border-b border-border-subtle p-ui-4"><GitMerge className="size-ui-5 text-accent-orange" /><h2 className="m-ui-0 text-ui-lg font-medium">{conflicts.length ? "Resolve conflicts" : "Review pending operation"}</h2><span className="flex-1 text-ui-xs text-content-secondary">{conflicts.length ? `${conflicts.length} unresolved files` : ""}</span><Button variant="secondary" disabled={c.busy || Boolean(externalOperation)} onClick={() => { void c.execute({ type: "abortMerge" }); }}>Abort operation</Button></div>
    {externalOperation && <p role="status" className="px-ui-4 text-ui-sm text-accent-orange">Finish or abort this {c.status?.operation} in your external Git client, then refresh.</p>}
    {loading ? <p className="p-ui-4 text-ui-sm text-content-tertiary">Reading conflicts…</p> : selected ? <>
      <div className="flex flex-wrap items-center gap-ui-3 border-b border-border-subtle px-ui-4 py-ui-2"><SelectField label="Conflicted file" value={selected.path} onValueChange={setPath} options={conflicts.map((file) => ({ value: file.path, label: file.path }))} /><Button variant="secondary" size="sm" disabled={c.busy || Boolean(externalOperation)} onClick={() => setResult(selected.local)}>Use local file</Button><Button variant="secondary" size="sm" disabled={c.busy || Boolean(externalOperation)} onClick={() => setResult(selected.incoming)}>Use incoming file</Button></div>
      {selected.binary ? <div className="space-y-ui-4 p-ui-4"><p className="text-ui-sm text-content-secondary">Binary files require choosing one version.</p><div className="flex gap-ui-2">{(["local", "incoming"] as const).map((side) => <Button key={side} variant="secondary" disabled={c.busy || Boolean(externalOperation)} onClick={() => { void c.execute({ type: "resolveConflict", path: selected.path, side, content: null, revision: selected.revision }); }}>Accept {side}</Button>)}</div></div> : <>
        <div className="flex flex-wrap items-center justify-between gap-ui-3 px-ui-4 py-ui-2"><SegmentedTabs label="Conflict source" id="git-conflict-source" panelId="git-conflict-result" value={source} onValueChange={setSource} options={[{ value: "base", label: "Base" }, { value: "local", label: "Local" }, { value: "incoming", label: "Incoming" }]} /><span className="text-ui-xs text-content-secondary">Result {result === null ? "· delete file" : "· editable"}</span></div>
        <div id="git-conflict-result" className="flex min-h-0 flex-1 flex-col">{result === null ? <p className="p-ui-4 text-ui-sm text-content-secondary">The result deletes this file. Choose another side to keep it.</p> : <YamlMergeEditor key={`${selected.path}:${selected.revision}`} source={selected[source] ?? ""} value={result} onChange={setResult} readOnly={c.busy || Boolean(externalOperation)} />}</div>
        <div className="flex justify-end border-t border-border-subtle p-ui-3"><Button variant="brand" disabled={c.busy || Boolean(externalOperation) || result !== null && /^(<<<<<<< |=======\s*$|>>>>>>> )/m.test(result)} onClick={resolve}>Mark resolved</Button></div>
      </>}
    </> : <div className="space-y-ui-4 p-ui-5"><p className="text-ui-sm text-content-secondary">{c.status?.operation || c.status?.recovery ? "Finish to validate the saved project and reopen the workspace, or abort to restore the checkpoint." : "No unresolved Git conflicts."}</p>{(c.status?.operation || c.status?.recovery) && !externalOperation && <>{c.status?.operation === "merge" && <Input className="ui-focus-ring" aria-label="Merge commit message" value={message} onChange={(event) => setMessage(event.target.value)} />}<Button variant="brand" disabled={c.busy || c.status?.operation === "merge" && !message.trim()} onClick={() => { void c.execute({ type: "finishMerge", message }); }}>Finish operation</Button></>}</div>}
    {c.error && <p role="alert" className="m-ui-0 border-t border-border-subtle px-ui-4 py-ui-3 text-ui-sm text-accent-red">{c.error}</p>}
  </div>;
}
