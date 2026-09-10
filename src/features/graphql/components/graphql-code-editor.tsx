import { useEffect, useMemo, useRef } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { graphql, graphqlLanguageSupport } from "cm6-graphql";
import { acceptCompletion, autocompletion, closeCompletion, completionKeymap, completionStatus, selectedCompletionIndex, setSelectedCompletion, snippet, startCompletion, type Completion, type CompletionContext, type CompletionSource } from "@codemirror/autocomplete";
import { Prec } from "@codemirror/state";
import { json } from "@codemirror/lang-json";
import { syntaxTree } from "@codemirror/language";
import { linter } from "@codemirror/lint";
import { Decoration, EditorView, hoverTooltip, keymap, tooltips, WidgetType, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { CompletionItemKind, getAutocompleteSuggestions, getHoverInformation, Position } from "graphql-language-service";
import { getNamedType, isCompositeType, Kind, parse, type GraphQLSchema, type OperationDefinitionNode } from "graphql";
import { purrCodeTheme, purrCodeHighlighting } from "../../../shared/theme/code-editor-theme";
import { purrFoldGutter } from "../../../shared/theme/code-fold-gutter";
import { getBodyDiagnostics } from "../../request-workbench/model/request-body";

export type GraphqlOperation = {
  name: string;
  kind: "query" | "mutation" | "subscription";
  from: number;
  to: number;
};

export type OperationFocus = { name: string; nonce: number };
export type GraphqlVariableHint = {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
  defaultValue?: unknown;
  enumValues?: string[];
  shape: "string" | "number" | "boolean" | "enum" | "object" | "list";
  fields?: GraphqlVariableHint[];
  item?: GraphqlVariableHint;
};

const noVariableHints: GraphqlVariableHint[] = [];
const jsonVariablesCompletionKeymap = completionKeymap.filter((binding) => binding.key !== "Enter" && binding.key !== "Tab");
function acceptVisibleCompletion(view: EditorView) {
  if (completionStatus(view.state) !== "active") return false;
  if (selectedCompletionIndex(view.state) === null)
    view.dispatch({ effects: setSelectedCompletion(0) });
  return acceptCompletion(view);
}

function insertJsonNewline(view: EditorView) {
  const selection = view.state.selection.main;
  const line = view.state.doc.lineAt(selection.from);
  const before = view.state.doc.sliceString(line.from, selection.from);
  const after = view.state.doc.sliceString(selection.to, line.to);
  const baseIndent = line.text.match(/^\s*/)?.[0] ?? "";
  const opensContainer = /[{[]\s*$/.test(before);
  const closesContainer = /^\s*[}\]]/.test(after);
  const indent = `${baseIndent}${opensContainer ? "  " : ""}`;
  const insert = opensContainer && closesContainer
    ? `\n${indent}\n${baseIndent}`
    : `\n${indent}`;
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: { anchor: selection.from + indent.length + 1 },
    userEvent: "input",
  });
  closeCompletion(view);
  const textBeforeCursor = view.state.doc.sliceString(0, view.state.selection.main.head);
  const containers: string[] = [];
  let quoted = false;
  let escaped = false;
  for (const character of textBeforeCursor) {
    if (escaped) { escaped = false; continue; }
    if (quoted && character === "\\") { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (character === "{" || character === "[") containers.push(character);
    else if (character === "}" || character === "]") containers.pop();
  }
  if (containers[containers.length - 1] === "{" && /(?:^|[{,])\s*$/.test(textBeforeCursor))
    reopenAtCurrentSelection(view);
  return true;
}

function handleJsonEnter(view: EditorView) {
  return acceptVisibleCompletion(view) || insertJsonNewline(view);
}

function reopenAtCurrentSelection(view: EditorView) {
  const { anchor, head } = view.state.selection.main;
  globalThis.setTimeout(() => {
    const current = view.state.selection.main;
    if (view.hasFocus && current.anchor === anchor && current.head === head)
      startCompletion(view);
  }, 80);
}

export function getGraphqlOperations(query: string): GraphqlOperation[] {
  try {
    return parse(query).definitions
      .filter((node): node is OperationDefinitionNode => node.kind === Kind.OPERATION_DEFINITION && Boolean(node.name?.value) && Boolean(node.loc))
      .map((node) => ({ name: node.name!.value, kind: node.operation, from: node.loc!.start, to: node.loc!.end }));
  } catch {
    return [];
  }
}

function starterCompletion(context: CompletionContext) {
  if (!context.explicit) return null;
  const word = context.matchBefore(/[A-Za-z_]*/);
  if (!word) return null;
  const prefix = context.state.doc.sliceString(0, word.from).trimEnd();
  if (prefix && !/^(query|mutation|subscription|fragment)$/.test(prefix)) return null;
  if (prefix === "query") return { from: word.from, options: [{ label: "QueryName", detail: "operation", apply: "QueryName {\n  \n}" }] };
  if (prefix === "mutation") return { from: word.from, options: [{ label: "MutationName", detail: "operation", apply: "MutationName {\n  \n}" }] };
  if (prefix === "subscription") return { from: word.from, options: [{ label: "SubscriptionName", detail: "operation", apply: "SubscriptionName {\n  \n}" }] };
  if (prefix === "fragment") return { from: word.from, options: [{ label: "FragmentName on Type", detail: "fragment", apply: "FragmentName on Type {\n  \n}" }] };
  return { from: word.from, options: [
    { label: "query", detail: "operation", apply: "query QueryName {\n  \n}" },
    { label: "mutation", detail: "operation", apply: "mutation MutationName {\n  \n}" },
    { label: "fragment", detail: "reusable selection", apply: "fragment FragmentName on Type {\n  \n}" },
  ] };
}

function fillAllFieldsOption(fields: ReturnType<typeof getAutocompleteSuggestions>): Completion {
  return {
    label: "Fill all fields",
    detail: `${fields.length} available fields`,
    type: "text",
    boost: 1000,
    apply(view: EditorView, _completion: Completion, from: number, to: number) {
      const lineText = view.state.doc.lineAt(from).text;
      const indentation = lineText.match(/^\s*/)?.[0] ?? "";
      const insert = fields.map((item) => {
        const named = item.type ? getNamedType(item.type) : undefined;
        return named && isCompositeType(named)
          ? `${item.label} {\n${indentation}  __typename\n${indentation}}`
          : item.label;
      }).join(`\n${indentation}`);
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
    },
  };
}

function completionType(kind?: number): string {
  if (kind === CompletionItemKind.Field) return "property";
  if (kind === CompletionItemKind.Variable) return "variable";
  if (kind === CompletionItemKind.Enum || kind === CompletionItemKind.EnumMember || kind === CompletionItemKind.Value) return "constant";
  if (kind === CompletionItemKind.Keyword) return "keyword";
  if (kind === CompletionItemKind.Class || kind === CompletionItemKind.Interface || kind === CompletionItemKind.Struct) return "type";
  return "text";
}

function serviceSnippet(text: string, reopen = false): NonNullable<Completion["apply"]> {
  const apply = snippet(text.replace(/\$(\d+)/g, (_match, index: string) => `\${${index}}`));
  return (view, completion, from, to) => {
    apply(view, completion, from, to);
    if (reopen) reopenAtCurrentSelection(view);
  };
}

function jsonObjectValue(view: EditorView, _completion: Completion, from: number, to: number) {
  const line = view.state.doc.lineAt(from);
  const indentation = line.text.match(/^\s*/)?.[0] ?? "";
  const insert = `{\n${indentation}  \n${indentation}}`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + indentation.length + 4 },
  });
  reopenAtCurrentSelection(view);
}

