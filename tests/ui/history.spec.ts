import { expect, test, type Page } from "@playwright/test";
import { installPersistenceMock } from "./persistence-mock";

const tabs = (page: Page) => page.getByRole("tablist", { name: "Documents", exact: true }).getByRole("tab");
const historyPanel = (page: Page) => page.getByRole("region", { name: "Workspace request history", exact: true });
const requestUrl = (page: Page) => page.getByLabel("Request URL", { exact: true });
const historical = (page: Page) => page.getByLabel("Historical request", { exact: true });
const entryButtons = (page: Page) => historyPanel(page).getByRole("listitem").locator("button").filter({ has: page.locator("time") });

async function send(page: Page, url: string) {
  await requestUrl(page).fill(url);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("region", { name: "HTTP response", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate((requestUrl) => Object.values(JSON.parse(localStorage.getItem("purr-native-history-test") ?? "{}")).flatMap((history: any) => history.entries).some((entry: any) => entry.url === requestUrl), url)).toBe(true);
}
async function saveDocument(page: Page) {
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Document name", { exact: true }).fill("Example request");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
}
async function openHistory(page: Page) {
  await page.getByRole("navigation", { name: "Workspace activities" }).getByRole("button", { name: "History", exact: true }).click();
  await expect(historyPanel(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await installPersistenceMock(page);
  await page.addInitScript(() => {
    (window as any).isTauri = true;
    (window as any).__requests = [];
    (window as any).__historyRequestMode = "response";
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: any) => {
        if (command !== "start_http") return;
        (window as any).__requests.push(args.request);
        if ((window as any).__historyRequestMode === "error") throw new Error("Network unavailable");
        if ((window as any).__historyRequestMode === "pending") return new Promise(() => {});
        return { status: 200, statusText: "OK", durationMs: 12, httpVersion: "HTTP/2",
          headers: [["content-type", "application/json"]], bodyBase64: btoa('{"history":true}') };
      },
    };
  });
  await page.goto("/");
});

test("global and document history show executions and reuse immutable historical tabs", async ({ page }) => {
  await send(page, "https://example.test/first");
  await send(page, "https://example.test/second");
  await page.getByRole("button", { name: "Show response history", exact: true }).click();
  const documentHistory = page.getByRole("region", { name: "Document request history", exact: true });
  await expect(documentHistory.getByRole("listitem")).toHaveCount(2);
  await expect(documentHistory.getByRole("heading", { name: "History", exact: true })).toBeVisible();
  expect((await documentHistory.boundingBox())!.width).toBeLessThanOrEqual(288);
  const compactRow = documentHistory.getByRole("listitem").first();
  await expect(compactRow.locator("time")).toHaveCSS("opacity", "1");
  await compactRow.hover();
  await expect(compactRow.locator("time")).toHaveCSS("opacity", "0");
  await expect(compactRow.getByRole("button", { name: "Pin execution", exact: true }).locator("..")).toHaveCSS("opacity", "1");
  await documentHistory.getByRole("heading", { name: "History", exact: true }).hover();
  await page.screenshot({ path: "test-results/history-document.png" });
  await documentHistory.getByRole("listitem").last().locator("button").first().click();
  await expect(historical(page)).toBeVisible();
  await expect(page.getByLabel("Historical response date", { exact: true })).toBeVisible();
  const historicalBadge = page.getByRole("button", { name: "Show response history", exact: true });
  await expect(historicalBadge).toHaveAttribute("aria-pressed", "true");
  await expect(historicalBadge.locator("time")).toBeVisible();
  const badge = await historicalBadge.boundingBox();
  const date = await historicalBadge.locator("time").boundingBox();
  expect(date!.x).toBeGreaterThan(badge!.x);
  expect(date!.x + date!.width).toBeLessThanOrEqual(badge!.x + badge!.width);
  await expect(page.getByRole("tab", { name: "Trace", exact: true })).toBeDisabled();
  await expect(page.getByText("Historical execution", { exact: false })).toHaveCount(0);
  await expect(requestUrl(page)).toHaveValue("https://example.test/first");
  await expect(tabs(page)).toHaveCount(1);
  await page.screenshot({ path: "test-results/history-execution.png", fullPage: true });
  await openHistory(page);
  await expect(historyPanel(page).getByRole("listitem")).toHaveCount(2);
  const row = historyPanel(page).getByRole("listitem").first();
  expect((await row.boundingBox())!.height).toBeLessThanOrEqual(32);
  await historyPanel(page).getByRole("heading", { name: "History", exact: true }).hover();
  await expect(row.locator("time")).toHaveCSS("opacity", "1");
  await row.hover();
  await expect(row.locator("time")).toHaveCSS("opacity", "0");
  const pin = row.getByRole("button", { name: "Pin execution", exact: true });
  await expect(pin.locator("..")).toHaveCSS("opacity", "1");
  await pin.focus();
  await historyPanel(page).getByRole("heading", { name: "History", exact: true }).hover();
  await expect(pin.locator("..")).toHaveCSS("opacity", "1");
  await pin.blur();
  await expect(row.locator("time")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "test-results/history-global.png" });
  await entryButtons(page).filter({ hasText: "https://example.test/first" }).click();
  await expect(tabs(page)).toHaveCount(2);
  const input = requestUrl(page);
  await input.fill("https://example.test/new-draft");
  await input.pressSequentially("-edited");
  await expect(input).toBeFocused();
  await expect(historical(page)).toBeVisible();
  await expect(tabs(page)).toHaveCount(2);
  await expect(historyPanel(page).getByRole("listitem")).toHaveCount(2);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("dialog", { name: "This document has unsaved changes" }).getByRole("button", { name: "Create new draft", exact: true }).click();
  await expect(historical(page)).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(2);
  await expect(input).toHaveValue("https://example.test/new-draft-edited");
  await expect(historyPanel(page).getByRole("listitem")).toHaveCount(3);
  await page.screenshot({ path: "test-results/history-global.png" });
  await entryButtons(page).filter({ hasText: "https://example.test/first" }).click();
  await expect(requestUrl(page)).toHaveValue("https://example.test/first");
});

