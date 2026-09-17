import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { commonHttpHeaders } from "../../../shared/config/http-headers";
import { Collapsible } from "../../../shared/components/ui/collapsible";
import { cn } from "../../../shared/lib/cn";
import { isRequestHeaderNameValid, type RequestHeader } from "../model/request";
import { KeyValueEditor, type KeyValueEntry } from "./key-value-editor";
import type { TemplateVariableActions } from "./template-variable-popover";

type HeadersEditorProps = {
  headers: RequestHeader[];
  fillHeight?: boolean;
  onHeadersChange: (headers: RequestHeader[]) => void;
  onWorkspaceHeaderEnabledChange?: (id: string, enabled: boolean) => void;
  variableActions?: TemplateVariableActions;
};

const headerValidationMessage =
  "Header names may only use Latin letters, digits, and valid HTTP token symbols — without spaces.";

function createEmptyHeader(entries: KeyValueEntry[]): KeyValueEntry {
  const highestId = entries.reduce((highest, entry) => {
    const id = Number(entry.id.replace("header-", ""));
    return Number.isFinite(id) ? Math.max(highest, id) : highest;
  }, 0);

  return { id: `header-${highestId + 1}`, key: "", value: "", enabled: false };
}

export function HeadersEditor({
  headers,
  fillHeight = true,
  onHeadersChange,
  onWorkspaceHeaderEnabledChange,
  variableActions,
}: HeadersEditorProps) {
  const [inheritedOpen, setInheritedOpen] = useState(true);
  const inherited = headers.filter((header) => header.workspaceHeaderId);
  const local = headers.filter((header) => !header.workspaceHeaderId);
  // Keep generated values together above the editable rows, including the blank row.
  const localRows = [...local.filter((header) => header.readOnly), ...local.filter((header) => !header.readOnly)];
  if (!localRows.some((header) => !header.readOnly && !header.name && !header.value)) {
    const blank = createEmptyHeader(localRows.map((header) => ({ ...header, key: header.name })));
    localRows.push({ id: blank.id, name: "", value: "", enabled: false });
  }
  const toEntry = (header: RequestHeader): KeyValueEntry => ({
    id: header.id,
    key: header.name,
    value: header.value,
    enabled: header.enabled,
    readOnly: header.readOnly,
    readOnlyReason: header.readOnlyReason,
    secret: header.secret,
    hideReadOnlyIndicator: Boolean(header.workspaceHeaderId),
  });
  const editor = (source: RequestHeader[]) => <KeyValueEditor
    fillHeight={fillHeight}
    entries={source.map(toEntry)}
    onEntriesChange={(nextEntries) =>
      onHeadersChange(
        nextEntries.map((entry) => ({
          id: entry.id,
          name: entry.key,
          value: entry.value,
          enabled: entry.enabled,
          readOnly: entry.readOnly,
          readOnlyReason: entry.readOnlyReason,
          secret: entry.secret,
        })),
      )
    }
    createEmptyEntry={createEmptyHeader}
    onReadOnlyEnabledChange={(entry, enabled) => {
      const header = headers.find((item) => item.id === entry.id);
      if (header?.workspaceHeaderId)
        onWorkspaceHeaderEnabledChange?.(header.workspaceHeaderId, enabled);
    }}
    keyLabel="header"
    keyPlaceholder="Header-name"
    valuePlaceholder="value"
    keyTextClassName="text-syntax-property"
    keySuggestions={commonHttpHeaders}
    isKeyValid={isRequestHeaderNameValid}
    validationMessage={headerValidationMessage}
    valueFont="code"
    variableActions={variableActions}
  />;

  return (
    <div className={cn(fillHeight && "min-h-full", "bg-purr-surface")}>
      {inherited.length ? (
        <section className="m-ui-3 rounded-ui-lg border border-dashed border-border-subtle bg-purr-codefield">
          <button type="button" className="ui-focus-ring flex w-full items-center gap-ui-2 rounded-ui-md px-ui-3 py-ui-2 text-left text-ui-sm text-content-tertiary"
            aria-expanded={inheritedOpen} onClick={() => setInheritedOpen((open) => !open)}>
            <ChevronDown className={cn("size-ui-3 transition-transform duration-ui-fast", !inheritedOpen && "-rotate-90")} />
            Inherited <span className="font-code text-action-brand">{inherited.length}</span>
          </button>
          <Collapsible open={inheritedOpen}>{editor(inherited)}</Collapsible>
        </section>
      ) : null}
      {inherited.length ? <p className="m-ui-0 px-ui-4 pb-ui-1 font-ui text-ui-xs text-content-tertiary">Local</p> : null}
      {editor(localRows)}
    </div>
  );
}
