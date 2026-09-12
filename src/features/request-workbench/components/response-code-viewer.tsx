import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";

import { cn } from "../../../shared/lib/cn";
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
  ariaLabel = "Response body viewer",
  onLineContextMenu,
}: {
  value: string;
  language: "json" | "xml" | "text";
  ariaLabel?: string;
  onLineContextMenu?: (value: { line: number; text: string; x: number; y: number }) => void;
}) {
  const extensions = useMemo(
    () => [
      language === "json" ? json() : language === "xml" ? xml() : [],
      purrCodeHighlighting,
      purrFoldGutter,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        "aria-label": ariaLabel,
        spellcheck: "false",
      }),
      onLineContextMenu ? EditorView.domEventHandlers({
        contextmenu(event, view) {
          const lineElement = (event.target as Element | null)?.closest(".cm-line");
          if (!lineElement) return false;
          const lines = [...view.dom.querySelectorAll(".cm-line")];
          const line = lines.indexOf(lineElement) + 1;
          if (!line) return false;
          event.preventDefault();
          onLineContextMenu({ line, text: view.state.doc.line(line).text, x: event.clientX, y: event.clientY });
          return true;
        },
      }) : [],
    ],
    [ariaLabel, language, onLineContextMenu],
  );

  return (
    <CodeMirror
      className={cn("ui-response-code h-full min-h-0 min-w-0 overflow-hidden", onLineContextMenu && "ui-response-context-lines")}
      value={value}
      editable={false}
      readOnly
      theme={purrCodeTheme}
      extensions={extensions}
      basicSetup={setup}
    />
  );
}
