import { Braces, Plus } from "lucide-react";
import { useRef, useState, type ChangeEvent, type KeyboardEvent, type MouseEvent, type ReactElement, type Ref } from "react";

import { Button } from "../../../shared/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "../../../shared/components/ui/popover";
import type { Variable } from "../../workspaces/model/workspace";

type InputBindings = {
  ref: Ref<HTMLInputElement>;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onClick: (event: MouseEvent<HTMLInputElement>) => void;
  onKeyUp: (event: KeyboardEvent<HTMLInputElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
};

export type TemplateVariableActions = {
  definitions: readonly Variable[];
  onOpenVariable: (id: string) => void;
  onCreateMissingVariable: (name: string, kind: "static" | "dynamic-request", sensitive?: boolean) => void;
};

type Token = { start: number; end: number; name: string; complete: boolean };

function tokenAt(value: string, caret: number | null): Token | null {
  if (caret === null) return null;
  const start = value.lastIndexOf("{{", caret);
  if (start < 0 || value.lastIndexOf("}}", caret) > start) return null;
  const close = value.indexOf("}}", start + 2);
  const end = close >= 0 ? close + 2 : caret;
  if (close >= 0 && caret > end) return null;
  return { start, end, name: value.slice(start + 2, close >= 0 ? close : caret).trim(), complete: close >= 0 };
}

function sourceLabel(variable: Variable) {
  return variable.kind === "dynamic-request" ? "Dynamic Request" : variable.kind === "external-secret" ? "External Secret" : "Static";
}

export function TemplateVariablePopover({ value, onValueChange, actions, inputRef, children }: {
  value: string;
  onValueChange: (value: string) => void;
  actions: TemplateVariableActions;
  inputRef?: Ref<HTMLInputElement>;
  children: (bindings: InputBindings) => ReactElement;
}) {
  const ownRef = useRef<HTMLInputElement>(null);
  const [token, setToken] = useState<Token | null>(null);
  const [active, setActive] = useState(0);
  const inspect = (next: string, caret: number | null) => { setToken(tokenAt(next, caret)); setActive(0); };
  const variable = token ? actions.definitions.find((candidate) => candidate.name === token.name) : undefined;
  const suggestions = token && !token.complete ? actions.definitions.filter((candidate) => candidate.enabled
    && candidate.name.toLowerCase().includes(token.name.toLowerCase())).slice(0, 8) : [];
  const choose = (name: string) => {
    if (!token) return;
    const next = `${value.slice(0, token.start)}{{${name}}}${value.slice(token.end)}`;
    onValueChange(next); setToken(null);
    requestAnimationFrame(() => { const caret = token.start + name.length + 4; ownRef.current?.focus(); ownRef.current?.setSelectionRange(caret, caret); });
  };
  const assignRef = (node: HTMLInputElement | null) => {
    ownRef.current = node;
    if (typeof inputRef === "function") inputRef(node);
    else if (inputRef) inputRef.current = node;
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!suggestions.length) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => (index + 1) % suggestions.length); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => (index + suggestions.length - 1) % suggestions.length); }
    else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); choose(suggestions[active]?.name ?? suggestions[0].name); }
    else if (event.key === "Escape") { event.preventDefault(); setToken(null); }
  };
  const open = Boolean(token && (token.complete || suggestions.length));
  return <Popover open={open} onOpenChange={(next) => { if (!next) setToken(null); }}>
    <PopoverAnchor asChild>{children({
      ref: assignRef,
      onChange: (event) => { onValueChange(event.target.value); inspect(event.target.value, event.target.selectionStart); },
      onClick: (event) => inspect(event.currentTarget.value, event.currentTarget.selectionStart),
      onKeyUp: (event) => { if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) inspect(event.currentTarget.value, event.currentTarget.selectionStart); },
      onKeyDown: keyDown,
    })}</PopoverAnchor>
    <PopoverContent align="start" side="bottom" sideOffset={4} className="ui-popover-match-anchor z-50 rounded-ui-lg border border-border bg-purr-overlay p-ui-1 shadow-popover" onOpenAutoFocus={(event) => event.preventDefault()}>
      {suggestions.map((candidate, index) => <Button type="button" key={candidate.id} variant="ghost" className={index === active ? "w-full justify-start bg-purr-highlight font-code" : "w-full justify-start font-code"} onMouseDown={(event) => { event.preventDefault(); choose(candidate.name); }}><Braces className="size-ui-4 text-action-brand" />{candidate.name}<span className="ml-auto text-ui-xs text-content-tertiary">{sourceLabel(candidate)}</span></Button>)}
      {variable ? <><div className="px-ui-3 py-ui-2"><p className="m-ui-0 font-code text-ui-sm text-syntax-property">{variable.name}</p><p className="mb-ui-0 mt-ui-1 text-ui-xs text-content-tertiary">{variable.kind === "dynamic-request" ? "Resolved from a saved request before Send" : variable.sensitive ? "Encrypted local value" : "Static value"}</p></div><Button type="button" variant="ghost" className="w-full justify-start" onClick={() => { actions.onOpenVariable(variable.id); setToken(null); }}>Go to definition</Button></>
        : token?.complete && token.name ? <><p className="m-ui-0 px-ui-3 py-ui-2 font-code text-ui-xs text-accent-orange">{`{{${token.name}}}`} is not defined</p><Button type="button" variant="ghost" className="w-full justify-start" onClick={() => { actions.onCreateMissingVariable(token.name, "static"); setToken(null); }}><Plus className="size-ui-4" />Create environment variable</Button><Button type="button" variant="ghost" className="w-full justify-start" onClick={() => { actions.onCreateMissingVariable(token.name, "dynamic-request"); setToken(null); }}><Plus className="size-ui-4" />Create dynamic variable</Button></> : null}
    </PopoverContent>
  </Popover>;
}
