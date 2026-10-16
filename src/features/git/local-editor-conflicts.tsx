import { useEffect, useState } from "react";
import { useApplicationServices } from "../../app/application-services-context";
import { projectWorkspace } from "../../application/project-projection";
import { SecretPreparationStore } from "../../storage/secrets";
import { serializeResource } from "../../storage/yaml";
import type { ProjectResource } from "../../domain/project";
import { isRequestDocument, type Workspace } from "../workspaces/model/workspace";
import { Button } from "../../shared/components/ui/button";
import { SelectField } from "../../shared/components/ui/select-field";
import { SegmentedTabs } from "../../shared/components/ui/segmented-tabs";
import { GitDiffView } from "./git-diff";
const encode = (resource: ProjectResource | null | undefined) => resource ? serializeResource(resource, resource.kind === "schema" ? "schemas/preview.graphql" : resource.kind === "api-schema" ? "schemas/preview.openapi" : undefined) : "";
export function EditorConflicts({ workspace, onResolve }: { workspace: Workspace; onResolve: (id: string, choice: "incoming" | "local" | "draft") => void }) {
  const { secureStore } = useApplicationServices(); const ids = Object.keys(workspace.editorConflicts ?? {}); const [selectedId, setSelectedId] = useState("");
  const id = ids.includes(selectedId) ? selectedId : ids[0]; const conflict = workspace.editorConflicts?.[id]; const document = workspace.documents.find((item) => item.id === id);
  const [side, setSide] = useState<"local" | "incoming">("local"); const [local, setLocal] = useState<ProjectResource | null>(null); const [error, setError] = useState("");
  useEffect(() => {
    if (!document) return; let active = true;
    const candidate = isRequestDocument(document) ? { ...document, saved: true, savedRequest: document.request } : document.kind === "extension" ? { ...document, saved: true, savedConfig: document.config } : document;
    void projectWorkspace({ ...workspace, documents: [candidate] }, new SecretPreparationStore(secureStore), { includeExecutions: false }).then(({ project }) => { if (active) { setLocal(project.resources.find((resource) => resource.id === id) ?? null); setError(""); } }).catch(() => { if (active) setError("The local preview is unavailable. Your editor is preserved."); });
    return () => { active = false; };
  }, [id, document, secureStore, workspace]);
  if (!conflict) return <p className="p-ui-5 text-ui-sm text-content-secondary">No local editor conflicts.</p>;
  const before = encode(conflict.base); const after = encode(side === "local" ? local : conflict.incoming);
  return <div className="flex h-full min-h-0 flex-col">
    <div className="space-y-ui-3 border-b border-border-subtle p-ui-4"><h2 className="m-ui-0 text-ui-lg font-medium">Local editor changed on disk</h2><p className="m-ui-0 text-ui-sm text-content-secondary">Your unsaved editor is preserved. Review it against the incoming saved version. Keeping local edits leaves them unsaved until you choose Save.</p>
      <div className="flex flex-wrap items-center gap-ui-3"><SelectField label="Local editor conflict" value={id} options={ids.map((key) => ({ value: key, label: workspace.documents.find((item) => item.id === key)?.name ?? key }))} onValueChange={setSelectedId} /><SegmentedTabs label="Compare editor changes" id="editor-conflict-side" panelId="editor-conflict-diff" value={side} onValueChange={setSide} options={[{ value: "local", label: "Base → Local" }, { value: "incoming", label: "Base → Incoming" }]} /></div>
      {error && <p role="alert" className="text-ui-sm text-accent-red">{error}</p>}
    </div>
    <div id="editor-conflict-diff" className="min-h-0 flex-1"><GitDiffView diff={{ path: document?.name ?? id, before, after, beforeBytes: before.length, afterBytes: after.length, binary: false, truncated: false }} /></div>
    <div className="flex flex-wrap justify-end gap-ui-2 border-t border-border-subtle p-ui-3"><Button variant="secondary" onClick={() => onResolve(id, "incoming")}>{conflict.incoming ? "Use incoming" : "Accept deletion"}</Button><Button variant="secondary" onClick={() => onResolve(id, "draft")}>Keep as new draft</Button><Button variant="brand" onClick={() => onResolve(id, "local")}>Keep local edits</Button></div>
  </div>;
}
