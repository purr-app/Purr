import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";
import { StreamLanguage } from "@codemirror/language";
import { SearchQuery, closeSearchPanel, openSearchPanel, search, setSearchQuery } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef } from "react";

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

const responseSearch = search({
  createPanel: () => ({ dom: document.createElement("div"), top: true }),
});

const yamlLanguage = StreamLanguage.define({
  name: "yaml",
  token(stream) {
    if (stream.match(/#.*/)) return "comment";
    if (stream.sol() && stream.match(/(?:---|\.\.\.)(?:\s|$)/)) return "meta";
    if (stream.match(/"(?:[^"\\]|\\.)*"|'[^']*'/)) return "string";
    if (stream.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?\b/i)) return "number";
    if (stream.match(/(?:true|false|null|~)\b/i)) return "bool";
    if (stream.match(/[A-Za-z_][\w.-]*(?=\s*:)/)) return "propertyName";
    if (stream.match(/[:\[\]{},-]/)) return "punctuation";
    stream.next();
    return null;
  },
});

const csvLanguage = StreamLanguage.define({
  name: "csv",
  token(stream) {
    if (stream.match(/"(?:[^"]|"")*"/)) return "string";
    if (stream.match(/[-+]?\d+(?:\.\d+)?\b/)) return "number";
    if (stream.match(/,/)) return "punctuation";
    if (stream.match(/[^,\r\n]+/)) return "string";
    stream.next();
    return null;
  },
});

const ndjsonLanguage = StreamLanguage.define({
  name: "ndjson",
  token(stream) {
    if (stream.match(/"(?:[^"\\]|\\.)*"(?=\s*:)/)) return "propertyName";
    if (stream.match(/"(?:[^"\\]|\\.)*"/)) return "string";
    if (stream.match(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?\b/i)) return "number";
    if (stream.match(/(?:true|false|null)\b/)) return "bool";
    if (stream.match(/[{}\[\],:]/)) return "punctuation";
    stream.next();
    return null;
  },
});

export function ResponseCodeViewer({
  value,
  language,
  ariaLabel = "Response body viewer",
  onLineContextMenu,
  findQuery = "",
  findMatchIndex = 0,
  onFindMatchCount,
}: {
  value: string;
  language: "json" | "ndjson" | "yaml" | "csv" | "xml" | "text";
  ariaLabel?: string;
  onLineContextMenu?: (value: { line: number; text: string; x: number; y: number }) => void;
  findQuery?: string;
  findMatchIndex?: number;
  onFindMatchCount?: (count: number) => void;
}) {
  const editorRef = useRef<EditorView | null>(null);
  const extensions = useMemo(
    () => [
      language === "json" ? json()
        : language === "ndjson" ? ndjsonLanguage
          : language === "yaml" ? yamlLanguage
            : language === "csv" ? csvLanguage
              : language === "xml" ? xml() : [],
      purrCodeHighlighting,
      purrFoldGutter,
      responseSearch,
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

  useEffect(() => {
    const view = editorRef.current;
    if (!view) return;
    const searchQuery = new SearchQuery({ search: findQuery });
    if (!findQuery) {
      onFindMatchCount?.(0);
      view.dispatch({ effects: setSearchQuery.of(searchQuery) });
      closeSearchPanel(view);
      return;
    }
    const cursor = searchQuery.getCursor(view.state);
    const matches: Array<{ from: number; to: number }> = [];
    for (let result = cursor.next(); !result.done; result = cursor.next())
      matches.push(result.value);
    onFindMatchCount?.(matches.length);
    openSearchPanel(view);
    if (!matches.length) {
      view.dispatch({ effects: setSearchQuery.of(searchQuery) });
      return;
    }
    const match = matches[((findMatchIndex % matches.length) + matches.length) % matches.length];
    view.dispatch({
      effects: setSearchQuery.of(searchQuery),
      selection: { anchor: match.from, head: match.to },
      scrollIntoView: true,
    });
  }, [findMatchIndex, findQuery, onFindMatchCount, value]);

  return (
    <CodeMirror
      className={cn("ui-response-code h-full min-h-0 min-w-0 overflow-hidden", onLineContextMenu && "ui-response-context-lines")}
      value={value}
      editable={false}
      readOnly
      theme={purrCodeTheme}
      extensions={extensions}
      basicSetup={setup}
      onCreateEditor={(view) => {
        editorRef.current = view;
      }}
    />
  );
}
