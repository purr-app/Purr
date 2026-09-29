import { expect, test, type Page } from "@playwright/test";
import { installPersistenceMock } from "./persistence-mock";

const sourceUrl = "https://example.test/dependency";
const urlField = (page: Page) => page.getByLabel("Request URL", { exact: true });
const documentTabs = (page: Page) => page.getByRole("tablist", { name: "Documents", exact: true });
const entries = (page: Page) => page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("purr-native-history-test") ?? "{}")).flatMap((history: any) => history.entries) as any[]);

async function configure(page: Page, expression: string) {
  await installPersistenceMock(page);
  await page.addInitScript(() => {
    (window as any).isTauri = true;
    (window as any).__requests = [];
    (window as any).__slowDependency = false;
    (window as any).__cancellations = [];
    const pending = new Map<string, (reason: Error) => void>();
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: any) => {
        if (command === "cancel_http") {
          (window as any).__cancellations.push(args.operationId);
          pending.get(args.operationId)?.(new Error("Request canceled."));
          pending.delete(args.operationId);
          return;
        }
        if (command !== "start_http") return;
        (window as any).__requests.push(args.request);
        const dependency = args.request.url === "https://example.test/dependency";
        if (dependency && (window as any).__slowDependency) return new Promise((_, reject) => pending.set(args.operationId, reject));
        return { status: dependency ? 401 : 200, statusText: dependency ? "Unauthorized" : "OK", durationMs: 12,
          httpVersion: "HTTP/2", headers: [["content-type", "application/json"]],
          bodyBase64: btoa(JSON.stringify(dependency ? { error: { meta: "token" } } : { completed: true })) };
      },
    };
  });
  await page.goto("/");
  await urlField(page).fill(sourceUrl);
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await page.getByLabel("Document name", { exact: true }).fill("Dependency source");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect(documentTabs(page).getByRole("tab", { name: /Dependency source/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("purr-native-persistence-test") ?? "")).toContain("Dependency source");
  await page.getByRole("button", { name: "Open variables", exact: true }).click();
  await page.getByRole("navigation", { name: "Variable scopes" }).getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("button", { name: "Variable", exact: true }).click();
  await page.getByLabel("Variable name", { exact: true }).fill("dynamic_token");
  await page.getByRole("tab", { name: "Dynamic Request", exact: true }).click();
  await page.getByRole("combobox", { name: "Dynamic variable source request", exact: true }).click();
  await page.getByRole("option", { name: "Dependency source", exact: true }).click();
  await page.getByLabel("Response path", { exact: true }).fill(expression);
  await page.getByRole("button", { name: "Save variable", exact: true }).click();
}

