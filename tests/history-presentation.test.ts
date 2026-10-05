import assert from "node:assert/strict";
import test from "node:test";
import type { HistorySummary } from "../src/application/ports/history";
import { groupHistoryByDay, historyStatus } from "../src/features/history/history-presentation";

function entry(id: string, startedAt: number, extra: Partial<HistorySummary> = {}): HistorySummary {
  return { id, startedAt, documentId: "request", name: "Request", kind: "http", method: "GET", url: "https://example.test", durationMs: 12, outcome: "response", status: 200, size: 50, pinned: false, ...extra };
}

test("history groups by local calendar days across month and year boundaries", () => {
  const now = new Date(2026, 0, 1, 0, 5);
  const items = [entry("today", new Date(2026, 0, 1, 0, 1).getTime()), entry("yesterday", new Date(2025, 11, 31, 23, 59).getTime()), entry("older", new Date(2025, 11, 30, 9).getTime())];
  const groups = groupHistoryByDay(items, now);
  assert.equal(groups[0].label, "Today");
  assert.equal(groups[1].label, "Yesterday");
  assert.equal(groups[2].key, new Date(2025, 11, 30).toDateString());
  assert.deepEqual(groups.map((group) => group.items.map((item) => item.id)), [["today"], ["yesterday"], ["older"]]);
});

test("history preserves execution order and combines entries from the same date", () => {
  const now = new Date(2026, 8, 28, 20);
  const first = entry("recent", new Date(2026, 8, 28, 19).getTime());
  const second = entry("earlier", new Date(2026, 8, 28, 18).getTime());
  const groups = groupHistoryByDay([first, second], now);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].items, [first, second]);
  assert.deepEqual(groupHistoryByDay([], now), []);
});

test("history distinguishes transport errors and cancellation from HTTP failure responses", () => {
  assert.equal(historyStatus(entry("http-error", 0, { status: 404 })), "404");
  assert.equal(historyStatus(entry("network-error", 0, { status: null, outcome: "error" })), "Error");
  assert.equal(historyStatus(entry("cancelled", 0, { status: null, outcome: "cancelled" })), "Cancelled");
});