function leafFieldAndReopen(label: string): NonNullable<Completion["apply"]> {
  return (view, _completion, from, to) => {
    const line = view.state.doc.lineAt(from);
    const indentation = line.text.match(/^\s*/)?.[0] ?? "";
    const insert = `${label}\n${indentation}`;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
    reopenAtCurrentSelection(view);
  };
}

function completionInfo(documentation?: string, deprecationReason?: string | null) {
  const text = documentation || deprecationReason;
  if (!text) return undefined;
  return () => {
    const dom = document.createElement("div");
    dom.className = "ui-graphql-completion-info";
    dom.textContent = text;
    return dom;
  };
}

function graphqlCompletionSource(schema?: GraphQLSchema): CompletionSource {
  return (context) => {
    const starter = starterCompletion(context);
    if (starter || !schema) return starter;
    const word = context.matchBefore(/[A-Za-z0-9_@$]*/);
    if (!word) return null;
    const before = context.state.doc.sliceString(0, context.pos);
    if (!context.explicit && !word.text && !/[{(\n]\s*$/.test(before)) return null;
    const line = context.state.doc.lineAt(context.pos);
    const suggestions = getAutocompleteSuggestions(schema, context.state.doc.toString(), new Position(line.number - 1, context.pos - line.from), undefined, undefined, { fillLeafsOnComplete: true });
    if (!suggestions.length) return null;
    const fields = suggestions.filter((item) => item.kind === CompletionItemKind.Field && !item.isDeprecated && !item.label.startsWith("__"));
    const options: Completion[] = !word.text && fields.length > 1 ? [fillAllFieldsOption(fields)] : [];
    options.push(...suggestions.map((item): Completion => {
      const named = item.type ? getNamedType(item.type) : undefined;
      const field = item.kind === CompletionItemKind.Field;
      const leafWithoutArguments = field && named && !isCompositeType(named) && !item.insertText?.includes("(");
      return {
        label: item.label,
        detail: item.detail || item.labelDetails?.detail || "",
        type: completionType(item.kind),
        boost: item.isDeprecated ? -100 : undefined,
        info: completionInfo(typeof item.documentation === "string" ? item.documentation : undefined, item.deprecationReason),
        apply: leafWithoutArguments ? leafFieldAndReopen(item.label)
          : item.insertText ? serviceSnippet(item.insertText, field) : item.label,
      };
    }));
    return { from: word.from, options };
  };
}

function jsonPropertyName(node: SyntaxNode, state: CompletionContext["state"]) {
  const name = node.getChild("PropertyName");
  if (!name) return undefined;
  try { return JSON.parse(state.sliceDoc(name.from, name.to)) as string; }
  catch { return state.sliceDoc(name.from, name.to).replace(/^"|"$/g, ""); }
}

function jsonObjectScope(context: CompletionContext, hints: GraphqlVariableHint[]) {
  let object: SyntaxNode | null = syntaxTree(context.state).resolveInner(context.pos, -1);
  while (object && object.name !== "Object") object = object.parent;
  if (!object) return { fields: hints, used: new Set<string>() };
  const path: string[] = [];
  for (let ancestor = object.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.name !== "Property") continue;
    const name = jsonPropertyName(ancestor, context.state);
    if (name) path.unshift(name);
  }
  let fields = hints;
  for (const name of path) {
    const hint = fields.find((item) => item.name === name);
    const target = hint?.shape === "list" ? hint.item : hint;
    fields = target?.fields ?? [];
  }
  const used = new Set<string>();
  for (let child = object.firstChild; child; child = child.nextSibling) {
    if (child.name !== "Property") continue;
    const name = jsonPropertyName(child, context.state);
    if (name) used.add(name);
  }
  return { fields, used };
}

function jsonVariablesCompletion(hints: GraphqlVariableHint[]): CompletionSource {
  return (context) => {
    const text = context.state.doc.toString();
    const before = text.slice(0, context.pos);
    const empty = !text.trim();
    if (empty) {
      if (!context.explicit || !hints.length) return null;
      return { from: 0, options: hints.map((hint) => ({
        label: hint.name,
        detail: hint.type,
        type: "property",
        apply: `{\n  "${hint.name}": \n}`,
      })) };
    }
    const keyMatch = /(?:^|[,{])\s*("?)([A-Za-z_][A-Za-z0-9_]*)?$/.exec(before);
    if (keyMatch) {
      if (!context.explicit && keyMatch[1] !== '"') return null;
      const { fields, used } = jsonObjectScope(context, hints);
      const typed = keyMatch[2] ?? "";
      const quoted = keyMatch[1] === '"';
      const from = context.pos - typed.length;
      const options = fields.filter((hint) => !used.has(hint.name) || hint.name.startsWith(typed)).map((hint) => ({
        label: hint.name,
        detail: hint.type,
        type: "property",
        apply: quoted ? `${hint.name}": ` : `"${hint.name}": `,
      }));
      return options.length ? { from, options } : null;
    }
    const valueMatch = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*("?)([^"\s,}\]]*)$/.exec(before);
    if (!valueMatch || !context.explicit) return null;
    const hint = jsonObjectScope(context, hints).fields.find((item) => item.name === valueMatch[1]);
    const typed = valueMatch[3] ?? "";
    const from = context.pos - typed.length - valueMatch[2].length;
    const options: Completion[] = [];
    if (hint?.enumValues) options.unshift(...hint.enumValues.map((value) => ({ label: value, detail: hint.type, type: "constant", apply: JSON.stringify(value) })));
    else if (hint?.shape === "boolean") options.unshift({ label: "true", detail: hint.type, type: "constant" }, { label: "false", detail: hint.type, type: "constant" });
    else if (hint?.shape === "list") options.unshift({ label: "[]", detail: hint.type, type: "text" });
    else if (hint?.shape === "object") options.unshift({ label: "{}", detail: hint.type, type: "text", apply: jsonObjectValue });
    else if (hint?.shape === "number") options.unshift({ label: "0", detail: hint.type, type: "constant" });
    else if (hint) options.unshift({ label: '"value"', detail: hint.type, type: "text" });
    if (hint?.defaultValue !== undefined) options.unshift({ label: String(hint.defaultValue), detail: "default", type: "constant", apply: JSON.stringify(hint.defaultValue) });
    return options.length ? { from, options } : null;
  };
}

