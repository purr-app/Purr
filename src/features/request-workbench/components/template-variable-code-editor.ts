import type { Completion, CompletionSource } from "@codemirror/autocomplete";
import { hoverTooltip } from "@codemirror/view";

import type { TemplateVariableActions } from "./template-variable-popover";

function typeLabel(type: string) {
  return type === "dynamic-request" ? "Dynamic Request" : type === "external-secret" ? "External Secret" : "Static";
}

export function templateVariableCompletion(actions: TemplateVariableActions): CompletionSource {
  return (context) => {
    const match = /{{\s*([A-Za-z_][A-Za-z0-9_]*)?$/.exec(context.state.doc.sliceString(0, context.pos));
    if (!match) return null;
    const typed = match[1] ?? "";
    const from = context.pos - typed.length;
    const close = context.state.doc.sliceString(context.pos, context.pos + 2) === "}}" ? "" : "}}";
    const options: Completion[] = actions.definitions.filter((variable) => variable.enabled && variable.name.toLowerCase().includes(typed.toLowerCase())).map((variable) => ({
      label: variable.name,
      detail: typeLabel(variable.kind),
      type: "variable",
      apply: `${variable.name}${close}`,
    }));
    if (typed && !actions.definitions.some((variable) => variable.name === typed)) options.push(
      { label: `Create environment variable “${typed}”`, detail: "Variable", type: "text", apply(view, _completion, start, to) {
        view.dispatch({ changes: { from: start, to, insert: `${typed}${close}` } }); actions.onCreateMissingVariable(typed, "static");
      } },
      { label: `Create dynamic variable “${typed}”`, detail: "Dynamic", type: "text", apply(view, _completion, start, to) {
        view.dispatch({ changes: { from: start, to, insert: `${typed}${close}` } }); actions.onCreateMissingVariable(typed, "dynamic-request");
      } },
    );
    return options.length ? { from, options, validFor: /^[A-Za-z_][A-Za-z0-9_]*$/ } : null;
  };
}

export function templateVariableHover(actions: TemplateVariableActions) {
  return hoverTooltip((view, position) => {
    const text = view.state.doc.toString();
    const matches = [...text.matchAll(/{{\s*([^{}]+?)\s*}}/g)];
    const match = matches.find((candidate) => position >= candidate.index! && position <= candidate.index! + candidate[0].length);
    if (!match) return null;
    const name = match[1].trim();
    const variable = actions.definitions.find((candidate) => candidate.name === name);
    return { pos: match.index!, end: match.index! + match[0].length, above: true, create: () => {
      const dom = document.createElement("div"); dom.className = "rounded-ui-md border border-border bg-purr-overlay p-ui-2 font-ui text-ui-sm text-content-secondary shadow-popover";
      const title = document.createElement("div"); title.className = variable ? "font-code text-syntax-property" : "font-code text-accent-orange";
      title.textContent = `{{${name}}}`; dom.append(title);
      const description = document.createElement("p"); description.className = "mb-ui-0 mt-ui-1 text-ui-xs text-content-tertiary";
      description.textContent = variable ? `${typeLabel(variable.kind)} variable` : "Undefined variable"; dom.append(description);
      const actionsRow = document.createElement("div"); actionsRow.className = "mt-ui-2 flex gap-ui-1";
      const button = (label: string, run: () => void) => { const element = document.createElement("button"); element.type = "button"; element.className = "ui-focus-ring h-control-sm rounded-ui-md px-ui-2 text-ui-xs text-content-secondary hover:bg-purr-highlight hover:text-content-primary"; element.textContent = label; element.onclick = run; actionsRow.append(element); };
      if (variable) button("Go to definition", () => actions.onOpenVariable(variable.id));
      else { button("Create environment variable", () => actions.onCreateMissingVariable(name, "static")); button("Create dynamic variable", () => actions.onCreateMissingVariable(name, "dynamic-request")); }
      dom.append(actionsRow); return { dom };
    } };
  }, { hoverTime: 300 });
}
