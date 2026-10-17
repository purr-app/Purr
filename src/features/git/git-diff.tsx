import { useEffect, useMemo, useRef, useState } from "react";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { yaml } from "@codemirror/lang-yaml";
import { purrCodeTheme, purrCodeHighlighting } from "../../shared/theme/code-editor-theme";
import { Button } from "../../shared/components/ui/button";
import { SegmentedTabs } from "../../shared/components/ui/segmented-tabs";
import { SemanticComparison } from "./semantic-comparison";
import { semanticSections } from "./semantic-diff";
import type { GitDiff } from "../../application/ports/git";

export function YamlDiff({ before, after }: { before: string; after: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const extensions = [purrCodeTheme, purrCodeHighlighting, yaml(), lineNumbers(), EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping];
    const view = new MergeView({ parent: host.current, a: { doc: before, extensions }, b: { doc: after, extensions }, highlightChanges: true, collapseUnchanged: { margin: 3, minSize: 8 } });
    return () => view.destroy();
  }, [before, after]);
  return <div className="flex min-h-0 flex-1 flex-col"><div className="grid grid-cols-2 border-b border-border-subtle bg-purr-surface px-ui-4 py-ui-2 text-ui-xs text-content-secondary"><span>Before</span><span>After</span></div><div ref={host} className="purr-git-diff min-h-0 flex-1 overflow-auto" aria-label="File diff" /></div>;
}
function FilePreview({ content, isYaml }: { content: string; isYaml: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({ parent: host.current, doc: content, extensions: [purrCodeTheme, purrCodeHighlighting, ...(isYaml ? [yaml()] : []), lineNumbers(), EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping] });
    return () => view.destroy();
  }, [content, isYaml]);
  return <div ref={host} className="min-h-0 flex-1 overflow-auto" aria-label="File content" />;
}
export function GitDiffView({ diff, names }: { diff: GitDiff; names?: Record<string, string> }) {
  const sections = useMemo(() => semanticSections(diff.before, diff.after), [diff.before, diff.after]);
  const [mode, setMode] = useState<"semantic" | "yaml">("semantic"); const [unchanged, setUnchanged] = useState(false);
  const single = (diff.beforeExists === false || diff.beforeExists === undefined && !diff.beforeBytes) ? "after" as const : (diff.afterExists === false || diff.afterExists === undefined && !diff.afterBytes) ? "before" as const : undefined;
  if (diff.binary || diff.truncated) return <div className="p-ui-5 text-ui-sm text-content-secondary">{diff.binary ? single === "after" ? "New binary file" : "Binary file" : "This file is too large to preview."}<p className="font-code">{single ? (single === "after" ? diff.afterBytes : diff.beforeBytes).toLocaleString() : `${diff.beforeBytes.toLocaleString()} → ${diff.afterBytes.toLocaleString()}`} bytes</p></div>;
  const activeMode = sections ? mode : "yaml";
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex flex-wrap items-center justify-between gap-ui-3 border-b border-border-subtle px-ui-4 py-ui-2">
      {single && <span className="rounded-ui-md bg-purr-highlight px-ui-2 py-ui-1 text-ui-xs font-medium text-content-primary">{single === "after" ? "New file" : "Deleted file"}</span>}
      <span className="min-w-0 flex-1 truncate font-code text-ui-xs text-content-secondary" title={diff.path}>{diff.path}</span>
      <SegmentedTabs label="Diff view" id="git-diff-mode" panelId="git-diff-content" value={activeMode} onValueChange={setMode} options={[{ value: "semantic", label: "Semantic", disabled: !sections }, { value: "yaml", label: sections || /\.ya?ml$/i.test(diff.path) ? "YAML" : "Text" }]} />
    </div>
    <div id="git-diff-content" className="flex min-h-0 flex-1 flex-col">
      {activeMode === "yaml" ? single ? <FilePreview content={diff[single]} isYaml={/\.ya?ml$/i.test(diff.path)} /> : <YamlDiff before={diff.before} after={diff.after} /> : <div className="min-h-0 flex-1 space-y-ui-3 overflow-auto p-ui-4">
        {!single && <div className="flex items-center justify-between gap-ui-3 text-ui-xs text-content-secondary"><span>{sections?.filter((section) => section.changed).length} sections changed</span><Button variant="ghost" size="xs" onClick={() => setUnchanged(!unchanged)}>{unchanged ? "Hide unchanged" : "Show unchanged"}</Button></div>}
        {!sections?.some((section) => section.changed) && <p className="text-ui-sm text-content-secondary">No semantic changes. Switch to YAML to review formatting changes.</p>}
        {sections?.filter((section) => single || unchanged || section.changed).map((section) => <SemanticComparison key={`${diff.path}:${section.key}:${single ?? "comparison"}`} section={section} unchanged={unchanged} single={single} names={names} />)}
      </div>}
    </div>
  </div>;
}

/** The source can be Base, Local or Incoming; chunk controls copy into Result. */
export function YamlMergeEditor({ source, value, onChange, readOnly = false }: { source: string; value: string; onChange: (value: string) => void; readOnly?: boolean }) {
  const host = useRef<HTMLDivElement>(null); const live = useRef({ value, onChange }); live.current = { value, onChange };
  const instance = useRef<MergeView | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const extensions = [purrCodeTheme, purrCodeHighlighting, yaml(), lineNumbers(), EditorView.lineWrapping];
    const view = new MergeView({ parent: host.current,
      a: { doc: source, extensions: [...extensions, EditorState.readOnly.of(true), EditorView.editable.of(false)] },
      b: { doc: live.current.value, extensions: [...extensions, EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly), EditorView.updateListener.of((update) => { if (update.docChanged) live.current.onChange(update.state.doc.toString()); })] },
      revertControls: readOnly ? undefined : "a-to-b", renderRevertControl: () => { const button = document.createElement("button"); button.type = "button"; button.textContent = "→"; button.className = "ui-focus-ring rounded-ui-md bg-action-brand px-ui-2 font-ui text-content-primary"; button.setAttribute("aria-label", "Use this source change"); return button; },
    });
    instance.current = view;
    return () => { instance.current = null; view.destroy(); };
  }, [source, readOnly]);
  useEffect(() => {
    const editor = instance.current?.b;
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);
  return <div ref={host} className="purr-git-diff min-h-0 flex-1 overflow-auto" aria-label="Conflict source and editable result" />;
}
