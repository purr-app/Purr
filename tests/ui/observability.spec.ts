import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { installPersistenceMock } from "./persistence-mock";
const fixture = JSON.parse(readFileSync(new URL("../fixtures/observability/trace-page.json", import.meta.url), "utf8"));

test.beforeEach(async ({ page }) => {
  await installPersistenceMock(page);
  await page.addInitScript((tracePage) => {
    const state = { calls: [] as Array<{ command: string; args: any }>, mode: "normal", cancelled: 0, waiters: [] as Array<() => void> };
    (window as any).traceTest = state;
    (window as any).isTauri = true;
    (window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      state.calls.push({ command, args });
      if (command === "start_http") return { status: 200, statusText: "OK", durationMs: 1,
        headers: [["content-type", "application/json"]], bodyBase64: btoa('{"ok":true}') };
      if (command === "observability_integrations") return [];
      if (command === "cancel_observability") { state.cancelled++; return; }
      if (command === "observability_validate_config") {
        if (!String(args.config.endpoint).startsWith("http")) throw new Error("invalid_config");
        return args.config;
      }
      if (command === "observability_trace") {
        if (state.mode === "delayed") await new Promise<void>((resolve) => state.waiters.push(resolve));
        if (state.mode === "empty") return { ...tracePage, traceId: null, total: 0, nextCursor: null, spans: [], rows: [], correlation: { injectedTraceId: null, lookupReference: null, resolvedTraceId: null } };
        if (state.mode === "malformed") return { ...tracePage, vendorPayload: { token: "should-not-render" } };
        const offset = Number(args.query.cursor ?? 0);
        const total = args.query.search ? 2 : 500;
        const spans = Array.from({ length: Math.min(25, total - offset) }, (_, index) => {
          const position = offset + index;
          return { ...tracePage.spans[0], id: position.toString(16).padStart(16, "0"), parentSpanId: position ? "0000000000000000" : null,
            service: position % 3 === 0 ? "api" : position % 3 === 1 ? "database" : "cache",
            operation: position ? `Operation ${position}` : "First operation", startedAtUs: 1000 + (position ? position * 200 : 0), durationUs: position ? 500 + position * 10 : 110000 };
        });
        return { ...tracePage, total, timing: { startedAtUs: 1000, durationUs: 110000 }, spans,
          rows: spans.map((span, index) => ({ spanId: span.id, depth: offset + index ? 1 : 0, hasChildren: offset + index === 0, matchesSearch: true })), nextCursor: offset + spans.length < total ? String(offset + spans.length) : null };
      }
      throw new Error(`Unexpected command ${command}`);
    } };
  }, fixture);
  await page.goto("/");
  await page.getByRole("button", { name: "Horizontal split view", exact: true }).click();
});
async function settings(page: Page) {
  await page.getByRole("button", { name: "Select workspace" }).click();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  const region = page.getByRole("region", { name: "Workspace settings", exact: true });
  await region.getByRole("tab", { name: "Integrations", exact: true }).click();
  return region;
}
async function addIntegration(page: Page) {
  const region = await settings(page);
  await region.getByRole("button", { name: "Add integration", exact: true }).click();
  await page.getByRole("button", { name: /Jaeger Explore distributed traces/ }).click();
  await page.getByLabel("Integration name", { exact: true }).fill("Local traces");
  await page.getByRole("button", { name: "Save integration", exact: true }).click();
  await expect(region.getByRole("checkbox", { name: "Enable Local traces", exact: true })).toBeVisible();
  await page.getByRole("tablist", { name: "Documents", exact: true }).getByRole("tab").first().click();
}
async function openTrace(page: Page) {
  await addIntegration(page);
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Enable tracing for this request" }).click();
  await page.getByLabel("Request URL", { exact: true }).fill("http://127.0.0.1/fixture");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("tab", { name: "Trace", exact: true }).click();
  await expect(page.getByRole("tree", { name: "Trace spans" })).toBeVisible();
}

