import { createEmptyRequestQueryParam, type RequestQueryParam } from "../model/request";
import { KeyValueEditor } from "./key-value-editor";

type QueryParamsEditorProps = {
  params: RequestQueryParam[];
  onParamsChange: (params: RequestQueryParam[]) => void;
};

export function QueryParamsEditor({ params, onParamsChange }: QueryParamsEditorProps) {
  return (
    <KeyValueEditor
      entries={params}
      onEntriesChange={onParamsChange}
      createEmptyEntry={createEmptyRequestQueryParam}
      keyLabel="query parameter"
      title="Query params"
      keyPlaceholder="params_name"
      valuePlaceholder="value"
      keyTextClassName="text-accent-orange"
      valueFont="ui"
    />
  );
}
