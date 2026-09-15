import { Copy } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useApplicationServices } from "../../../app/application-services-context";
import { Button } from "../../../shared/components/ui/button";
import { cn } from "../../../shared/lib/cn";
import type { HttpExchange } from "../../../domain/http";
import { formatPayloadSize } from "../model/request-body";
import { getResponseContentType } from "../model/response";
import {
  readResponseContentPage,
  responsePageBytes,
  searchResponseContent,
  type ResponseContentMatch,
} from "../services/response-content-reader";

type LargeViewMode = "text" | "hex" | "base64";

function isTextual(mediaType: string) {
  return mediaType.startsWith("text/")
    || mediaType.includes("json")
    || mediaType.includes("xml")
    || mediaType.includes("yaml")
    || mediaType.includes("javascript")
    || mediaType.includes("graphql")
    || mediaType.includes("csv");
}

function modeLabel(mode: LargeViewMode) {
  if (mode === "text") return "Raw";
  if (mode === "hex") return "Hex";
  return "Base64";
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

export function LargeResponseViewer({
  exchange,
  findQuery = "",
  findMatchIndex = 0,
  onFindMatchCount,
  graphql = false,
}: {
  exchange: HttpExchange;
  findQuery?: string;
  findMatchIndex?: number;
  onFindMatchCount?: (count: number) => void;
  graphql?: boolean;
}) {
  const { responseContent } = useApplicationServices();
  const mediaType = getResponseContentType(exchange.response.headers)
    || exchange.content.mediaType
    || "application/octet-stream";
  const text = isTextual(mediaType);
  const [mode, setMode] = useState<LargeViewMode>(text ? "text" : "hex");
  const [offset, setOffset] = useState(0);
  const [windowContent, setWindowContent] = useState("");
  const [bytesRead, setBytesRead] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState<readonly ResponseContentMatch[]>([]);
  const viewerRef = useRef<HTMLPreElement>(null);
  const size = exchange.content.byteLength;
  const maximumOffset = size
    ? Math.floor((size - 1) / responsePageBytes) * responsePageBytes
    : 0;
  const pageOffset = Math.min(offset, maximumOffset);

  useEffect(() => {
    setMode(text ? "text" : "hex");
    setOffset(0);
    setMatches([]);
    setError("");
  }, [exchange.content.id, text]);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void readResponseContentPage(
      responseContent,
      exchange.content,
      pageOffset,
      mode,
      abort.signal,
    ).then((window) => {
      setWindowContent(window.content);
      setBytesRead(window.bytesRead);
      setLoading(false);
      requestAnimationFrame(() => viewerRef.current?.scrollTo({ top: 0 }));
    }).catch((cause) => {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoading(false);
    });
    return () => abort.abort();
  }, [exchange.content, mode, pageOffset, responseContent]);

  useEffect(() => {
    const abort = new AbortController();
    if (!findQuery) {
      setMatches([]);
      setSearching(false);
      onFindMatchCount?.(0);
      return () => abort.abort();
    }
    setMode("text");
    setSearching(true);
    setMatches([]);
    onFindMatchCount?.(0);
    void searchResponseContent(
      responseContent,
      exchange.content,
      findQuery,
      abort.signal,
    ).then((results) => {
      setMatches(results);
      setSearching(false);
      onFindMatchCount?.(results.length);
    }).catch((cause) => {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setSearching(false);
      setError(cause instanceof Error ? cause.message : String(cause));
      onFindMatchCount?.(0);
    });
    return () => abort.abort();
  }, [exchange.content, findQuery, onFindMatchCount, responseContent]);

  const selectedMatch = matches.length
    ? matches[((findMatchIndex % matches.length) + matches.length) % matches.length]
    : undefined;
  useEffect(() => {
    if (!selectedMatch) return;
    const aligned = Math.floor(selectedMatch.byteOffset / responsePageBytes) * responsePageBytes;
    setOffset(Math.min(aligned, maximumOffset));
  }, [maximumOffset, selectedMatch]);

  useEffect(() => {
    if (!selectedMatch || loading) return;
    requestAnimationFrame(() => {
      const marks = viewerRef.current?.querySelectorAll("[data-large-response-match]");
      if (!marks?.length) return;
      const target = [...marks].find((mark) => {
        const value = mark.textContent ?? "";
        return value.toLocaleLowerCase() === findQuery.toLocaleLowerCase();
      });
      target?.scrollIntoView({ block: "center" });
    });
  }, [findQuery, loading, selectedMatch, windowContent]);

  const pageEnd = Math.min(size, pageOffset + bytesRead);
  const pageNumber = Math.floor(pageOffset / responsePageBytes) + 1;
  const pageCount = Math.max(1, Math.ceil(size / responsePageBytes));
  const rendered = useMemo(
    () => mode === "text" ? highlightedText(windowContent, findQuery) : windowContent,
    [findQuery, mode, windowContent],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-purr-codefield">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-ui-2 border-b border-border-subtle bg-purr-surface p-ui-2">
        <div className="flex min-w-0 flex-wrap items-center gap-ui-2">
          <span className="rounded-ui-md bg-action-brand-surface px-ui-2 py-ui-1 font-code text-ui-xs font-medium text-action-brand">
            {text ? "Large text" : "Large binary"}
          </span>
          <span className="truncate font-code text-ui-xs text-content-tertiary">{mediaType}</span>
          <span className="font-code text-ui-xs text-content-tertiary">Bounded preview</span>
          {graphql ? <span className="font-code text-ui-xs text-content-tertiary">Structured GraphQL tabs are available for responses smaller than 1 MiB.</span> : null}
        </div>
        <div className="flex items-center gap-ui-1 rounded-ui-md bg-purr-elevated p-ui-1">
          {(text ? ["text", "hex", "base64"] as const : ["hex", "base64"] as const).map((option) => (
            <Button
              key={option}
              type="button"
              size="xs"
              variant="ghost"
              weight="normal"
              aria-pressed={mode === option}
              className={cn(mode === option ? "bg-purr-highlight text-content-primary" : "text-content-tertiary")}
              onClick={() => setMode(option)}
            >
              {modeLabel(option)}
            </Button>
          ))}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled
            title="Copy the full body is unavailable for large responses."
          >
            <Copy className="size-ui-3" aria-hidden="true" />
            Copy unavailable
          </Button>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-ui-2 border-b border-border-subtle bg-purr-surface px-ui-2 py-ui-1">
        <Button type="button" size="xs" variant="ghost" disabled={pageOffset === 0} onClick={() => setOffset(0)}>First</Button>
        <Button type="button" size="xs" variant="ghost" disabled={pageOffset === 0} onClick={() => setOffset(Math.max(0, pageOffset - responsePageBytes))}>Previous</Button>
        <input
          aria-label="Response position"
          className="ui-focus-ring min-w-0 flex-1 accent-action-brand"
          type="range"
          min={0}
          max={maximumOffset}
          step={responsePageBytes}
          value={pageOffset}
          onChange={(event) => setOffset(Number(event.currentTarget.value))}
        />
        <Button type="button" size="xs" variant="ghost" disabled={pageEnd >= size} onClick={() => setOffset(Math.min(maximumOffset, pageOffset + responsePageBytes))}>Next</Button>
        <Button type="button" size="xs" variant="ghost" disabled={pageEnd >= size} onClick={() => setOffset(maximumOffset)}>Last</Button>
        <span className="font-code text-ui-xs text-content-tertiary">
          Page {pageNumber}/{pageCount} · {formatPayloadSize(pageOffset)}–{formatPayloadSize(pageEnd)} of {formatPayloadSize(size)}
        </span>
      </div>
      {searching ? <p role="status" className="m-ui-0 border-b border-border-subtle px-ui-3 py-ui-2 font-code text-ui-xs text-action-brand">Searching the response in bounded windows…</p> : null}
      {error ? <p role="alert" className="m-ui-0 border-b border-border-subtle px-ui-3 py-ui-2 font-code text-ui-xs text-accent-red">{error}</p> : null}
      <pre
        ref={viewerRef}
        aria-label="Large response body viewer"
        aria-busy={loading}
        className="m-ui-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-ui-3 font-code text-ui-xs text-content-secondary"
      >
        {loading ? "Loading response window…" : rendered}
      </pre>
      <span className="sr-only" aria-live="polite">
        {selectedMatch ? `Selected match at byte ${selectedMatch.byteOffset}` : ""}
        {selectedMatch?.snippet ?? ""}
      </span>
    </div>
  );
}
