import {
  autocompletion,
  completeAnyWord,
  completeFromList,
} from "@codemirror/autocomplete";
import { json, jsonLanguage } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";
import { foldGutter } from "@codemirror/language";
import { linter } from "@codemirror/lint";
import { EditorView, tooltips } from "@codemirror/view";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import {
  purrCodeHighlighting,
  purrCodeTheme,
} from "../../../shared/theme/code-editor-theme";
import {
  getBodyDiagnostics,
  prettifyBodyCode,
  type CodeBodyLanguage,
} from "../model/request-body";

type BodyCodeEditorProps = {
  language: CodeBodyLanguage;
  value: string;
  onChange: (value: string) => void;
};
export type BodyCodeEditorHandle = {
  prettify: () => void;
  focusError: () => void;
};

const jsonKeywords = completeFromList([
  { label: "true", type: "keyword" },
  { label: "false", type: "keyword" },
  { label: "null", type: "keyword" },
]);
const setup = {
  lineNumbers: true,
  foldGutter: false,
  highlightActiveLine: true,
  highlightActiveLineGutter: true,
  drawSelection: true,
  autocompletion: false,
  lintKeymap: true,
  syntaxHighlighting: false,
};
const purrFoldGutter = foldGutter({
  markerDOM(open) {
    const marker = document.createElement("span");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "polyline",
    );
    marker.className = "ui-code-fold";
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    path.setAttribute("points", open ? "6 9 12 15 18 9" : "9 18 15 12 9 6");
    icon.append(path);
    marker.append(icon);
    marker.setAttribute("aria-hidden", "true");
    return marker;
  },
});

export const BodyCodeEditor = forwardRef<
  BodyCodeEditorHandle,
  BodyCodeEditorProps
>(function BodyCodeEditor({ language, value, onChange }, ref) {
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  useImperativeHandle(
    ref,
    () => ({
      prettify() {
        const view = editorRef.current?.view;
        if (!view || language === "text") return;
        const content = view.state.doc.toString();
        const formatted = prettifyBodyCode(language, content);
        if (formatted !== content)
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: formatted },
          });
        view.focus();
      },
      focusError() {
        const view = editorRef.current?.view;
        if (!view) return;
        const problem = getBodyDiagnostics(
          language,
          view.state.doc.toString(),
        )[0];
        if (problem)
          view.dispatch({
            selection: { anchor: problem.from, head: problem.to },
            scrollIntoView: true,
          });
        view.focus();
      },
    }),
    [language],
  );

  const extensions = useMemo(
    () => [
      language === "json"
        ? [json(), jsonLanguage.data.of({ autocomplete: jsonKeywords })]
        : language === "xml"
          ? xml()
          : [],
      purrCodeHighlighting,
      purrFoldGutter,
      EditorView.lineWrapping,
      autocompletion(
        language === "text" ? { override: [completeAnyWord] } : {},
      ),
      linter(
        (view) => getBodyDiagnostics(language, view.state.doc.toString()),
        { delay: 250 },
      ),
      tooltips({ position: "fixed" }),
      EditorView.contentAttributes.of({
        "aria-label": language.toUpperCase() + " request body",
        "aria-multiline": "true",
        spellcheck: "false",
      }),
    ],
    [language],
  );

  return (
    <CodeMirror
      ref={editorRef}
      className="ui-code-editor min-w-0"
      value={value}
      theme={purrCodeTheme}
      extensions={extensions}
      basicSetup={setup}
      onChange={onChange}
    />
  );
});
