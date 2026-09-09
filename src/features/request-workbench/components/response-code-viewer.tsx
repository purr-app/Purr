import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";

import { purrFoldGutter } from "../../../shared/theme/code-fold-gutter";
import {
  purrCodeHighlighting,
  purrCodeTheme,
} from "../../../shared/theme/code-editor-theme";

const setup = {
  lineNumbers: true,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  drawSelection: true,
  syntaxHighlighting: false,
  searchKeymap: true,
};

export function ResponseCodeViewer({
  value,
  language,
}: {
  value: string;
  language: "json" | "xml" | "text";
}) {
  const extensions = useMemo(
    () => [
      language === "json" ? json() : language === "xml" ? xml() : [],
      purrCodeHighlighting,
      purrFoldGutter,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        "aria-label": "Response body viewer",
        spellcheck: "false",
      }),
    ],
    [language],
  );

  return (
    <CodeMirror
      className="ui-response-code h-full min-h-0 min-w-0 overflow-hidden"
      value={value}
      editable={false}
      readOnly
      theme={purrCodeTheme}
      extensions={extensions}
      basicSetup={setup}
    />
  );
}