test("editing saved history preserves current changes until conflict choice", async ({ page }) => {
  await requestUrl(page).fill("https://example.test/original");
  await saveDocument(page);
  await send(page, "https://example.test/original");
  await openHistory(page);
  await entryButtons(page).filter({ hasText: "https://example.test/original" }).click();
  await requestUrl(page).fill("https://example.test/clean-replay");
  await expect(historical(page)).toBeVisible();
  await expect(requestUrl(page)).toBeFocused();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(historical(page)).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "This document has unsaved changes" })).toHaveCount(0);
  await entryButtons(page).filter({ hasText: "https://example.test/original" }).click();
  await requestUrl(page).fill("https://example.test/replace");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const conflict = page.getByRole("dialog", { name: "This document has unsaved changes" });
  await expect(conflict).toBeVisible();
  await conflict.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(historical(page)).toBeVisible();
  await page.getByRole("button", { name: "Show response history", exact: true }).click();
  await page.getByRole("button", { name: "Return to current", exact: true }).click();
  await expect(requestUrl(page)).toHaveValue("https://example.test/clean-replay");
  await entryButtons(page).filter({ hasText: "https://example.test/original" }).click();
  await requestUrl(page).fill("https://example.test/separate");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await conflict.getByRole("button", { name: "Create new draft", exact: true }).click();
  await expect(requestUrl(page)).toHaveValue("https://example.test/separate");
  await entryButtons(page).filter({ hasText: "https://example.test/original" }).click();
  await requestUrl(page).fill("https://example.test/replaced");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await conflict.getByRole("button", { name: "Replace current changes", exact: true }).click();
  await expect(requestUrl(page)).toHaveValue("https://example.test/replaced");
  await expect(historical(page)).toHaveCount(0);
  await expect(historyPanel(page).getByRole("listitem")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Save document", exact: true })).toBeEnabled();
});

test("history supports pinning search retention and explicit deletion", async ({ page }) => {
  await send(page, "https://example.test/retained");
  await openHistory(page);
  await historyPanel(page).getByRole("listitem").first().hover();
  await historyPanel(page).getByRole("button", { name: "Pin execution", exact: true }).click();
  await expect(historyPanel(page).getByRole("button", { name: "Unpin execution", exact: true })).toBeVisible();
  await page.getByLabel("Search request history", { exact: true }).fill("no-such-request");
  await expect(historyPanel(page).getByText("No matching requests.", { exact: true })).toBeVisible();
  await page.getByLabel("Search request history", { exact: true }).fill("retained");
  await expect(historyPanel(page).getByRole("listitem")).toHaveCount(1);
  await historyPanel(page).getByRole("button", { name: "History retention", exact: true }).click();
  await page.getByLabel("Keep history for (days)", { exact: true }).fill("7");
  await historyPanel(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(historyPanel(page).getByRole("alertdialog")).toContainText("Delete unpinned entries older than 7 days");
  await historyPanel(page).getByRole("button", { name: "Apply retention", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("purr-native-history-test") ?? "{}")).map((history: any) => history.retentionDays))).toEqual([7]);
  await historyPanel(page).getByRole("listitem").first().hover();
  await historyPanel(page).getByRole("button", { name: "Delete execution", exact: true }).click();
  await historyPanel(page).getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(historyPanel(page).getByText("No matching requests.", { exact: true })).toBeVisible();
});