function graphqlHover(schema: GraphQLSchema, onOpenType?: (name: string) => void) {
  return hoverTooltip((view, position) => {
    const line = view.state.doc.lineAt(position);
    const contents = getHoverInformation(schema, view.state.doc.toString(), new Position(line.number - 1, position - line.from));
    if (typeof contents !== "string" || !contents.trim()) return null;
    const word = view.state.wordAt(position);
    const [signature, ...description] = contents.split("\n\n");
    const signatureParts = signature.split(":");
    const typeName = signatureParts[signatureParts.length - 1]?.match(/[A-Za-z_][A-Za-z0-9_]*/)?.[0];
    return { pos: word?.from ?? position, end: word?.to, above: true, create: () => {
      const dom = document.createElement("div"); dom.className = "ui-graphql-hover";
      const title = document.createElement("div"); title.className = "ui-graphql-hover-signature"; title.textContent = signature; dom.append(title);
      if (description.length) { const docs = document.createElement("div"); docs.className = "ui-graphql-hover-docs"; docs.textContent = description.join("\n\n"); dom.append(docs); }
      if (typeName && onOpenType) { const button = document.createElement("button"); button.type = "button"; button.className = "ui-graphql-hover-link ui-focus-ring"; button.textContent = `Open ${typeName} in Schema`; button.onclick = () => onOpenType(typeName); dom.append(button); }
      return { dom };
    } };
  }, { hoverTime: 300 });
}

