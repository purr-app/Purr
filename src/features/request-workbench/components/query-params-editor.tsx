import { createEmptyRequestQueryParam, type RequestPathParam, type RequestQueryParam } from "../model/request";
import { KeyValueEditor } from "./key-value-editor";
import type { TemplateVariableActions } from "./template-variable-popover";

type QueryParamsEditorProps = {
  pathParams: RequestPathParam[];
  onPathParamsChange: (params: RequestPathParam[]) => void;
  params: RequestQueryParam[];
  onParamsChange: (params: RequestQueryParam[]) => void;
  variableActions?: TemplateVariableActions;
};

export function QueryParamsEditor({ pathParams, onPathParamsChange, params, onParamsChange, variableActions }: QueryParamsEditorProps) {
  return (
    <>
      {pathParams.length ? (
        <KeyValueEditor
          entries={pathParams.map((param) => ({ ...param, keyReadOnly: true, deletable: false }))}
          fillHeight={false}
          onEntriesChange={(entries) => onPathParamsChange(entries.map(({ id, key, value, enabled }) => ({ id, key, value, enabled })))}
          createEmptyEntry={createEmptyRequestQueryParam}
          keyLabel="path parameter"
          title="Path params"
          keyPlaceholder="param_name"
          valuePlaceholder="value"
          keyTextClassName="text-accent-orange"
          valueFont="ui"
          variableActions={variableActions}
        />
      ) : null}
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
    </>
  );
}