test("catalog, shared auth and readable propagation options keep credentials in secure storage", async ({ page }) => {
  const region = await settings(page);
  await region.getByRole("button", { name: "Add integration", exact: true }).click();
  const catalog = page.getByRole("dialog", { name: "Add integration" });
  await expect(catalog.getByRole("img")).toHaveCount(0); // Decorative provider artwork has empty alt text.
  await expect(catalog.locator("img")).toBeVisible();
  const bounds = await catalog.boundingBox();
  expect(Math.abs(bounds!.y - (page.viewportSize()!.height - bounds!.y - bounds!.height))).toBeLessThan(3);
  expect(bounds!.height).toBeGreaterThan(page.viewportSize()!.height * 0.85);
  await page.screenshot({ path: test.info().outputPath("integration-catalog.png") });
  await catalog.getByRole("button", { name: /Jaeger Explore distributed traces/ }).click();
  const dialog = page.getByRole("dialog", { name: "Jaeger settings" });
  await dialog.getByLabel("Integration name", { exact: true }).fill("Local traces");
  await dialog.getByLabel("Integration endpoint URL", { exact: true }).fill("file:///invalid");
  await dialog.getByRole("button", { name: "Save integration", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Could not save");
  await dialog.getByLabel("Integration endpoint URL", { exact: true }).fill("http://127.0.0.1:43120");
  await dialog.getByRole("tab", { name: "Bearer Token", exact: true }).click();
  await dialog.getByLabel("Bearer token", { exact: true }).fill("synthetic-jaeger-token");
  await dialog.getByRole("combobox", { name: "Trace propagation" }).click();
  const option = page.getByRole("option", { name: "W3C Trace Context" });
  await expect(option).toBeVisible();
  expect(await option.evaluate((node) => getComputedStyle(node).whiteSpace)).toBe("nowrap");
  await page.getByRole("option", { name: "B3", exact: true }).click();
  await dialog.getByText("Custom propagation headers", { exact: true }).click();
  const headerForms = dialog.getByRole("region", { name: "header entries" });
  await headerForms.nth(0).getByPlaceholder("Header-name").fill("x-client-trace");
  await headerForms.nth(0).getByLabel("Value for x-client-trace", { exact: true }).fill("{{$b3}}");
  await headerForms.nth(1).getByPlaceholder("Header-name").fill("x-server-trace");
  await headerForms.nth(1).getByLabel("Value for x-server-trace", { exact: true }).fill("traceId");
  await expect(headerForms.nth(0).getByPlaceholder("Header-name")).toHaveCount(2);
  await page.screenshot({ path: test.info().outputPath("integration-settings.png") });
  await dialog.getByRole("button", { name: "Save integration", exact: true }).click();
  await expect(region.getByRole("checkbox", { name: "Enable Local traces", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("purr-native-persistence-test"))).toContain("43120");
  const data = await page.evaluate(() => ({ project: localStorage.getItem("purr-native-persistence-test")!, secrets: JSON.parse(localStorage.getItem("purr-native-secure-test")!) }));
  expect(data.project).not.toContain("synthetic-jaeger-token");
  const reference = Object.keys(data.secrets).find((key) => data.secrets[key].includes("synthetic-jaeger-token"))!;
  expect(reference).toMatch(/^purr\/[^/]+\/integrations\/[^/]+\/auth$/);
  expect(data.project).toContain(reference);
  await page.reload();
  await settings(page);
  await region.getByRole("button", { name: "Edit Local traces", exact: true }).click();
  await expect(page.getByLabel("Bearer token", { exact: true })).toHaveValue("synthetic-jaeger-token");
  await page.getByText("Custom propagation headers", { exact: true }).click();
  await expect(page.getByLabel("Value for x-client-trace", { exact: true })).toHaveValue("{{$b3}}");
  await expect(page.getByLabel("Value for x-server-trace", { exact: true })).toHaveValue("traceId");
});

test("request tracing controls provider onboarding, hidden tabs and locked generated headers", async ({ page }) => {
  await page.getByLabel("Request URL", { exact: true }).fill("http://127.0.0.1/fixture");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Trace", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Add provider" }).click();
  await expect(page.getByRole("dialog", { name: "Add integration" })).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Add integration", exact: true }).click();
  await page.getByRole("button", { name: /Jaeger Explore distributed traces/ }).click();
  await page.getByRole("button", { name: "Save integration", exact: true }).click();
  await page.getByRole("tablist", { name: "Documents", exact: true }).getByRole("tab").first().click();
  await page.getByRole("tab", { name: "Trace", exact: true }).click();
  await expect(page.getByText("Tracing is not enabled for this request.", { exact: false })).toBeVisible();
  await page.getByRole("switch", { name: "Enable tracing for this request" }).click();
  await page.getByRole("tab", { name: /^Headers/ }).first().click();
  await expect(page.locator('input[value="{{$traceparent}}"]')).toBeVisible();
});

test("waterfall virtualizes lazy pages, folds parents, and restores inspector and response tab", async ({ page }) => {
  await openTrace(page);
  await expect(page.getByRole("complementary", { name: "Span details" })).toHaveCount(0);
  await page.getByRole("button", { name: "api First operation", exact: true }).click();
  const inspector = page.getByRole("complementary", { name: "Span details" });
  await expect(inspector).toContainText("Timing");
  await expect(inspector).toContainText("110 ms");
  await expect(inspector).toContainText("Attributes");
  await page.screenshot({ path: test.info().outputPath("trace-waterfall.png") });
  await page.getByRole("button", { name: "Collapse First operation" }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(1);
  await page.getByRole("button", { name: "Expand First operation" }).click();
  const tree = page.getByRole("tree", { name: "Trace spans" });
  await tree.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => page.evaluate(() => (window as any).traceTest.calls.filter((call: any) => call.command === "observability_trace").length)).toBeGreaterThan(1);
  expect(await page.getByRole("treeitem").count()).toBeLessThan(60);
  await page.getByRole("tab", { name: "Workspace settings", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Integrations", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tablist", { name: "Documents", exact: true }).getByRole("tab").first().click();
  await expect(page.getByRole("tab", { name: "Trace", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(inspector).toContainText("First operation");
  await page.keyboard.press("Meta+f");
  await expect(page.getByLabel("Search trace spans")).toBeFocused();
  await page.getByLabel("Search trace spans").fill("database");
  await expect.poll(() => page.evaluate(() => (window as any).traceTest.calls.filter((call: any) => call.command === "observability_trace").at(-1).args.query.search)).toBe("database");
  await expect(page.getByRole("treeitem")).toHaveCount(2);
});

test("trace cancellation ignores late results and reload handles empty responses", async ({ page }) => {
  await openTrace(page);
  await page.evaluate(() => { (window as any).traceTest.mode = "delayed"; });
  await page.getByRole("button", { name: "Load trace", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("Trace lookup cancelled.", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).traceTest.cancelled)).toBeGreaterThan(0);
  await page.evaluate(() => { (window as any).traceTest.mode = "empty"; (window as any).traceTest.waiters.splice(0).forEach((resolve: () => void) => resolve()); });
  await page.getByRole("button", { name: "Load trace", exact: true }).click();
  await expect(page.getByRole("region", { name: "Trace lookup" })).toContainText("No trace was found");
});

test("workspace settings retain unfinished editors until the settings tab closes", async ({ page }) => {
  await settings(page);
  await page.getByRole("tab", { name: "Shared auth", exact: true }).click();
  await page.getByRole("button", { name: "Add shared auth", exact: true }).click();
  await page.getByLabel("Auth name", { exact: true }).fill("Unfinished profile");
  await page.getByRole("tablist", { name: "Documents", exact: true }).getByRole("tab").first().click();
  await page.getByRole("tab", { name: "Workspace settings", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Shared auth", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Auth name", { exact: true })).toHaveValue("Unfinished profile");
  await page.getByRole("button", { name: "Close workspace settings", exact: true }).click();
  await page.getByRole("button", { name: "Select workspace" }).click();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  await expect(page.getByRole("tab", { name: "General", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Shared auth", exact: true }).click();
  await expect(page.getByLabel("Auth name", { exact: true })).toHaveCount(0);
});
