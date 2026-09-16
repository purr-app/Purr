import { expect, test } from "@playwright/test";
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
      if (command === "observability_integrations") return [
        { id: "alpha", name: "Synthetic Alpha", enabled: true, available: true, capabilities: ["traces", "logs"] },
        { id: "beta", name: "Synthetic Beta", enabled: true, available: true, capabilities: ["traces"] },
        { id: "missing", name: "Missing", enabled: true, available: false, capabilities: [] },
      ];
      if (command === "cancel_observability") { state.cancelled++; return; }
      if (command === "observability_validate_config") {
        if (!String(args.config.endpoint).startsWith("http")) throw new Error("invalid_config");
        return args.config;
      }
      if (command === "observability_trace") {
        if (state.mode === "delayed") await new Promise<void>((resolve) => state.waiters.push(resolve));
        if (state.mode === "empty") return { ...tracePage, traceId: null, total: 0, spans: [], rows: [], correlation: { injectedTraceId: null, lookupReference: null, resolvedTraceId: null } };
        if (state.mode === "malformed") return { ...tracePage, vendorPayload: { token: "should-not-render" } };
        const id = args.query.cursor ? "0000000000000002" : tracePage.spans[0].id;
        return { ...tracePage, ...(state.mode === "different-id" ? { correlation: { ...tracePage.correlation, injectedTraceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } } : {}), total: 2, rows: [{ spanId: id, depth: args.query.cursor ? 1 : 0, hasChildren: !args.query.cursor, matchesSearch: true }],
          spans: [{ ...tracePage.spans[0], id, parentSpanId: args.query.cursor ? tracePage.spans[0].id : null,
          service: args.query.integrationId === "beta" ? "Second service" : "First service",
          operation: args.query.cursor ? "Next operation" : "First operation" }], nextCursor: args.query.cursor ? null : "synthetic-cursor" };
      }
      throw new Error(`Unexpected command ${command}`);
    } };
  }, fixture);
  await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("http://127.0.0.1/fixture");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("tab", { name: "Trace", exact: true }).click();
});

test("Correlation collapses equal roles; provider and query changes silently invalidate pending work", async ({ page }) => {
  await expect(page.getByRole("tree", { name: "Trace spans" })).toBeVisible();
  await page.evaluate(() => { (window as any).traceTest.mode = "different-id"; });
  await page.getByRole("button", { name: "Load trace", exact: true }).click();
  await expect(page.getByLabel("Trace correlation")).toContainText("Sent: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  await expect(page.getByLabel("Trace correlation")).toContainText("Lookup / Resolved:");
  await page.evaluate(() => { (window as any).traceTest.mode = "delayed"; });
  await page.getByRole("button", { name: "Load trace", exact: true }).click();
  await page.locator("summary").filter({ hasText: "Source:" }).click();
  await page.getByRole("combobox", { name: "Trace integration" }).click();
  await page.getByRole("option", { name: "Synthetic Beta · traces", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).traceTest.cancelled)).toBe(1);
  await expect(page.getByRole("button", { name: "Cancel trace lookup" })).toBeVisible();
  await page.getByLabel("Search trace spans").fill("new query");
  await expect.poll(() => page.evaluate(() => (window as any).traceTest.cancelled)).toBe(2);
  await page.evaluate(() => {
    (window as any).traceTest.mode = "normal";
    (window as any).traceTest.waiters.splice(0).forEach((resolve: () => void) => resolve());
  });
  await expect(page.getByRole("tree", { name: "Trace spans" })).toContainText("Second service");
  await expect(page.getByRole("region", { name: "Trace lookup" })).not.toContainText("Trace lookup cancelled");
  await expect(page.getByRole("tree", { name: "Trace spans" })).not.toContainText("First service");
});