class OperationRunWidget extends WidgetType {
  constructor(private operation: GraphqlOperation, private run: (operation: GraphqlOperation) => void) { super(); }
  eq(other: OperationRunWidget) { return this.operation.name === other.operation.name && this.operation.kind === other.operation.kind; }
  toDOM() {
    const container = document.createElement("div");
    container.className = "flex px-ui-2 py-ui-2";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ui-focus-ring inline-flex h-control-sm items-center gap-ui-2 rounded-ui-md bg-action-graphql px-ui-2 font-code text-ui-xs text-purr-base shadow-button transition-colors duration-ui-fast hover:bg-action-graphql-hover";
    button.setAttribute("aria-label", `Send ${this.operation.kind} ${this.operation.name}`);
    button.textContent = `▶ Send ${this.operation.kind} ${this.operation.name}`;
    button.onclick = (event) => { event.preventDefault(); event.stopPropagation(); this.run(this.operation); };
    container.append(button);
    return container;
  }
  ignoreEvent() { return false; }
}

function operationActions(run: (operation: GraphqlOperation) => void) {
  return EditorView.decorations.compute(["doc"], (state) => {
    const operations = getGraphqlOperations(state.doc.toString());
    if (operations.length <= 1) return Decoration.none;
    return Decoration.set(operations.map((operation) => Decoration.widget({ widget: new OperationRunWidget(operation, run), block: true, side: -1 }).range(operation.from)), true);
  });
}