async function sendRoot(page: Page) {
  await page.getByRole("button", { name: "New HTTP request", exact: true }).click();
  await urlField(page).fill("https://example.test/root/{{dynamic_token}}");
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

test("HTTP 401 dependencies resolve, execute the root, and appear in source/global history", async ({ page }) => {
  await configure(page, "$.error.meta");
  await sendRoot(page);
  await expect.poll(async () => (await entries(page)).length).toBe(2);
  expect(await page.evaluate(() => (window as any).__requests.map((request: any) => request.url))).toEqual([sourceUrl, "https://example.test/root/token"]);
  const recorded = await entries(page);
  const dependency = recorded.find((entry) => entry.url === sourceUrl);
  expect(dependency.status).toBe(401);
  expect(dependency.outcome).toBe("response");
  expect(dependency.dynamicExecution.variableName).toBe("dynamic_token");
  expect(dependency.dynamicExecution.extraction.status).toBe("success");
  expect(recorded.find((entry) => entry.url.includes("/root/"))?.dynamicExecution).toBeUndefined();
  await page.getByRole("navigation", { name: "Workspace activities" }).getByRole("button", { name: "History", exact: true }).click();
  const global = page.getByRole("region", { name: "Workspace request history", exact: true });
  await expect(global.getByRole("listitem")).toHaveCount(2);
  await expect(global.getByLabel("Dynamic vars execution · {{dynamic_token}}", { exact: true })).toBeVisible();
  await documentTabs(page).getByRole("tab", { name: /Dependency source/ }).click();
  await page.getByRole("button", { name: "Show response history", exact: true }).click();
  const local = page.getByRole("region", { name: "Document request history", exact: true });
  await expect(local.getByRole("listitem")).toHaveCount(1);
  await expect(local.getByRole("listitem")).toContainText("401");
  await local.getByRole("listitem").locator("button").first().click();
  await expect(page.getByRole("button", { name: "Dynamic vars execution details", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "HTTP response", exact: true })).toContainText("token");
});

test("failed extraction blocks root and opens the actual dependency response from the chain", async ({ page }) => {
  await configure(page, "$.missing");
  await sendRoot(page);
  await expect.poll(async () => (await entries(page)).length).toBe(1);
  expect(await page.evaluate(() => (window as any).__requests.map((request: any) => request.url))).toEqual([sourceUrl]);
  const dependency = (await entries(page))[0];
  expect(dependency.status).toBe(401);
  expect(dependency.outcome).toBe("response");
  expect(dependency.dynamicExecution.extraction.status).toBe("error");
  const chain = page.getByRole("region", { name: "Dynamic request dependencies", exact: true });
  await expect(chain).toContainText("Not sent");
  await expect(chain).toContainText("HTTP 401 · Failed");
  await expect(chain).toContainText("The query did not match any response value.");
  await expect(page.getByRole("region", { name: "HTTP response", exact: true })).toHaveCount(0);
  await expect(chain.getByRole("button", { name: "Open execution of Dependency source", exact: true })).toBeInViewport();
  await page.screenshot({ path: "test-results/dynamic-chain.png" });
  const before = await documentTabs(page).getByRole("tab").count();
  await chain.getByRole("button", { name: "Open execution of Dependency source", exact: true }).click();
  await expect(documentTabs(page).getByRole("tab")).toHaveCount(before + 1);
  const response = page.getByRole("region", { name: "HTTP response", exact: true });
  await expect(response).toContainText("401 Unauthorized");
  await expect(response).toContainText("token");
  await page.getByRole("button", { name: "Dynamic vars execution details", exact: true }).click();
  await expect(page.getByText("Extraction failed. The query did not match any response value.", { exact: true })).toBeVisible();
  await expect(response).toContainText("token");
});

test("manual variable Execute records only its dispatched dependency", async ({ page }) => {
  await configure(page, "$.error.meta");
  await page.getByRole("button", { name: "Execute", exact: true }).click();
  await expect.poll(async () => (await entries(page)).length).toBe(1);
  const record = (await entries(page))[0];
  expect(record.url).toBe(sourceUrl);
  expect(record.dynamicExecution.extraction.status).toBe("success");
  expect(await page.evaluate(() => (window as any).__requests.length)).toBe(1);
  await page.getByRole("button", { name: "Open execution of Dependency source", exact: true }).click();
  await expect(page.getByRole("button", { name: "Dynamic vars execution details", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "HTTP response", exact: true })).toContainText("401 Unauthorized");
});

test("returning to an in-flight dependency then cancelling aborts its original execution", async ({ page }) => {
  await configure(page, "$.error.meta");
  await page.evaluate(() => { (window as any).__slowDependency = true; });
  await sendRoot(page);
  await expect.poll(() => page.evaluate(() => (window as any).__requests.length)).toBe(1);
  await documentTabs(page).getByRole("tab", { name: /Dependency source/ }).click();
  expect(await page.evaluate(() => (window as any).__cancellations.length)).toBe(0);
  await documentTabs(page).getByRole("tab", { name: /example.test\/root\// }).click();
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => (window as any).__cancellations.length)).toBe(1);
  await expect.poll(async () => (await entries(page)).length).toBe(1);
  const record = (await entries(page))[0];
  expect(record.url).toBe(sourceUrl);
  expect(record.outcome).toBe("cancelled");
  expect(record.dynamicExecution.variableName).toBe("dynamic_token");
  expect(record.dynamicExecution.extraction).toBeUndefined();
  expect(await page.evaluate(() => (window as any).__requests.map((request: any) => request.url))).toEqual([sourceUrl]);
});

test("dynamic request code exports a chain without execution and disables other formats", async ({ page }) => {
  await configure(page, "$.error.meta");
  await page.getByRole("button", { name: "New HTTP request", exact: true }).click();
  await urlField(page).fill("https://example.test/root/{{dynamic_token}}");
  await page.getByRole("button", { name: "Open request code", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Request code", exact: true });
  await expect(dialog.getByRole("tab", { name: "wget", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("tab", { name: "HTTP/1.1", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("tab", { name: "cURL", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByLabel("Request code viewer")).toContainText("purr_dynamic_token=$(");
  await expect(dialog.getByLabel("Request code viewer")).toContainText("jq -c '.error.meta'");
  await expect(dialog.getByLabel("Request code viewer")).not.toContainText("#!/usr/bin/env");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__requests)).toEqual([]);
  expect(await entries(page)).toEqual([]);
});
