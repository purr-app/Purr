import type { HistoryEntry, HistoryPort, HistoryQuery, HistorySummary } from "../application/ports/history";
import type { LocalRecord } from "../application/ports/persistence";
import { legacyHistoryEntry } from "../application/history-legacy";

/** Encrypted browser-preview storage. Desktop uses native indexed metadata. */
export type BrowserHistoryStorage = {
  read<T>(key: string): Promise<T | undefined>;
  write(changes: { key: string; value?: unknown }[]): Promise<void>;
  legacy(workspaceId: string): Promise<LocalRecord[]>;
  finishLegacy?(workspaceId: string): Promise<void>;
  deleteSecrets(prefix: string): Promise<void>;
};
const prefix = (workspaceId: string) => `history/${workspaceId}/`;
const indexKey = (workspaceId: string) => `${prefix(workspaceId)}index`;
const entryKey = (workspaceId: string, id: string) => `${prefix(workspaceId)}entry/${id}`;
const settingsKey = (workspaceId: string) => `${prefix(workspaceId)}settings`;
const metadata = ({ editor: _editor, response: _response, error: _error, files: _files, version: _version, ...summary }: HistoryEntry): HistorySummary => summary;

export class BrowserHistory implements HistoryPort {
  constructor(private storage: BrowserHistoryStorage) {}
  private async index(workspaceId: string): Promise<HistorySummary[]> {
    const existing = await this.storage.read<HistorySummary[]>(indexKey(workspaceId));
    if (existing) return existing;
    // Import the previous local execution format once; deleting a new entry
    // must not make the old workspace projection bring it back.
    const entries: HistoryEntry[] = [];
    for (const record of await this.storage.legacy(workspaceId)) {
      if (record.table !== "request_executions") continue;
      const entry = legacyHistoryEntry(record.id, record.value);
      if (entry) entries.push(entry);
    }
    const summaries = entries.map(metadata);
    await this.storage.write([{ key: indexKey(workspaceId), value: summaries }, ...entries.map((entry) => ({ key: entryKey(workspaceId, entry.id), value: entry }))]);
    await this.storage.finishLegacy?.(workspaceId);
    return summaries;
  }
  async append(workspaceId: string, entry: HistoryEntry) {
    const items = await this.index(workspaceId);
    if (!items.some((item) => item.id === entry.id)) await this.storage.write([
      { key: entryKey(workspaceId, entry.id), value: entry },
      { key: indexKey(workspaceId), value: [...items, metadata(entry)] },
    ]);
    await this.prune(workspaceId);
  }
  async list(workspaceId: string, query: HistoryQuery) {
    await this.prune(workspaceId);
    const search = query.search?.trim().toLocaleLowerCase() ?? "";
    const limit = Math.max(1, Math.min(query.limit ?? 50, 100));
    const matched = (await this.index(workspaceId)).filter((item) => (!query.documentId || item.documentId === query.documentId)
      && (!search || `${item.name} ${item.method} ${item.url} ${item.status ?? item.outcome}`.toLocaleLowerCase().includes(search))
      && (!query.cursor || item.startedAt < query.cursor.startedAt || item.startedAt === query.cursor.startedAt && item.id < query.cursor.id))
      .sort((a, b) => b.startedAt - a.startedAt || (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));
    const items = matched.slice(0, limit); const last = items[items.length - 1];
    return { items, cursor: matched.length > limit && last ? { startedAt: last.startedAt, id: last.id } : null };
  }
  async read(workspaceId: string, id: string) {
    await this.prune(workspaceId);
    const summary = (await this.index(workspaceId)).find((item) => item.id === id);
    if (!summary) return null;
    const entry = await this.storage.read<HistoryEntry>(entryKey(workspaceId, id));
    return entry ? { ...entry, pinned: summary.pinned } : null;
  }
  async existing(workspaceId: string, ids: string[]) {
    await this.prune(workspaceId);
    const requested = new Set(ids);
    return (await this.index(workspaceId)).filter((item) => requested.has(item.id)).map((item) => item.id);
  }
  private async removeItems(workspaceId: string, items: HistorySummary[], removed: HistorySummary[]) {
    if (!removed.length) return;
    const ids = new Set(removed.map((item) => item.id));
    await this.storage.write([{ key: indexKey(workspaceId), value: items.filter((item) => !ids.has(item.id)) },
      ...removed.map((item) => ({ key: entryKey(workspaceId, item.id) }))]);
    for (const item of removed) await this.storage.deleteSecrets(`purr/${workspaceId}/history/${item.id}/`);
  }
  async remove(workspaceId: string, filter: { id?: string; documentId?: string }) {
    const items = await this.index(workspaceId);
    await this.removeItems(workspaceId, items, items.filter((item) => (!filter.id || item.id === filter.id) && (!filter.documentId || item.documentId === filter.documentId)));
  }
  async pin(workspaceId: string, id: string, pinned: boolean) {
    const items = await this.index(workspaceId);
    await this.storage.write([{ key: indexKey(workspaceId), value: items.map((item) => item.id === id ? { ...item, pinned } : item) }]);
  }
  async settings(workspaceId: string, retentionDays?: number) {
    if (retentionDays !== undefined) {
      if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 36500) throw new Error("Invalid history retention");
      await this.storage.write([{ key: settingsKey(workspaceId), value: { retentionDays } }]);
      return { retentionDays };
    }
    return await this.storage.read<{ retentionDays: number }>(settingsKey(workspaceId)) ?? { retentionDays: 30 };
  }
  async prune(workspaceId: string) {
    const cutoff = Date.now() - (await this.settings(workspaceId)).retentionDays * 86400000;
    const items = await this.index(workspaceId);
    await this.removeItems(workspaceId, items, items.filter((item) => !item.pinned && item.startedAt < cutoff));
  }
  async latestExecutions(workspaceId: string): Promise<LocalRecord[]> {
    await this.prune(workspaceId);
    const items = (await this.index(workspaceId)).filter((item) => item.status !== null).sort((a, b) => b.startedAt - a.startedAt);
    const seen = new Set<string>(); const records: LocalRecord[] = [];
    for (const item of items) {
      if (seen.has(item.documentId)) continue;
      seen.add(item.documentId);
      const entry = await this.storage.read<HistoryEntry>(entryKey(workspaceId, item.id));
      if (entry) records.push({ table: "request_executions", id: item.id, value: entry });
    }
    return records;
  }
  async deleteWorkspace(workspaceId: string) {
    await this.remove(workspaceId, {});
    await this.storage.write([{ key: indexKey(workspaceId) }, { key: settingsKey(workspaceId) }]);
  }
}