test("Integration settings validate natively and keep the token in the scoped secret store across reload", async ({ page }) => {
  await page.getByRole("button", { name: "Select workspace" }).click();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  const settings = page.getByRole("region", { name: "Workspace settings", exact: true });
  await settings.getByRole("tab", { name: "Integrations", exact: true }).click();
  await settings.getByRole("button", { name: "Add Jaeger", exact: true }).click();
  await settings.getByLabel("Integration name", { exact: true }).fill("Local fixture");
  await settings.getByLabel("Jaeger endpoint", { exact: true }).fill("file:///invalid");
  await settings.getByRole("button", { name: "Save integration", exact: true }).click();
  await expect(settings.getByRole("alert")).toContainText("Could not save");
  await settings.getByLabel("Jaeger endpoint", { exact: true }).fill("http://127.0.0.1:43120");
  await settings.getByRole("combobox", { name: "Integration authentication" }).click();
  await page.getByRole("option", { name: "Bearer token", exact: true }).click();
  await settings.getByLabel("Integration token", { exact: true }).fill("synthetic-jaeger-token");
  await settings.getByRole("button", { name: "Save integration", exact: true }).click();
  await expect(settings.getByRole("checkbox", { name: "Enable Local fixture", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("purr-native-persistence-test"))).toContain("127.0.0.1:43120");
  const data = await page.evaluate(() => ({ project: localStorage.getItem("purr-native-persistence-test")!, secrets: JSON.parse(localStorage.getItem("purr-native-secure-test")!) }));
  expect(data.project).not.toContain("synthetic-jaeger-token");
  const reference = Object.keys(data.secrets).find((key) => data.secrets[key] === "synthetic-jaeger-token")!;
  expect(reference).toMatch(/^purr\/[^/]+\/integrations\/[^/]+\/apiToken$/);
  expect(data.project).toContain(reference);
  await page.reload();
  await page.getByRole("button", { name: "Select workspace" }).click();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  await settings.getByRole("tab", { name: "Integrations", exact: true }).click();
  await settings.getByRole("button", { name: "Edit Local fixture", exact: true }).click();
  await expect(settings.getByLabel("Jaeger endpoint", { exact: true })).toHaveValue("http://127.0.0.1:43120");
  await expect(settings.getByLabel("Integration token", { exact: true })).toHaveValue("");
});

test("Trace UI uses native normalized pages and sends only stable references and queries", async ({ page }) => {
  await expect(page.getByRole("tree", { name: "Trace spans" })).toContainText("First operation");
  await page.getByRole("button", { name: "First operation First service" }).click();
  await expect(page.getByRole("complementary", { name: "Span details" })).toContainText("fixture");
  await page.getByRole("button", { name: "Load more spans", exact: true }).click();
  await expect(page.getByRole("region", { name: "Trace lookup" })).toContainText("Next operation");
  await expect(page.getByRole("treeitem")).toHaveCount(2);
  await expect(page.getByRole("complementary", { name: "Span details" })).toContainText("First operation");
  await page.screenshot({ path: test.info().outputPath("trace-hierarchy.png") });
  await page.getByRole("button", { name: "Collapse First operation" }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(1);
  await page.getByRole("button", { name: "Expand First operation" }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(2);
  await expect(page.getByLabel("Trace correlation")).toContainText("Trace ID");
  await expect(page.getByLabel("Trace correlation")).not.toContainText("Resolved:");
  await page.locator("summary").filter({ hasText: "Source:" }).click();
  await page.getByRole("combobox", { name: "Trace integration" }).click();
  await page.getByRole("option", { name: "Synthetic Beta · traces", exact: true }).click();
  await page.getByLabel("Search trace spans").fill("service");
  await expect(page.getByRole("region", { name: "Trace lookup" })).toContainText("Second service");
  const calls = await page.evaluate(() => (window as any).traceTest.calls.filter((call: any) => call.command === "observability_trace"));
  expect(Object.keys(calls[0].args.query).sort()).toEqual(["cursor", "documentId", "integrationId", "manualTraceId", "search", "startedAtMs", "workspaceId"]);
  expect(calls.at(-1).args.query).toMatchObject({ integrationId: "beta", search: "service", cursor: null });
});

test("Trace cancellation and tab changes suppress late results; empty and malformed DTO states are safe", async ({ page }) => {
  await expect(page.getByRole("tree", { name: "Trace spans" })).toBeVisible();
  await page.evaluate(() => { (window as any).traceTest.mode = "delayed"; });
  await page.getByRole("button", { name: "Load trace", exact: true }).click();
  await page.getByRole("button", { name: "Cancel trace lookup", exact: true }).click();
  await expect(page.getByRole("region", { name: "Trace lookup" }).getByRole("status")).toContainText("Trace lookup cancelled");
  await expect(page.getByRole("region", { name: "Trace lookup" })).not.toContainText("First service");
  await page.getByRole("button", { name: "Load trace", exact: true }).click();
  await page.getByRole("region", { name: "HTTP response" }).getByRole("tab", { name: /^Headers/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).traceTest.cancelled)).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => { (window as any).traceTest.waiters.splice(0).forEach((resolve: () => void) => resolve()); });
  await page.getByRole("tab", { name: "Trace", exact: true }).click();
  await page.evaluate(() => { (window as any).traceTest.mode = "empty"; });
  await expect(page.getByRole("region", { name: "Trace lookup" })).toContainText("No trace was found");
  await page.evaluate(() => { (window as any).traceTest.mode = "malformed"; });
  await page.getByRole("button", { name: "Load trace", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("trace lookup failed");
  await expect(page.getByRole("region", { name: "Trace lookup" })).not.toContainText("should-not-render");
});
