import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

// All values come from the Purr theme. CodeMirror owns its layout and measurement.
export const purrCodeTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--purr-code-bg)",
      color: "var(--content-primary)",
      border: "none",
      fontSize: "var(--font-size-code)",
    },
    "&.cm-focused": { outline: "none", boxShadow: "none" },
    ".cm-scroller": {
      fontFamily: "var(--font-family-code)",
      lineHeight: "var(--line-height-code)",
      overflow: "auto",
      maxHeight: "none",
      padding: "0 var(--space-2) 0 0",
    },
    ".cm-content, .cm-gutter": { minHeight: "100%" },
    ".cm-content": {
      padding: "var(--space-3) 0 var(--space-6)",
      caretColor: "var(--content-primary)",
    },
    ".cm-line": {
      padding: "0 var(--space-2)",
      borderRadius: "0 var(--radius-md) var(--radius-md) 0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--content-primary)",
      borderLeftWidth: "var(--focus-ring-width)",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      border: "none",
      color: "var(--content-quaternary)",
      userSelect: "none",
    },
    ".cm-gutterElement": {
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "flex-end",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "var(--code-line-number-width)",
      padding: "0 var(--space-2) 0 var(--space-1)",
      fontSize: "var(--font-size-sm)",
    },
    ".cm-foldGutter .cm-gutterElement": {
      alignItems: "center",
      justifyContent: "center",
      minWidth: "var(--control-height-xs)",
      height: "var(--line-height-code)",
      padding: "0",
      color: "var(--content-tertiary)",
    },
    ".ui-code-fold": {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: "var(--control-height-xs)",
      height: "var(--line-height-code)",
    },
    ".ui-code-fold svg": {
      display: "block",
      width: "var(--space-3)",
      height: "var(--space-3)",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "var(--focus-ring-width)",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    ".cm-activeLine": { backgroundColor: "var(--editor-active-line)" },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--editor-active-line)",
      color: "var(--content-secondary)",
    },
    ".cm-gutter:first-child .cm-activeLineGutter": {
      borderRadius: "var(--radius-md) 0 0 var(--radius-md)",
    },
    ".cm-selectionBackground": {
      backgroundColor: "var(--editor-selection-inactive)",
      borderRadius: "var(--radius-sm)",
    },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
      { backgroundColor: "var(--editor-selection)" },
    ".cm-content ::selection, .cm-content::selection": {
      backgroundColor: "var(--editor-selection)",
    },
    "&.cm-focused .cm-matchingBracket": {
      backgroundColor: "var(--action-emerald-surface)",
      color: "var(--syntax-boolean)",
      outline: "none",
      borderRadius: "var(--radius-sm)",
    },
    ".cm-nonmatchingBracket": {
      color: "var(--accent-red)",
      backgroundColor: "transparent",
    },
    ".cm-selectionMatch": {
      backgroundColor: "var(--action-brand-surface)",
      borderRadius: "var(--radius-sm)",
    },
    ".cm-tooltip": {
      fontFamily: "var(--font-family-ui)",
      fontSize: "var(--font-size-sm)",
      lineHeight: "var(--line-height-lg)",
      border: "var(--border-width-hairline) solid var(--border-default)",
      borderRadius: "var(--radius-md)",
      backgroundColor: "var(--purr-overlay)",
      color: "var(--content-primary)",
      boxShadow: "var(--shadow-popover)",
      maxWidth: "var(--validation-popover-width)",
    },
    ".cm-tooltip-autocomplete > ul": {
      fontFamily: "var(--font-family-code)",
      padding: "var(--space-1)",
    },
    ".cm-tooltip-autocomplete > ul > li": {
      padding: "var(--space-1) var(--space-2)",
      borderRadius: "var(--radius-sm)",
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "var(--purr-highlight)",
      color: "var(--content-primary)",
    },
    ".cm-tooltip-lint": { padding: "var(--space-1)" },
    ".cm-diagnostic": {
      padding: "var(--space-2)",
      marginLeft: "0",
      borderLeftWidth: "var(--border-width-emphasis)",
      whiteSpace: "normal",
    },
    ".cm-diagnostic-error": { borderLeftColor: "var(--accent-red)" },
    ".cm-lintRange-error": {
      backgroundImage: "none",
      textDecoration: "underline wavy var(--accent-red)",
      textUnderlineOffset: "var(--space-1)",
    },
    ".cm-lintPoint-error::after": { borderBottomColor: "var(--accent-red)" },
    ".cm-panels": {
      fontFamily: "var(--font-family-ui)",
      fontSize: "var(--font-size-sm)",
      backgroundColor: "var(--purr-elevated)",
      color: "var(--content-secondary)",
      border: "none",
    },
    ".cm-panel.cm-search": { padding: "var(--space-2)" },
    ".cm-textfield, .cm-button": {
      font: "inherit",
      border: "var(--border-width-hairline) solid var(--border-default)",
      borderRadius: "var(--radius-sm)",
      backgroundImage: "none",
      backgroundColor: "var(--purr-surface)",
      color: "var(--content-primary)",
    },
    ".cm-searchMatch": {
      backgroundColor: "var(--action-brand-surface)",
      outline: "none",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "var(--editor-selection)",
      outline: "none",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "var(--purr-elevated)",
      border: "none",
      color: "var(--content-tertiary)",
      borderRadius: "var(--radius-sm)",
    },
  },
  { dark: true },
);

export const purrCodeHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.propertyName, color: "var(--syntax-property)" },
    { tag: tags.tagName, color: "var(--syntax-tag)" },
    { tag: tags.attributeName, color: "var(--syntax-attribute)" },
    { tag: [tags.string, tags.attributeValue], color: "var(--syntax-string)" },
    { tag: tags.content, color: "var(--content-primary)" },
    { tag: tags.number, color: "var(--syntax-number)" },
    {
      tag: [tags.bool, tags.null, tags.keyword],
      color: "var(--syntax-boolean)",
      fontWeight: "var(--font-weight-semibold)",
    },
    { tag: [tags.comment, tags.meta], color: "var(--content-tertiary)" },
    {
      tag: [tags.processingInstruction, tags.documentMeta],
      color: "var(--syntax-attribute)",
    },
    { tag: tags.character, color: "var(--syntax-string)" },
    { tag: tags.punctuation, color: "var(--content-quaternary)" },
    {
      tag: [tags.bracket, tags.angleBracket],
      color: "var(--content-tertiary)",
    },
    {
      tag: tags.invalid,
      color: "var(--accent-red)",
      textDecoration: "underline wavy var(--accent-red)",
    },
  ]),
);
