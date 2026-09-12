import { createEmptyRequestQueryParam, type RequestQueryParam } from "../model/request";
import { KeyValueEditor } from "./key-value-editor";
import type { TemplateVariableActions } from "./template-variable-popover";

type QueryParamsEditorProps = {
  params: RequestQueryParam[];
  onParamsChange: (params: RequestQueryParam[]) => void;
  variableActions?: TemplateVariableActions;
};

export function QueryParamsEditor({ params, onParamsChange, variableActions }: QueryParamsEditorProps) {
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
      variableActions={variableActions}
    />
  );
}
