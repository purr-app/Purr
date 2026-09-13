import { Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Button } from "../../../shared/components/ui/button";
import { EditorTextarea } from "../../../shared/components/ui/editor-textarea";

export function MarkdownDocumentationEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (!editing) setDraft(value); }, [editing, value]);
  const cancel = () => { setDraft(value); setEditing(false); };
  const save = () => { onChange(draft); setEditing(false); };
  return <section id="request-section-docs" role="tabpanel" aria-labelledby="request-tab-docs" className="relative flex h-full min-h-0 flex-col bg-purr-surface">
    {editing ? <>
      <div className="min-h-0 flex-1 overflow-hidden">
        <EditorTextarea
        aria-label="Request documentation Markdown"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="# Document this request\n\nDescribe its purpose, inputs, and example response."
        spellCheck
        autoFocus
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); cancel(); }
          else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); save(); }
        }}
        />
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-ui-2 border-t border-border-subtle bg-purr-elevated px-ui-3 py-ui-2">
        <Button type="button" variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
        <Button type="button" variant="brand" size="sm" disabled={draft === value} onClick={save}>Save</Button>
      </footer>
    </> : <>
      <MarkdownPreview value={value} />
      <Button type="button" variant="secondary" size="icon" className="absolute right-ui-3 top-ui-3 shadow-button" aria-label="Edit documentation" title="Edit documentation" onClick={() => { setDraft(value); setEditing(true); }}>
        <Pencil className="size-ui-4" aria-hidden="true" />
      </Button>
    </>}
  </section>;
}

function MarkdownPreview({ value }: { value: string }) {
  if (!value.trim()) return <div aria-label="Markdown preview" className="h-full overflow-auto px-ui-5 py-ui-4 pr-ui-12 text-ui-md text-content-tertiary">No documentation yet.</div>;
  return <div aria-label="Markdown preview" className="h-full overflow-auto bg-purr-surface px-ui-5 py-ui-4 pr-ui-12 text-ui-md text-content-secondary">
    <ReactMarkdown components={{
      h1: ({ children }) => <h1 className="mb-ui-4 mt-ui-2 border-b border-border-subtle pb-ui-2 text-ui-xl font-semibold text-content-primary">{children}</h1>,
      h2: ({ children }) => <h2 className="mb-ui-3 mt-ui-5 text-ui-lg font-semibold text-content-primary">{children}</h2>,
      h3: ({ children }) => <h3 className="mb-ui-2 mt-ui-4 text-ui-md font-semibold text-content-primary">{children}</h3>,
      p: ({ children }) => <p className="my-ui-3">{children}</p>,
      ul: ({ children }) => <ul className="my-ui-3 list-disc space-y-ui-1 pl-ui-5">{children}</ul>,
      ol: ({ children }) => <ol className="my-ui-3 list-decimal space-y-ui-1 pl-ui-5">{children}</ol>,
      blockquote: ({ children }) => <blockquote className="my-ui-4 border-l-emphasis border-action-brand pl-ui-4 text-content-tertiary">{children}</blockquote>,
      pre: ({ children }) => <pre className="my-ui-4 overflow-auto rounded-ui-lg border border-border-subtle bg-purr-codefield p-ui-3 font-code text-ui-sm text-content-primary">{children}</pre>,
      code: ({ children }) => <code className="rounded-ui-sm bg-purr-codefield px-ui-1 font-code text-ui-sm text-syntax-string">{children}</code>,
      a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" className="text-action-brand underline">{children}</a>,
      hr: () => <hr className="my-ui-5 border-border-subtle" />,
      table: ({ children }) => <div className="my-ui-4 overflow-auto"><table className="w-full border-collapse font-code text-ui-sm">{children}</table></div>,
      th: ({ children }) => <th className="border border-border-subtle bg-purr-elevated px-ui-2 py-ui-1 text-left text-content-primary">{children}</th>,
      td: ({ children }) => <td className="border border-border-subtle px-ui-2 py-ui-1">{children}</td>,
    }}>{value}</ReactMarkdown>
  </div>;
}
