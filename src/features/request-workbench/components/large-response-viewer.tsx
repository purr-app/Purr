import { jsonLanguage } from "@codemirror/lang-json";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Copy, Filter, Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useApplicationServices } from "../../../app/application-services-context";
import type {
  ContentOperationResult,
  LineSegment,
} from "../../../application/ports/response-content";
import type { HttpExchange, ResponseContentRef } from "../../../domain/http";
import { Button } from "../../../shared/components/ui/button";
import { Modal } from "../../../shared/components/ui/modal";
import { Input } from "../../../shared/components/ui/input";
import { SelectField } from "../../../shared/components/ui/select-field";
import { cn } from "../../../shared/lib/cn";
import { formatPayloadSize } from "../model/request-body";
import { getResponseContentType } from "../model/response";
import {
  readResponseContentPage,
  searchResponseContent,
  type ResponseContentMatch,
} from "../services/response-content-reader";

type LargeViewMode = "text" | "pretty" | "hex" | "base64";
type QueryLanguage = "jq" | "jsonpath";

const maximumLineSegments = 1000;
const automaticPrettyLimitBytes = 10 * 1024 * 1024;

function isTextual(mediaType: string) {
  return mediaType.startsWith("text/")
    || mediaType.includes("json")
    || mediaType.includes("xml")
    || mediaType.includes("yaml")
    || mediaType.includes("javascript")
    || mediaType.includes("graphql")
    || mediaType.includes("csv");
}

function structuredSyntax(mediaType: string): "json" | "xml" | "ndjson" | undefined {
  if (mediaType.includes("ndjson") || mediaType.includes("jsonl")) return "ndjson";
  if (mediaType.includes("json") || mediaType.includes("graphql")) return "json";
  if (mediaType.includes("xml")) return "xml";
  return undefined;
}

function highlightedText(value: string, query: string): ReactNode {
  const needle = query.toLocaleLowerCase();
  if (!needle) return value;
  const source = value.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = source.indexOf(needle);
  let key = 0;
  while (index >= 0) {
    parts.push(value.slice(cursor, index));
    parts.push(
      <mark
        key={`${index}-${key++}`}
        data-large-response-match
        className="bg-action-brand-surface text-content-primary"
      >
        {value.slice(index, index + query.length)}
      </mark>,
    );
    cursor = index + query.length;
    index = source.indexOf(needle, cursor);
  }
  parts.push(value.slice(cursor));
  return parts;
}

const jsonPreviewHighlighter = tagHighlighter([
  { tag: tags.propertyName, class: "text-syntax-property" },
  { tag: tags.string, class: "text-syntax-string" },
  { tag: tags.number, class: "text-syntax-number" },
  { tag: [tags.bool, tags.null], class: "text-syntax-boolean" },
  { tag: [tags.bracket, tags.punctuation], class: "text-content-tertiary" },
]);

function jsonPreviewText(value: string): ReactNode {
  // Parse only the bounded visible row, never the hidden source value.
  const prefix = /^\s*"[^"\n]*"\s*:/.test(value) ? "{" : "";
  const source = prefix + value;
  const parts: ReactNode[] = [];
  let cursor = 0;
  highlightTree(jsonLanguage.parser.parse(source), jsonPreviewHighlighter, (from, to, className) => {
    const start = Math.max(0, from - prefix.length);
    const end = Math.max(0, to - prefix.length);
    if (end <= cursor) return;
    parts.push(value.slice(cursor, start));
    parts.push(<span key={start} className={className}>{value.slice(start, end)}</span>);
    cursor = end;
  });
  parts.push(value.slice(cursor));
  return parts;
}

function segmentInlineText(value: string): LineSegment[] {
  let offset = 0;
  return value.split("\n").map((line) => {
    const byteLength = new TextEncoder().encode(line).length;
    const text = line.length > 128 ? line.slice(0, 96) : line;
    const suffix = line.length > 128 ? line.slice(-32) : undefined;
    const hiddenBytes = suffix === undefined ? undefined : byteLength - new TextEncoder().encode(text + suffix).length;
    const row = { byteOffset: offset, byteLength, text, suffix, hiddenBytes,
      lineStartOffset: offset, continuesFromPrevious: false, continuesToNext: false };
    offset += byteLength + 1;
    return row;
  });
}

