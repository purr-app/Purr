import type { SecretFieldState } from "../../../application/ports/credentials";
import { useTemplateVariableActions } from "../../../shared/components/ui/template-variable-context";
import { useId } from "react";
import { Button } from "../../../shared/components/ui/button";
import { SecretInput } from "../../../shared/components/ui/secret-input";
import { TemplateInput } from "../../../shared/components/ui/template-input";
import { templateTokens } from "../../../shared/lib/template-tokens";
import { TemplateVariablePopover, type TemplateVariableActions } from "./template-variable-popover";

export function AuthVariableField({ label, value, placeholder, secret = false, secretVariablesOnly = false, variableActions, state, onChange }: {
  state?: SecretFieldState;
  label: string; value: string; placeholder?: string; secret?: boolean;
  /** Suggest encrypted storage for credentials, without excluding ordinary variables. */
  secretVariablesOnly?: boolean;
  variableActions?: TemplateVariableActions;
  onChange: (value: string) => void;
}) {
  const inheritedActions = useTemplateVariableActions();
  variableActions ??= inheritedActions;
  const id = useId();
  const credential = secret || secretVariablesOnly;
  const actions = variableActions && credential ? {
    ...variableActions,
    onCreateMissingVariable: (name: string, kind: "static" | "dynamic-request") => variableActions.onCreateMissingVariable(name, kind, true),
  } : variableActions;
  const plainVariables = variableActions?.definitions.filter((variable) => !variable.sensitive && templateTokens(value).some((token) => token.name === variable.name)) ?? [];
  const Control = secret ? SecretInput : TemplateInput;
  const render = (bindings?: Parameters<Parameters<typeof TemplateVariablePopover>[0]["children"]>[0]) => <Control
    {...bindings} {...(secret ? { templateVariables: true } : {})} id={id} aria-label={label} value={value} placeholder={state && state.status !== "available" && state.edit?.kind !== "set" ? `Local secret ${state.status}` : placeholder}
    aria-describedby={credential && plainVariables.length ? `${id}-warning` : undefined}
    onChange={bindings?.onChange ?? ((event) => onChange(event.target.value))}
    className="ui-focus-ring bg-purr-elevated font-code" autoComplete="off" spellCheck={false} />;
  return <div className="min-w-0 space-y-ui-2">
    <label htmlFor={id} className="block text-ui-xs font-medium text-content-secondary">{label}</label>
    {actions ? <TemplateVariablePopover value={value} onValueChange={onChange} actions={actions}>{render}</TemplateVariablePopover> : render()}
    {state && state.status !== "available" && state.edit?.kind !== "set" ? <p role="status" className="m-ui-0 text-ui-xs text-accent-orange">Local secret {state.status}. Provide a value here or open Required local secrets.</p> : null}
    {credential && plainVariables.length ? <div id={`${id}-warning`} role="status" className="text-ui-xs text-accent-orange">
      Use an encrypted variable for credentials. {plainVariables.map((variable) => <Button key={variable.id} type="button" size="sm" variant="ghost" className="font-code text-accent-orange" onClick={() => variableActions?.onOpenVariable(variable.id)}>{`{{${variable.name}}}`}</Button>)}
    </div> : null}
  </div>;
}
