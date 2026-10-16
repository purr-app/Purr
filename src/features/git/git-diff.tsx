import { useEffect, useMemo, useRef, useState } from "react";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { yaml } from "@codemirror/lang-yaml";
import { purrCodeTheme, purrCodeHighlighting } from "../../shared/theme/code-editor-theme";
import { Button } from "../../shared/components/ui/button";
import { SegmentedTabs } from "../../shared/components/ui/segmented-tabs";
import { cn } from "../../shared/lib/cn";
import { displayValue, semanticSections } from "./semantic-diff";
import type { GitDiff } from "../../application/ports/git";

export function YamlDiff({ before, after }: { before: string; after: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const extensions = [purrCodeTheme, purrCodeHighlighting, yaml(), lineNumbers(), EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping];
    const view = new MergeView({ parent: host.current, a: { doc: before, extensions }, b: { doc: after, extensions }, highlightChanges: true, collapseUnchanged: { margin: 3, minSize: 8 } });
    return () => view.destroy();
  }, [before, after]);
  return <div className="flex min-h-0 flex-1 flex-col"><div className="grid grid-cols-2 border-b border-border-subtle bg-purr-surface px-ui-4 py-ui-2 text-ui-xs text-content-secondary"><span>Before</span><span>After</span></div><div ref={host} className="purr-git-diff min-h-0 flex-1 overflow-auto" aria-label="YAML diff" /></div>;
}
export function GitDiffView({ diff }: { diff: GitDiff }) {
  const sections = useMemo(() => semanticSections(diff.before, diff.after), [diff.before, diff.after]);
  const [mode, setMode] = useState<"semantic" | "yaml">("semantic"); const [unchanged, setUnchanged] = useState(false);
  if (diff.binary || diff.truncated) return <div className="p-ui-5 text-ui-sm text-content-secondary">{diff.binary ? "Binary file" : "This file is too large to preview."}<p className="font-code">{diff.beforeBytes.toLocaleString()} → {diff.afterBytes.toLocaleString()} bytes</p></div>;
  const activeMode = sections ? mode : "yaml";
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex flex-wrap items-center justify-between gap-ui-3 border-b border-border-subtle px-ui-4 py-ui-2">
      <span className="min-w-0 flex-1 truncate font-code text-ui-xs text-content-secondary" title={diff.path}>{diff.path}</span>
      <SegmentedTabs label="Diff view" id="git-diff-mode" panelId="git-diff-content" value={activeMode} onValueChange={setMode} options={[{ value: "semantic", label: "Semantic", disabled: !sections }, { value: "yaml", label: "YAML" }]} />
    </div>
    <div id="git-diff-content" className="flex min-h-0 flex-1 flex-col">
      {activeMode === "yaml" ? <YamlDiff before={diff.before} after={diff.after} /> : <div className="min-h-0 flex-1 space-y-ui-3 overflow-auto p-ui-4">
        <div className="flex items-center justify-between gap-ui-3 text-ui-xs text-content-tertiary"><span>{sections?.filter((section) => section.changed).length} sections changed</span><Button variant="ghost" size="xs" onClick={() => setUnchanged(!unchanged)}>{unchanged ? "Hide unchanged" : "Show unchanged"}</Button></div>
        {!sections?.some((section) => section.changed) && <p className="text-ui-sm text-content-secondary">No semantic changes. Switch to YAML to review formatting changes.</p>}
        {sections?.filter((section) => unchanged || section.changed).map((section) => <details key={section.key} open={section.changed} className="overflow-hidden rounded-ui-lg border border-border-subtle bg-purr-surface">
          <summary className="ui-focus-ring cursor-pointer px-ui-3 py-ui-2 text-ui-sm font-medium text-content-primary">{section.label}<span className="ml-ui-2 font-code text-ui-xs text-content-tertiary">{section.rows.filter((row) => row.changed).length || "unchanged"}</span></summary>
          <div className="divide-y divide-border-subtle border-t border-border-subtle">{section.rows.filter((row) => unchanged || row.changed).map((row) => <div key={row.key} className="px-ui-3 py-ui-2">
            {section.rows.length > 1 && <div className="mb-ui-2 flex items-center gap-ui-2 font-code text-ui-xs text-content-secondary">{row.label}{row.moved && <span className="text-accent-orange">Reordered</span>}</div>}
            <div className="grid grid-cols-1 gap-ui-3 lg:grid-cols-2">
              <div className={cn("min-w-0 rounded-ui-md border-l p-ui-3", row.changed ? "border-accent-red bg-purr-highlight" : "border-border-subtle")}><div className="mb-ui-1 text-ui-2xs text-content-tertiary">Before</div><pre className="m-ui-0 whitespace-pre-wrap break-words font-code text-ui-sm text-content-secondary">{displayValue(row.before)}</pre></div>
              <div className={cn("min-w-0 rounded-ui-md border-l p-ui-3", row.changed ? "border-status-success bg-action-emerald-surface" : "border-border-subtle")}><div className="mb-ui-1 text-ui-2xs text-content-tertiary">After</div><pre className="m-ui-0 whitespace-pre-wrap break-words font-code text-ui-sm text-content-primary">{displayValue(row.after)}</pre></div>
            </div>
          </div>)}</div>
        </details>)}
      </div>}
    </div>
  </div>;
}

/** The source can be Base, Local or Incoming; chunk controls copy into Result. */
export function YamlMergeEditor({ source, value, onChange }: { source: string; value: string; onChange: (value: string) => void }) {
  const host = useRef<HTMLDivElement>(null); const live = useRef({ value, onChange }); live.current = { value, onChange };
  useEffect(() => {
    if (!host.current) return;
    const extensions = [purrCodeTheme, purrCodeHighlighting, yaml(), lineNumbers(), EditorView.lineWrapping];
    const view = new MergeView({ parent: host.current,
      a: { doc: source, extensions: [...extensions, EditorState.readOnly.of(true), EditorView.editable.of(false)] },
      b: { doc: live.current.value, extensions: [...extensions, EditorView.updateListener.of((update) => { if (update.docChanged) live.current.onChange(update.state.doc.toString()); })] },
      revertControls: "a-to-b", renderRevertControl: () => { const button = document.createElement("button"); button.type = "button"; button.textContent = "→"; button.className = "ui-focus-ring rounded-ui-md bg-action-brand px-ui-2 font-ui text-content-primary"; button.setAttribute("aria-label", "Use this source change"); return button; },
    });
    return () => view.destroy();
  }, [source]);
  return <div ref={host} className="purr-git-diff min-h-0 flex-1 overflow-auto" aria-label="Conflict source and editable result" />;
}