test("deleting a draft keeps its execution and editing it creates a new draft", async ({ page }) => {
  await send(page, "https://example.test/deleted-draft");
  const documents = page.getByRole("complementary", { name: "Workspace documents", exact: true });
  await documents.getByRole("button", { name: /GET.*deleted-draft/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Discard", exact: true }).click();
  await expect(page.getByRole("region", { name: "Workspace", exact: true })).toHaveAttribute("aria-busy", "false");
  await page.reload();
  await openHistory(page);
  await expect(historyPanel(page).getByRole("listitem")).toHaveCount(1);
  await entryButtons(page).first().click();
  await expect(historical(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Return to current", exact: true })).toHaveCount(0);
  await requestUrl(page).fill("https://example.test/recovered");
  await expect(requestUrl(page)).toBeFocused();
  await expect(historical(page)).toBeVisible();
  const before = await tabs(page).count();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(historical(page)).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(before);
  await expect(requestUrl(page)).toHaveValue("https://example.test/recovered");
  await expect(historyPanel(page).getByRole("listitem")).toHaveCount(2);
});


test("failed and cancelled sends are captured while empty validation is excluded", async ({ page }) => {
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await openHistory(page);
  await expect(historyPanel(page).getByText("No requests yet. Sent requests appear here.", { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__historyRequestMode = "error"; });
  await requestUrl(page).fill("https://example.test/unavailable");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(historyPanel(page).getByRole("listitem")).toHaveCount(1);
  await expect(historyPanel(page).getByRole("listitem").first()).toContainText("Error");
  await page.evaluate(() => { (window as any).__historyRequestMode = "pending"; });
  await requestUrl(page).fill("https://example.test/cancel");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__requests.length)).toBe(2);
  await page.keyboard.press("Escape");
  await expect(historyPanel(page).getByRole("listitem")).toHaveCount(2);
  await expect(historyPanel(page).getByRole("listitem").first()).toContainText("Cancelled");
  await entryButtons(page).last().click();
  await expect(historical(page)).toBeVisible();
  await expect(page.getByText("Network unavailable", { exact: false }).first()).toBeVisible();
});

test("replaying history uses current auth and appends a new immutable execution", async ({ page }) => {
  await requestUrl(page).fill("https://example.test/replay");
  await page.getByRole("tab", { name: /^Auth/ }).click();
  await page.getByRole("tab", { name: "Bearer Token", exact: true }).click();
  await page.getByLabel("Bearer token", { exact: true }).fill("old-token");
  await saveDocument(page);
  await send(page, "https://example.test/replay");
  await page.getByRole("tab", { name: /^Auth/ }).click();
  await page.getByLabel("Bearer token", { exact: true }).fill("current-token");
  await expect(page.getByLabel("Bearer token", { exact: true })).toHaveValue("current-token");
  await openHistory(page);
  await entryButtons(page).first().click();
  await expect(historical(page)).toBeVisible();
  await page.getByRole("button", { name: "Show response history", exact: true }).click();
  await page.getByRole("button", { name: "Return to current", exact: true }).click();
  await expect(page.getByLabel("Bearer token", { exact: true })).toHaveValue("current-token");
  await entryButtons(page).first().click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("dialog", { name: "This document has unsaved changes" }).getByRole("button", { name: "Replace current changes", exact: true }).click();
  await expect(historyPanel(page).getByRole("listitem")).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => (window as any).__requests.at(-1)?.headers)).toContainEqual(["Authorization", "Bearer current-token"]);
  await entryButtons(page).last().click();
  await expect(historical(page)).toBeVisible();
  await page.getByRole("tab", { name: /^Auth/ }).click();
  await expect(page.getByLabel("Bearer token", { exact: true })).toHaveValue("old-token");
});

test("history searches entries beyond the first page and scopes them to the workspace", async ({ page }) => {
  await send(page, "https://example.test/seed");
  await page.evaluate(() => {
    const histories = JSON.parse(localStorage.getItem("purr-native-history-test")!);
    const history = Object.values(histories)[0] as any;
    const source = history.entries[0];
    history.entries = Array.from({ length: 60 }, (_, index) => ({ ...source, id: `history-${index}`, url: `https://example.test/entry-${index}`, startedAt: Date.now() - index * 1000 }));
    localStorage.setItem("purr-native-history-test", JSON.stringify(histories));
  });
  await openHistory(page);
  await expect(historyPanel(page).getByRole("listitem")).toHaveCount(50);
  await page.getByLabel("Search request history", { exact: true }).fill("entry-59");
  await expect(historyPanel(page).getByRole("listitem")).toHaveCount(1);
  await expect(entryButtons(page).first()).toContainText("entry-59");
  await page.getByLabel("Search request history", { exact: true }).fill("");
  await expect(historyPanel(page).getByRole("listitem")).toHaveCount(50);
  await historyPanel(page).getByRole("button", { name: "Load more requests", exact: true }).click();
  await expect(historyPanel(page).getByRole("listitem")).toHaveCount(60);
  await page.getByRole("button", { name: "Select workspace", exact: true }).click();
  await page.getByRole("button", { name: "New workspace", exact: true }).click();
  await page.getByRole("menuitem", { name: "New empty", exact: true }).click();
  await page.getByLabel("Workspace name", { exact: true }).fill("Separate history");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await openHistory(page);
  await expect(historyPanel(page).getByText("No requests yet. Sent requests appear here.", { exact: true })).toBeVisible();
});


for (const view of ["Canvas view", "Horizontal split view", "Vertical split view"]) test(`error history stays in the header in ${view}`, async ({ page }) => {
  await page.getByRole("button", { name: view, exact: true }).click();
  await page.evaluate(() => { (window as any).__historyRequestMode = "error"; });
  await requestUrl(page).fill("https://example.test/error");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const error = page.getByRole("region", { name: "Request error", exact: true });
  await expect(error).toBeVisible();
  // Measure in one frame: canvas animates the entire response pane on Send.
  const geometry = await error.evaluate((element) => {
    const label = element.querySelector('[role="tab"]')!.getBoundingClientRect();
    const icon = element.querySelector('[aria-label="Show response history"]')!.getBoundingClientRect();
    return { centerDelta: Math.abs(label.y + label.height / 2 - icon.y - icon.height / 2), inset: icon.y - element.getBoundingClientRect().y };
  });
  expect(geometry.centerDelta).toBeLessThan(1);
  expect(geometry.inset).toBeLessThanOrEqual(8);
  await page.screenshot({ path: `test-results/history-error-${view.split(" ")[0]}.png` });
});

test("legacy executions keep a styled response-only viewer and disabled tracing", async ({ page }) => {
  await send(page, "https://example.test/legacy");
  await page.evaluate(() => {
    const histories = JSON.parse(localStorage.getItem("purr-native-history-test")!);
    for (const history of Object.values(histories) as any[]) for (const entry of history.entries) entry.editor = null;
    localStorage.setItem("purr-native-history-test", JSON.stringify(histories));
  });
  await openHistory(page);
  await entryButtons(page).first().click();
  await expect(requestUrl(page)).toHaveCount(0);
  const response = page.getByRole("region", { name: "HTTP response", exact: true });
  await expect(response).toBeVisible();
  await expect(response).not.toHaveCSS("border-radius", "0px");
  await expect(response.locator("..")).toHaveCSS("padding", "8px");
  await expect(response.getByRole("tab", { name: "Trace", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Historical response date", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/history-legacy.png" });
});


test("response history replaces the current draft tab and asks before overwriting its buffer", async ({ page }) => {
  await send(page, "https://example.test/old");
  await send(page, "https://example.test/current");
  await requestUrl(page).fill("https://example.test/unsaved");
  const openOld = async () => {
    await page.getByRole("button", { name: "Show response history", exact: true }).click();
    await page.getByRole("region", { name: "Document request history", exact: true }).getByRole("listitem").last().locator("button").first().click();
    await expect(tabs(page)).toHaveCount(1);
    await expect(requestUrl(page)).toHaveValue("https://example.test/old");
  };
  await openOld();
  // Browsing another execution in the same response popover adds no tab.
  await page.getByRole("button", { name: "Show response history", exact: true }).click();
  await page.getByRole("region", { name: "Document request history", exact: true }).getByRole("listitem").first().locator("button").first().click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(requestUrl(page)).toHaveValue("https://example.test/current");
  await openOld();
  await requestUrl(page).fill("https://example.test/replay-edited");
  await expect(requestUrl(page)).toBeFocused();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const conflict = page.getByRole("dialog", { name: "This document has unsaved changes" });
  await expect(conflict).toBeVisible();
  await conflict.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Show response history", exact: true }).click();
  await page.getByRole("button", { name: "Return to current", exact: true }).click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(requestUrl(page)).toHaveValue("https://example.test/unsaved");
  await openOld();
  await requestUrl(page).fill("https://example.test/replay-edited");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await conflict.getByRole("button", { name: "Replace current changes", exact: true }).click();
  await expect(historical(page)).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(1);
  await expect(requestUrl(page)).toHaveValue("https://example.test/replay-edited");
  await expect.poll(() => page.evaluate(() => {
    const history = Object.values(JSON.parse(localStorage.getItem("purr-native-history-test")!))[0] as any;
    return { count: history.entries.length, documents: new Set(history.entries.map((entry: any) => entry.documentId)).size };
  })).toEqual({ count: 3, documents: 1 });
});
