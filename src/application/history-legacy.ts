import { isInlineHttpResponse, restoreStoredHttpResponse } from "../domain/http";
import type { HistoryEntry } from "./ports/history";

/** Older executions retained the sent request, but not its editable templates. */
export function legacyHistoryEntry(id: string, value: unknown): HistoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<HistoryEntry>;
  const response = restoreStoredHttpResponse(record.response);
  if (!response || typeof record.documentId !== "string") return null;
  const metadata = isInlineHttpResponse(response) ? response : response.response;
  return { version: 1, id, documentId: record.documentId, name: record.name ?? "", kind: record.kind ?? "http",
    method: response.timeline.request.method, url: response.timeline.displayRequest?.url ?? response.timeline.request.url,
    startedAt: response.timeline.startedAtMs, durationMs: metadata.durationMs,
    outcome: "response", status: metadata.status, size: isInlineHttpResponse(response) ? response.size : response.content.byteLength,
    pinned: false, editor: record.editor ?? null, response, error: "", files: record.files ?? {} };
}