function operationText(result: ContentOperationResult): string | undefined {
  if (result.kind === "window") return result.window.content;
  if (result.kind === "value") return JSON.stringify(result.value, null, 2);
  return undefined;
}

export function LargeResponseViewer({
  exchange,
  findQuery = "",
  findMatchIndex = 0,
  onFindMatchCount,
  graphql = false,
  regularExpression = false,
  onOpenFind,
}: {
  exchange: HttpExchange;
  findQuery?: string;
  findMatchIndex?: number;
  onFindMatchCount?: (count: number) => void;
  graphql?: boolean;
  regularExpression?: boolean;
  onOpenFind?: () => void;
}) {
  const { responseContent } = useApplicationServices();
  const mediaType = getResponseContentType(exchange.response.headers)
    || exchange.content.mediaType
    || "application/octet-stream";
  const text = isTextual(mediaType);
  const syntax = structuredSyntax(mediaType);
  const supportsQuery = syntax === "json" || syntax === "ndjson";
  const [mode, setMode] = useState<LargeViewMode>(text ? "text" : "hex");
  const [offset, setOffset] = useState(0);
  const [windowContent, setWindowContent] = useState("");
  const [lineSegments, setLineSegments] = useState<readonly LineSegment[]>([]);
  const [bytesRead, setBytesRead] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState<readonly ResponseContentMatch[]>([]);

  const [queryLanguage, setQueryLanguage] = useState<QueryLanguage>("jq");
  const [query, setQuery] = useState("");
  const [operationPending, setOperationPending] = useState(false);
  const [inlineResult, setInlineResult] = useState<string | null>(null);
  const [derivedReference, setDerivedReference] = useState<ResponseContentRef | null>(null);
  const [presentationLabel, setPresentationLabel] = useState("Raw");
  const [lineNextCursor, setLineNextCursor] = useState<string | undefined>();
  const [hiddenLine, setHiddenLine] = useState<LineSegment | null>(null);
  const appendRef = useRef(false);
  const [trimmed, setTrimmed] = useState(false);
  const viewerRef = useRef<HTMLDivElement>(null);
  const lineSegmentsRef = useRef(lineSegments);
  useEffect(() => { lineSegmentsRef.current = lineSegments; }, [lineSegments]);
  const operationAbortRef = useRef<AbortController | null>(null);

  const activeReference = derivedReference ?? exchange.content;
  const inlineBytes = useMemo(
    () => inlineResult === null ? undefined : new TextEncoder().encode(inlineResult).length,
    [inlineResult],
  );
  const size = inlineBytes ?? activeReference.byteLength;
  const maximumOffset = Math.max(0, size - 1);
  const pageOffset = Math.min(offset, maximumOffset);

  useEffect(() => () => {
    if (derivedReference) void responseContent.release(derivedReference).catch(() => {});
  }, [derivedReference, responseContent]);

  const cancelActiveOperation = useCallback(() => {
    operationAbortRef.current?.abort();
    operationAbortRef.current = null;
    setOperationPending(false);
  }, []);

  useEffect(() => () => {
    const operation = operationAbortRef.current;
    operationAbortRef.current = null;
    operation?.abort();
    autoFormattedId.current = null;
  }, []);

  const activateRaw = useCallback((nextMode: LargeViewMode = "text") => {
    cancelActiveOperation();
    setDerivedReference(null);
    setInlineResult(null);
    setPresentationLabel("Raw");
    setOffset(0);
    appendRef.current = false;
    setTrimmed(false);
    setMode(nextMode);
  }, [cancelActiveOperation]);

  useEffect(() => {
    cancelActiveOperation();
    setMode(text ? "text" : "hex");
    setOffset(0);
    appendRef.current = false;
    setTrimmed(false);
    setMatches([]);
    setError("");
    setQuery("");
    setInlineResult(null);
    setDerivedReference(null);
    setPresentationLabel("Raw");
  }, [cancelActiveOperation, exchange.content.id, text]);

  const acceptOperationResult = useCallback((result: ContentOperationResult, label: string) => {
    setOffset(0);
    setPresentationLabel(label);
    if (result.kind === "content") {
      setInlineResult(null);
      setDerivedReference(result.reference);
    } else {
      setDerivedReference(null);
      setInlineResult(operationText(result) ?? "");
    }
    setMode("pretty");
  }, []);

  const runFormat = useCallback(async () => {
    if (!syntax || operationPending) return;
    const abort = new AbortController();
    operationAbortRef.current?.abort();
    operationAbortRef.current = abort;
    setOperationPending(true);
    setError("");
    try {
      const result = await responseContent.format(
        exchange.content,
        { syntax, indent: 2 },
        abort.signal,
      );
      if (abort.signal.aborted) {
        if (result.kind === "content") void responseContent.release(result.reference);
        return;
      }
      acceptOperationResult(result, "Pretty");
    } catch (cause) {
      if (abort.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (operationAbortRef.current === abort) {
        operationAbortRef.current = null;
        setOperationPending(false);
      }
    }
  }, [acceptOperationResult, exchange.content, operationPending, responseContent, syntax]);

  const runQuery = useCallback(async (
    expression = query,
    language: QueryLanguage = queryLanguage,
    label = "Filtered",
  ) => {
    if (!expression.trim() || operationPending) return;
    const abort = new AbortController();
    operationAbortRef.current?.abort();
    operationAbortRef.current = abort;
    setOperationPending(true);
    setError("");
    try {
      const result = await responseContent.query(
        exchange.content,
        { language, expression },
        abort.signal,
      );
      if (abort.signal.aborted) {
        if (result.kind === "content") void responseContent.release(result.reference);
        return;
      }
      acceptOperationResult(result, label);
    } catch (cause) {
      if (abort.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (operationAbortRef.current === abort) {
        operationAbortRef.current = null;
        setOperationPending(false);
      }
    }
  }, [acceptOperationResult, exchange.content, operationPending, query, queryLanguage, responseContent]);

  const autoFormattedId = useRef<string | null>(null);
  useEffect(() => {
    if (autoFormattedId.current === exchange.content.id) return;
    autoFormattedId.current = exchange.content.id;
    if (syntax === "json" && exchange.content.byteLength <= automaticPrettyLimitBytes && !findQuery) {
      void runFormat();
    }
  }, [exchange.content, findQuery, runFormat, syntax]);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    const append = appendRef.current;
    appendRef.current = false;
    if (!append) { setTrimmed(false); setLineSegments([]); }
    setLineNextCursor(undefined);
    if ((mode === "text" || mode === "pretty") && inlineResult !== null) {
      const segments = segmentInlineText(inlineResult);
      setLineSegments(segments);
      setWindowContent("");
      setBytesRead(inlineBytes ?? 0);
      setLineNextCursor(undefined);
      setLoading(false);
      requestAnimationFrame(() => viewerRef.current?.scrollTo({ top: 0 }));
      return () => abort.abort();
    }
    const load = mode === "text" || mode === "pretty"
      ? responseContent.readLines(
        activeReference,
        `preview:${pageOffset}`,
        maximumLineSegments,
        abort.signal,
      ).then((page) => {
        if (abort.signal.aborted) return;
        const previous = lineSegmentsRef.current;
        const retained = append ? previous.slice(-2000) : [];
        const dropped = append ? previous.length - retained.length : 0;
        if (dropped) {
          setTrimmed(true);
          requestAnimationFrame(() => {
            if (viewerRef.current) viewerRef.current.scrollTop -= dropped * rowHeightRef.current;
          });
        }
        setLineSegments([...retained, ...page.segments]);
        setWindowContent("");
        setBytesRead(page.bytesRead);
        setLineNextCursor(page.nextCursor);
      })
      : readResponseContentPage(
        responseContent,
        activeReference,
        pageOffset,
        mode,
        abort.signal,
      ).then((window) => {
        if (abort.signal.aborted) return;
        setLineSegments([]);
        setWindowContent(window.content);
        setBytesRead(window.bytesRead);
        setLineNextCursor(undefined);
      });
    void load.then(() => {
      if (abort.signal.aborted) return;
      setLoading(false);
      if (!append) requestAnimationFrame(() => viewerRef.current?.scrollTo({ top: 0 }));
    }).catch((cause) => {
      if (abort.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoading(false);
    });
    return () => abort.abort();
  }, [activeReference, inlineBytes, inlineResult, mode, pageOffset, responseContent]);

  useEffect(() => {
    const abort = new AbortController();
    if (!findQuery) {
      setMatches([]);
      setSearching(false);
      onFindMatchCount?.(0);
      return () => abort.abort();
    }
    activateRaw("text");
    setSearching(true);
    setMatches([]);
    onFindMatchCount?.(0);
    void searchResponseContent(
      responseContent,
      exchange.content,
      findQuery,
      abort.signal,
      { regularExpression },
    ).then((results) => {
      if (abort.signal.aborted) return;
      setMatches(results);
      setSearching(false);
      onFindMatchCount?.(results.length);
    }).catch((cause) => {
      if (abort.signal.aborted) return;
      setSearching(false);
      setError(cause instanceof Error ? cause.message : String(cause));
      onFindMatchCount?.(0);
    });
    return () => abort.abort();
  }, [activateRaw, exchange.content, findQuery, onFindMatchCount, regularExpression, responseContent]);

  const selectedMatch = matches.length
    ? matches[((findMatchIndex % matches.length) + matches.length) % matches.length]
    : undefined;
  useEffect(() => {
    if (!selectedMatch) return;
    appendRef.current = false;
    setTrimmed(false);
    setOffset(Math.max(0, selectedMatch.byteOffset - 64));
  }, [selectedMatch]);

  const moveFirst = useCallback(() => {
    appendRef.current = false;
    setTrimmed(false);
    setOffset(0);
  }, []);

  const loadMore = useCallback(() => {
    if (loading || inlineResult !== null) return;
    const next = lineNextCursor ? Number(lineNextCursor.replace("preview:", "")) : pageOffset + bytesRead;
    if (next >= size || next <= pageOffset) return;
    appendRef.current = mode === "text" || mode === "pretty";
    setOffset(next);
  }, [bytesRead, inlineResult, lineNextCursor, loading, mode, pageOffset, size]);

  const rowHeightRef = useRef(26);
  useEffect(() => {
    if (viewerRef.current) rowHeightRef.current = Number.parseFloat(getComputedStyle(viewerRef.current).lineHeight);
  }, []);

  const virtualizer = useVirtualizer({
    count: lineSegments.length,
    getScrollElement: () => viewerRef.current,
    estimateSize: () => rowHeightRef.current,
    overscan: 20,
  });

  useEffect(() => {
    if (!selectedMatch || loading || !lineSegments.length) return;
    const index = lineSegments.findIndex((segment) =>
      selectedMatch.byteOffset >= segment.byteOffset
      && selectedMatch.byteOffset <= segment.byteOffset + segment.byteLength
    );
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
  }, [lineSegments, loading, selectedMatch, virtualizer]);

  const pageEnd = Math.min(size, pageOffset + bytesRead);

  const queryOptions = [
    { value: "jq" as const, label: "jq" },
    { value: "jsonpath" as const, label: "JSONPath" },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-purr-codefield">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-ui-2 border-b border-border-subtle bg-purr-surface p-ui-2">
        <div className="flex min-w-0 flex-wrap items-center gap-ui-2">
          <span className="rounded-ui-md bg-action-brand-surface px-ui-2 py-ui-1 font-code text-ui-xs font-medium text-action-brand">
            {syntax ? syntax.toUpperCase() : text ? "Text" : "Binary"}
          </span>
          <span className="truncate font-code text-ui-xs text-content-tertiary">{mediaType}</span>
          <div className="flex items-center gap-ui-1 rounded-ui-md bg-purr-elevated p-ui-1">
          {text ? (
            <Button type="button" size="xs" variant="ghost" weight="normal" aria-pressed={mode === "text"} className={cn(mode === "text" && "bg-purr-highlight text-content-primary")} onClick={() => activateRaw("text")}>Raw</Button>
          ) : null}
          {syntax ? (
            <Button type="button" size="xs" variant="ghost" weight="normal" aria-pressed={mode === "pretty"} disabled={operationPending} className={cn(mode === "pretty" && "bg-purr-highlight text-content-primary")} onClick={() => { void runFormat(); }}>Pretty</Button>
          ) : null}
          <Button type="button" size="xs" variant="ghost" weight="normal" aria-pressed={mode === "hex"} className={cn(mode === "hex" && "bg-purr-highlight text-content-primary")} onClick={() => activateRaw("hex")}>Hex</Button>
          <Button type="button" size="xs" variant="ghost" weight="normal" aria-pressed={mode === "base64"} className={cn(mode === "base64" && "bg-purr-highlight text-content-primary")} onClick={() => activateRaw("base64")}>Base64</Button>

        </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-ui-2" style={{ flexBasis: "var(--validation-popover-width)" }}>
      {supportsQuery ? (
        <>
          <SelectField value={queryLanguage} options={queryOptions} onValueChange={(value) => setQueryLanguage(value)} label="Large response query language" className="w-method-popover font-code" />
          <div className="relative min-w-0 flex-1 sm:max-w-validation-popover" style={{ flexBasis: "var(--method-popover-width)" }}>
            <Filter className="pointer-events-none absolute left-ui-2 top-1/2 size-ui-3 -translate-y-1/2 text-content-tertiary" aria-hidden="true" />
            <Input aria-label={`${queryLanguage} large response query`} value={query} placeholder={queryLanguage === "jq" ? ".users[0].name" : "$.users[0].name"} className="h-control-sm rounded-ui-md bg-purr-elevated pl-ui-6 font-code text-ui-sm" onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") void runQuery(); }} />
          </div>
          <Button type="button" size="xs" variant="secondary" aria-label="Run query" disabled={!query.trim() || operationPending} onClick={() => { void runQuery(); }}>Run</Button>
          {graphql ? (["data", "errors", "extensions"] as const).map((field) => (
            <Button key={field} type="button" size="xs" variant="ghost" disabled={operationPending} onClick={() => { const expression = `.${field}`; setQueryLanguage("jq"); setQuery(expression); void runQuery(expression, "jq", field[0].toUpperCase() + field.slice(1)); }}>{field[0].toUpperCase() + field.slice(1)}</Button>
          )) : null}
        </>
      ) : null}
          <Button type="button" size="xs" variant="ghost" disabled aria-label="Copy response body" title="Copy the full body is unavailable for large responses.">
            <Copy className="size-ui-3" aria-hidden="true" />
            Copy
          </Button>
      <Button type="button" size="xs" variant="ghost" aria-label="Search response" onClick={onOpenFind}><Search className="size-ui-3" /></Button>
      </div>
      </div>
      {presentationLabel !== "Raw" && presentationLabel !== "Pretty" ? <p className="m-ui-0 border-b border-border-subtle px-ui-3 py-ui-2 font-code text-ui-xs text-action-brand">Showing {presentationLabel.toLowerCase()} result.</p> : null}
      {operationPending ? <p role="status" className="m-ui-0 border-b border-border-subtle px-ui-3 py-ui-2 font-code text-ui-xs text-action-brand">Preparing response…</p> : null}
      {searching ? <p role="status" className="m-ui-0 border-b border-border-subtle px-ui-3 py-ui-2 font-code text-ui-xs text-action-brand">Searching the response…</p> : null}
      {error ? <p role="alert" className="m-ui-0 border-b border-border-subtle px-ui-3 py-ui-2 font-code text-ui-xs text-accent-red">{error}</p> : null}
      <div ref={viewerRef} aria-label="Large response body viewer" aria-busy={loading}
        onScroll={(event) => {
          const node = event.currentTarget;
          if (node.scrollTop > 0 && node.scrollHeight - node.scrollTop - node.clientHeight < rowHeightRef.current * 8) loadMore();
        }}
        className="ui-native-response min-h-0 flex-1 overflow-auto px-ui-2 py-ui-3 font-code text-content-primary">
        {trimmed ? <Button type="button" variant="ghost" size="xs" onClick={moveFirst}>Return to beginning</Button> : null}
        {loading && !lineSegments.length ? "Loading response…" : mode === "text" || mode === "pretty" ? (
          <div className="relative min-w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const segment = lineSegments[item.index];
              const match = selectedMatch && selectedMatch.byteOffset >= segment.byteOffset && selectedMatch.byteOffset < segment.byteOffset + segment.byteLength ? selectedMatch : undefined;
              const matchStart = match ? new TextDecoder().decode(new TextEncoder().encode(segment.text).slice(0, match.byteOffset - segment.byteOffset)).length : 0;
              const matchEnd = match ? new TextDecoder().decode(new TextEncoder().encode(segment.text).slice(0, match.byteOffset - segment.byteOffset + (match.byteLength ?? 1))).length : 0;
              const content = regularExpression && match
                ? <>{segment.text.slice(0, matchStart)}<mark data-large-response-match className="bg-action-brand-surface text-content-primary">{segment.text.slice(matchStart, matchEnd)}</mark>{segment.text.slice(matchEnd)}</>
                : !findQuery && mode === "pretty" && syntax === "json" ? jsonPreviewText(segment.text) : highlightedText(segment.text, regularExpression ? "" : findQuery);
              return (
                <div key={`${segment.byteOffset}-${item.index}`} data-index={item.index} data-response-line-segment className={cn("ui-native-response-line absolute left-0 top-0 flex items-baseline whitespace-pre", segment.hiddenBytes && "ui-native-response-collapsed")} style={{ transform: `translateY(${item.start}px)` }}>
                  <span aria-hidden="true" className="ui-native-response-gutter shrink-0 select-none text-right text-ui-sm text-content-quaternary">{!trimmed && lineSegments[0]?.byteOffset === 0 ? item.index + 1 : "·"}</span>
                  <span className="ui-native-response-prefix">{content}</span>
                  {segment.hiddenBytes ? <Button type="button" size="xs" variant="secondary" className="mx-ui-2 shrink-0 font-code" onClick={() => setHiddenLine(segment)}>{formatPayloadSize(segment.hiddenBytes)} hidden…</Button> : null}
                  {segment.suffix ? <span className="shrink-0">{segment.suffix}</span> : null}
                </div>
              );
            })}
          </div>
        ) : <pre className="m-ui-0 whitespace-pre font-code">{windowContent}</pre>}
        {inlineResult === null && pageEnd < size ? <Button type="button" size="xs" variant="ghost" disabled={loading} onClick={loadMore}>{loading ? "Loading…" : "Load more"}</Button> : null}
      </div>
      {hiddenLine ? <Modal title="Long line preview" onClose={() => setHiddenLine(null)}>
        <div className="space-y-ui-3 p-ui-5 text-ui-sm text-content-secondary">
          <p>{formatPayloadSize(hiddenLine.hiddenBytes ?? 0)} of this line is hidden to keep the response responsive. The original response is unchanged.</p>
          <p>Search and jq/JSONPath still use the complete response. Expanding the full line is unavailable in this beta.</p>
          <Button type="button" variant="secondary" onClick={() => setHiddenLine(null)}>Close</Button>
        </div>
      </Modal> : null}
      <span className="sr-only" aria-live="polite">
        {selectedMatch ? `Selected match at byte ${selectedMatch.byteOffset}` : ""}
        {selectedMatch?.snippet ?? ""}
      </span>
    </div>
  );
}
