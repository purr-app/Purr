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
        { id: "alpha", name: "Synthetic Alpha", enabled: true, available: true },
        { id: "beta", name: "Synthetic Beta", enabled: true, available: true },
        { id: "missing", name: "Missing", enabled: true, available: false },
      ];
      if (command === "cancel_observability") { state.cancelled++; return; }
      if (command === "observability_trace") {
        if (state.mode === "delayed") await new Promise<void>((resolve) => state.waiters.push(resolve));
        if (state.mode === "empty") return { ...tracePage, traceId: null, total: 0, spans: [] };
        if (state.mode === "malformed") return { ...tracePage, vendorPayload: { token: "should-not-render" } };
        return { ...tracePage, spans: [{ ...tracePage.spans[0], service: args.query.integrationId === "beta" ? "Second service" : "First service",
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

test("Trace UI uses native normalized pages and sends only stable references and queries", async ({ page }) => {
  await page.getByRole("button", { name: "Load trace", exact: true }).click();
  await expect(page.getByRole("region", { name: "Trace lookup" })).toContainText("First service / First operation");
  await page.getByRole("button", { name: "Next spans", exact: true }).click();
  await expect(page.getByRole("region", { name: "Trace lookup" })).toContainText("Next operation");
  await page.getByRole("combobox", { name: "Trace integration" }).click();
  await page.getByRole("option", { name: "Synthetic Beta", exact: true }).click();
  await page.getByLabel("Search trace spans").fill("service");
  await page.getByRole("button", { name: "Load trace", exact: true }).click();
  await expect(page.getByRole("region", { name: "Trace lookup" })).toContainText("Second service");
  const calls = await page.evaluate(() => (window as any).traceTest.calls.filter((call: any) => call.command === "observability_trace"));
  expect(Object.keys(calls[0].args.query).sort()).toEqual(["cursor", "documentId", "integrationId", "manualTraceId", "search", "startedAtMs", "workspaceId"]);
  expect(calls[2].args.query).toMatchObject({ integrationId: "beta", search: "service", cursor: null });
});

test("Trace cancellation and tab changes suppress late results; empty and malformed DTO states are safe", async ({ page }) => {
  await page.evaluate(() => { (window as any).traceTest.mode = "delayed"; });
  await page.getByRole("button", { name: "Load trace", exact: true }).click();
  await page.getByRole("button", { name: "Cancel trace lookup", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).traceTest.cancelled)).toBe(1);
  await expect(page.getByRole("region", { name: "Trace lookup" })).not.toContainText("First service");
  await page.getByRole("button", { name: "Load trace", exact: true }).click();
  await page.getByRole("region", { name: "HTTP response" }).getByRole("tab", { name: /^Headers/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).traceTest.cancelled)).toBe(2);
  await page.evaluate(() => { (window as any).traceTest.waiters.splice(0).forEach((resolve: () => void) => resolve()); });
  await page.getByRole("tab", { name: "Trace", exact: true }).click();
  await page.evaluate(() => { (window as any).traceTest.mode = "empty"; });
  await page.getByRole("button", { name: "Load trace", exact: true }).click();
  await expect(page.getByRole("region", { name: "Trace lookup" })).toContainText("No trace was found");
  await page.evaluate(() => { (window as any).traceTest.mode = "malformed"; });
  await page.getByRole("button", { name: "Load trace", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("trace lookup failed");
  await expect(page.getByRole("region", { name: "Trace lookup" })).not.toContainText("should-not-render");
});
