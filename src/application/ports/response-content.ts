import type { ResponseContentRef } from "../../domain/http";

export type ByteRange = { offset: number; length: number };
export type ContentWindow = {
  offset: number;
  bytesRead: number;
  content: string;
  complete: boolean;
};
export type ContentInfo = {
  size: number;
  mediaType?: string;
  textEncoding?: string;
};
export type LineCursor = string;
export type LinePage = {
  lines: readonly string[];
  nextCursor?: LineCursor;
  complete: boolean;
};
export type SearchQuery = {
  text: string;
  caseSensitive?: boolean;
  regularExpression?: boolean;
};
export type SearchCursor = string;
export type SearchMatch = {
  byteOffset: number;
  line?: number;
  snippet: string;
};
export type SearchPage = {
  matches: readonly SearchMatch[];
  nextCursor?: SearchCursor;
  totalKnown?: number;
};
export type FormatRequest = {
  syntax: "json" | "xml";
  indent: number;
};
export type JsonQueryRequest = {
  language: "jq" | "jsonpath";
  expression: string;
};
export type SaveSuggestion = {
  fileName: string;
  mediaType: string;
};
export type ContentOperationResult =
  | { kind: "value"; value: unknown }
  | { kind: "window"; window: ContentWindow }
  | { kind: "content"; reference: ResponseContentRef };

// Phase 5 supplies the first native implementation. Defining the consumer
// contract here keeps response handles out of Tauri adapter DTOs and UI code.
export interface ResponseContentPort {
  inspect(
    reference: ResponseContentRef,
    signal?: AbortSignal,
  ): Promise<ContentInfo>;
  readRange(
    reference: ResponseContentRef,
    range: ByteRange,
    mode: "bytes" | "text" | "hex" | "base64",
    signal?: AbortSignal,
  ): Promise<ContentWindow>;
  readLines(
    reference: ResponseContentRef,
    cursor: LineCursor | undefined,
    limit: number,
    signal?: AbortSignal,
  ): Promise<LinePage>;
  search(
    reference: ResponseContentRef,
    query: SearchQuery,
    cursor?: SearchCursor,
    signal?: AbortSignal,
  ): Promise<SearchPage>;
  format(
    reference: ResponseContentRef,
    request: FormatRequest,
    signal?: AbortSignal,
  ): Promise<ContentOperationResult>;
  query(
    reference: ResponseContentRef,
    request: JsonQueryRequest,
    signal?: AbortSignal,
  ): Promise<ContentOperationResult>;
  save(
    reference: ResponseContentRef,
    suggestion: SaveSuggestion,
  ): Promise<string | null>;
  release(reference: ResponseContentRef): Promise<void>;
}
