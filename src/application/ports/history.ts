import type { StoredHttpResponse } from "../../domain/http";

export type HistoryOutcome = "response" | "error" | "cancelled";
export type HistorySummary = {
  id: string;
  documentId: string;
  name: string;
  kind: "http" | "graphql";
  method: string;
  url: string;
  startedAt: number;
  durationMs: number;
  outcome: HistoryOutcome;
  status: number | null;
  size: number;
  pinned: boolean;
};
export type HistoryEntry = HistorySummary & {
  version: 1;
  editor: unknown;
  response: StoredHttpResponse | null;
  error: string;
  files: Record<string, unknown>;
};
export type HistoryQuery = { documentId?: string; cursor?: { startedAt: number; id: string }; limit?: number; search?: string };
export type HistoryPage = { items: HistorySummary[]; cursor: HistoryQuery["cursor"] | null };
export interface HistoryPort {
  append(workspaceId: string, entry: HistoryEntry): Promise<void>;
  list(workspaceId: string, query: HistoryQuery): Promise<HistoryPage>;
  read(workspaceId: string, id: string): Promise<HistoryEntry | null>;
  existing(workspaceId: string, ids: string[]): Promise<string[]>;
  remove(workspaceId: string, filter: { id?: string; documentId?: string }): Promise<void>;
  pin(workspaceId: string, id: string, pinned: boolean): Promise<void>;
  settings(workspaceId: string, retentionDays?: number): Promise<{ retentionDays: number }>;
  prune(workspaceId: string): Promise<void>;
  readAttachment?(workspaceId: string, id: string): Promise<Uint8Array>;
}
