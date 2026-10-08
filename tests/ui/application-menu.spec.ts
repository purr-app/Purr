import { test, expect } from "@playwright/test";
import { installPersistenceMock } from "./persistence-mock";

test("More menu opens external destinations, restores focus and removes footer", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__opened = [];
    window.open = (url) => { (window as any).__opened.push(String(url)); return null; };
  });
  await page.goto("/");
  const more = page.getByRole("button", { name: "More", exact: true });
  await more.click();
  const menu = page.getByRole("menu", { name: "Application menu" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Home");
  await expect(page.getByRole("menuitem", { name: "Documentation", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "What’s new", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  for (const [label, url] of [
    ["Documentation", "https://usepurr.com/docs/"], ["What’s new", "https://usepurr.com/changelog/"],
    ["Report a bug", "https://github.com/purr-app/Purr/issues"], ["Feedback / Request a feature", "https://github.com/purr-app/Purr/discussions"],
    ["GitHub", "https://github.com/purr-app/Purr"], ["Homepage", "https://usepurr.com/"],
  ]) {
    await more.click(); await page.getByRole("menuitem", { name: label, exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__opened.at(-1))).toBe(url);
    await expect(menu).toHaveCount(0);
  }
  await expect(page.locator("footer")).toHaveCount(0);
});

test("dev previews share the toast queue and offer retry without real updates", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "UI previews", exact: true }).click();
  await page.getByRole("menuitem", { name: "Retry action", exact: true }).click();
  const error = page.getByRole("alert");
  await expect(error).toContainText("Preview: retry");
  await error.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Preview: recovered" })).toBeVisible();
  await page.getByRole("button", { name: "Dismiss Preview: recovered" }).click();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "UI previews", exact: true }).click();
  await page.getByRole("menuitem", { name: "Toast queue", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Preview: queued/ })).toHaveCount(3);
  await page.getByRole("button", { name: "Dismiss Preview: queued 1" }).click();
  await expect(page.getByRole("heading", { name: "Preview: queued 4" })).toBeVisible();
});

test("private menu actions open scoped pages and dialogs and report failures", async ({ page }) => {
  await page.goto("/tests/fixtures/extensions/index.html");
  const more = page.getByRole("button", { name: "More", exact: true });
  await more.click();
  await expect(page.getByRole("group", { name: "Extension actions" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Extension dialog", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Extension dialog" })).toBeVisible();
  await page.getByRole("button", { name: "Close extension dialog", exact: true }).click();
  await more.click();
  await page.getByRole("menuitem", { name: "Fail extension action" }).click();
  await expect(page.getByRole("alert")).toContainText("Extension action failed");
  await more.click();
  await page.getByRole("menuitem", { name: "Open extension dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Synthetic extension page" })).toBeVisible();
});

test("save errors offer retry and clear after persistence succeeds", async ({ page }) => {
  await installPersistenceMock(page);
  await page.addInitScript(() => {
    (window as any).isTauri = true;
    (window as any).__TAURI_INTERNALS__ = { invoke: async () => undefined };
  });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Workspace", exact: true })).toHaveAttribute("aria-busy", "false");
  await page.evaluate(() => { (window as any).__purrFailSave = true; });
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/retry");
  await expect(page.getByRole("alert")).toContainText("Could not save workspace");
  const before = await page.evaluate(() => localStorage.getItem("purr-native-persistence-test"));
  await page.evaluate(() => { (window as any).__purrFailSave = false; });
  await page.getByRole("button", { name: "Reload and retry" }).click();
  await expect(page.getByRole("heading", { name: "Could not save workspace" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("purr-native-persistence-test"))).not.toBe(before);
});

test("toast expiry pauses while hovered or focused", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "UI previews", exact: true }).click();
  await page.getByRole("menuitem", { name: "info toast", exact: true }).click();
  const toast = page.getByRole("status").filter({ hasText: "Preview: info" });
  await toast.hover();
  await page.clock.fastForward(6000);
  await expect(toast).toBeVisible();
  await toast.getByRole("button").focus();
  await page.mouse.move(500, 100);
  await page.clock.fastForward(6000);
  await expect(toast).toBeVisible();
  await page.getByRole("button", { name: "More", exact: true }).focus();
  await page.clock.fastForward(5001);
  await expect(toast).toHaveCount(0);
});
