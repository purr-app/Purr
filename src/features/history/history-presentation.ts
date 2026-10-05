import type { HistorySummary } from "../../application/ports/history";

export function groupHistoryByDay(items: HistorySummary[], now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups = new Map<string, { key: string; label: string; items: HistorySummary[] }>();
  for (const item of items) {
    const date = new Date(item.startedAt);
    const key = date.toDateString();
    const label = key === today.toDateString() ? "Today"
      : key === yesterday.toDateString() ? "Yesterday"
        : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    if (!groups.has(key)) groups.set(key, { key, label, items: [] });
    groups.get(key)!.items.push(item);
  }
  return [...groups.values()];
}

export function historyStatus(item: HistorySummary) {
  return item.outcome === "cancelled" ? "Cancelled" : item.outcome === "error" ? "Error" : String(item.status ?? "—");
}

export function historyStatusClass(item: HistorySummary) {
  if (item.outcome === "cancelled") return "text-content-tertiary";
  if (item.outcome === "error" || (item.status ?? 0) >= 500) return "text-status-server-error";
  if ((item.status ?? 0) >= 400) return "text-status-client-error";
  if ((item.status ?? 0) >= 300) return "text-status-redirect";
  return "text-status-success";
}