function operationAtCursor(update: ViewUpdate) {
  const operations = getGraphqlOperations(update.state.doc.toString());
  const cursor = update.state.selection.main.head;
  return operations.find((operation) => cursor >= operation.from && cursor <= operation.to);
}

export function GraphqlCodeEditor({ value, onChange, schema, variables = false, variableHints = noVariableHints, readOnly = false, label, onOpenType, onRunOperation, onCursorOperationChange, focusOperation }: {
  value: string; onChange?: (value: string) => void; schema?: GraphQLSchema; onOpenType?: (name: string) => void;
  variables?: boolean; variableHints?: GraphqlVariableHint[]; readOnly?: boolean; label: string;
  onRunOperation?: (operation: GraphqlOperation) => void;
  onCursorOperationChange?: (operation: GraphqlOperation) => void;
  focusOperation?: OperationFocus;
}) {
  const editor = useRef<ReactCodeMirrorRef>(null);
  const openType = useRef(onOpenType);
  const runOperation = useRef(onRunOperation);
  const cursorOperation = useRef(onCursorOperationChange);
  openType.current = onOpenType;
  runOperation.current = onRunOperation;
  cursorOperation.current = onCursorOperationChange;
  const extensions = useMemo(() => [
    tooltips({ parent: document.body, position: "fixed" }),
    variables ? [json(), linter((view) => getBodyDiagnostics("json", view.state.doc.toString())), autocompletion({
      override: [jsonVariablesCompletion(variableHints)], activateOnTyping: true, activateOnTypingDelay: 50,
      interactionDelay: 0, icons: false, defaultKeymap: false,
    })]
      : readOnly ? graphqlLanguageSupport() : [graphql(schema, { onShowInDocs: (_field, type) => { const name = type?.match(/[A-Za-z_][A-Za-z0-9_]*/)?.[0]; if (name) openType.current?.(name); } }),
        ...(schema ? [graphqlHover(schema, (name) => openType.current?.(name))] : []),
        autocompletion({ override: [graphqlCompletionSource(schema)], activateOnTyping: true, activateOnTypingDelay: 50,
          interactionDelay: 0, icons: false }),
        operationActions((operation) => runOperation.current?.(operation))],
    Prec.highest(keymap.of(variables ? [
      { key: "Enter", run: handleJsonEnter },
      { key: "Tab", run: acceptVisibleCompletion },
      ...jsonVariablesCompletionKeymap,
    ] : [
      { key: "Enter", run: acceptVisibleCompletion },
      { key: "Tab", run: acceptVisibleCompletion },
    ])),
    purrCodeHighlighting, purrFoldGutter, EditorView.lineWrapping,
    EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false" }),
  ], [schema, variables, variableHints, readOnly, label]);
  useEffect(() => {
    if (!focusOperation) return;
    const view = editor.current?.view;
    const operation = getGraphqlOperations(view?.state.doc.toString() ?? value).find((item) => item.name === focusOperation.name);
    if (!view || !operation) return;
    view.dispatch({ selection: { anchor: operation.from }, effects: EditorView.scrollIntoView(operation.from, { y: "center" }) });
    view.focus();
  }, [focusOperation, value]);
  return <CodeMirror ref={editor} className="ui-code-editor h-full min-h-0 min-w-0" value={value} onChange={onChange}
    onUpdate={(update) => { if (!update.selectionSet || update.docChanged) return; const operation = operationAtCursor(update); if (operation) cursorOperation.current?.(operation); }}
    theme={purrCodeTheme} extensions={extensions} readOnly={readOnly} editable={!readOnly}
    basicSetup={{ foldGutter: false, syntaxHighlighting: false, highlightActiveLine: !readOnly, highlightActiveLineGutter: !readOnly }} />;
}
