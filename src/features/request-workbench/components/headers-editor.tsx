import { commonHttpHeaders } from "../../../shared/config/http-headers";
import { isRequestHeaderNameValid, type RequestHeader } from "../model/request";
import { KeyValueEditor, type KeyValueEntry } from "./key-value-editor";

type HeadersEditorProps = {
  headers: RequestHeader[];
  onHeadersChange: (headers: RequestHeader[]) => void;
};

const headerValidationMessage = "Header names may only use Latin letters, digits, and valid HTTP token symbols — without spaces.";

function createEmptyHeader(entries: KeyValueEntry[]): KeyValueEntry {
  const highestId = entries.reduce((highest, entry) => {
    const id = Number(entry.id.replace("header-", ""));
    return Number.isFinite(id) ? Math.max(highest, id) : highest;
  }, 0);

  return { id: `header-${highestId + 1}`, key: "", value: "", enabled: false };
}

export function HeadersEditor({ headers, onHeadersChange }: HeadersEditorProps) {
  const entries: KeyValueEntry[] = headers.map((header) => ({
    id: header.id,
    key: header.name,
    value: header.value,
    enabled: header.enabled,
  }));

  return (
    <KeyValueEditor
      entries={entries}
      onEntriesChange={(nextEntries) => onHeadersChange(nextEntries.map((entry) => ({
        id: entry.id,
        name: entry.key,
        value: entry.value,
        enabled: entry.enabled,
      })))}
      createEmptyEntry={createEmptyHeader}
      keyLabel="header"
      keyPlaceholder="Header-name"
      valuePlaceholder="value"
      keySuggestions={commonHttpHeaders}
      isKeyValid={isRequestHeaderNameValid}
      validationMessage={headerValidationMessage}
      valueFont="ui"
    />
  );
}
