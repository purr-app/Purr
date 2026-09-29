import { expect, test } from "@playwright/test";
import { installPersistenceMock } from "./persistence-mock";

test("dependency history identifies extraction failure while keeping the HTTP response inspectable", async ({ page }) => {
  await installPersistenceMock(page);
  await page.addInitScript(() => {
    (window as any).isTauri = true;
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => command === "start_http" ? {
        status: 200, statusText: "OK", durationMs: 12, httpVersion: "HTTP/2",
        headers: [["content-type", "application/json"]], bodyBase64: btoa('{"dependencyResponse":true}'),
      } : undefined,
    };
  });
  await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.test/dependency");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("purr-native-history-test") ?? "{}")).some((history: any) => history.entries.length > 0))).toBe(true);
  await page.evaluate(() => {
    const histories = JSON.parse(localStorage.getItem("purr-native-history-test")!);
    for (const history of Object.values(histories) as any[]) {
      for (const entry of history.entries) entry.dynamicExecution = {
        groupId: "chain", variableId: "token", variableName: "access_token", environmentId: null,
        extraction: { language: "jsonpath", expression: "$.token", status: "error", error: "The query did not match any response value." },
      };
    }
    localStorage.setItem("purr-native-history-test", JSON.stringify(histories));
  });
  await page.reload();
  await page.getByRole("navigation", { name: "Workspace activities" }).getByRole("button", { name: "History", exact: true }).click();
  const global = page.getByRole("region", { name: "Workspace request history", exact: true });
  await expect(global.getByLabel(/Dynamic vars execution · \{\{access_token\}\}/)).toBeVisible();
  await global.getByRole("listitem").first().locator("button").first().click();
  const response = page.getByRole("region", { name: "HTTP response", exact: true });
  await expect(response).toContainText("dependencyResponse");
  const badge = page.getByRole("button", { name: "Dynamic vars execution details", exact: true });
  await expect(badge).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("JSONPath extraction", { exact: true })).toHaveCount(0);
  await badge.click();
  await expect(page.getByText("JSONPath extraction", { exact: true })).toBeVisible();
  await expect(page.getByText("$.token", { exact: true })).toBeVisible();
  await expect(page.getByText("Extraction failed. The query did not match any response value.", { exact: true })).toBeVisible();
  await expect(response).toContainText("dependencyResponse");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Show response history", exact: true }).click();
  const local = page.getByRole("region", { name: "Document request history", exact: true });
  await expect(local.getByLabel(/Dynamic vars execution · \{\{access_token\}\}/)).toBeVisible();
  await expect(local.getByRole("listitem")).toContainText("200");
});
