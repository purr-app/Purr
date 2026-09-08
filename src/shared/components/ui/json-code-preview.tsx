import { json } from "@codemirror/lang-json";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import {
  purrCodeHighlighting,
  purrCodeTheme,
} from "../../theme/code-editor-theme";

const previewTheme = EditorView.theme({
  ".cm-content, .cm-gutter": { minHeight: "0" },
  ".cm-content": { padding: "var(--space-2) 0" },
  ".cm-scroller": { maxHeight: "var(--auth-preview-max-height)" },
});

const setup = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  drawSelection: false,
  syntaxHighlighting: false,
};

export function JsonCodePreview({
  value,
  label,
}: {
  value: unknown;
  label: string;
}) {
  return (
    <CodeMirror
      className="ui-json-preview min-h-0 flex-1 overflow-hidden rounded-ui-lg"
      value={JSON.stringify(value, null, 2)}
      editable={false}
      readOnly
      theme={[purrCodeTheme, previewTheme]}
      extensions={[
        json(),
        purrCodeHighlighting,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": label }),
      ]}
      basicSetup={setup}
    />
  );
}
