import { applyRequestQueryParamsToUrl, type RequestDraft } from "../model/request";
import { getRequestEditorSection, type RequestEditorSection } from "../model/request-editor-section";
import { HeadersEditor } from "./headers-editor";
import { QueryParamsEditor } from "./query-params-editor";

type RequestSectionPanelProps = {
  activeSection: RequestEditorSection;
  draft: RequestDraft;
  onDraftChange: (draft: RequestDraft) => void;
};

export function RequestSectionPanel({ activeSection, draft, onDraftChange }: RequestSectionPanelProps) {
  const section = getRequestEditorSection(activeSection);

  return (
    section?.id === "query" ? (
      <QueryParamsEditor
        params={draft.params}
        onParamsChange={(params) => onDraftChange({ ...draft, params, url: applyRequestQueryParamsToUrl(draft.url, params) })}
      />
    ) : section?.id === "headers" ? (
      <HeadersEditor headers={draft.headers} onHeadersChange={(headers) => onDraftChange({ ...draft, headers })} />
    ) : section ? (
      <section id={`request-section-${section.id}`} role="tabpanel" className="bg-purr-elevated px-ui-4 py-ui-4 sm:px-ui-5">
        <div className="flex items-baseline justify-between gap-ui-4">
          <h2 className="m-ui-0 text-ui-md font-medium text-content-primary">{section.label}</h2>
          <p className="m-ui-0 text-ui-xs text-content-tertiary">{section.description}</p>
        </div>
        <div className="mt-ui-4 min-h-panel rounded-ui-lg border border-dashed border-border-subtle bg-purr-surface" />
      </section>
    ) : null
  );
}
