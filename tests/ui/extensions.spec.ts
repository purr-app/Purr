import { expect, test, type Page } from "@playwright/test";

import { installPersistenceMock } from "./persistence-mock";

test.beforeEach(async ({ page }) => installPersistenceMock(page));

const shell = (query = "modules=1") => `/tests/fixtures/extensions/index.html?${query}`;
const canonicalProjectContains = (page: Page, text: string) => page.evaluate(async (expected) => {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("purr-preview-v2", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const projects = await new Promise<unknown[]>((resolve, reject) => {
      const request = database.transaction("projects").objectStore("projects").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return JSON.stringify(projects).includes(expected);
  } finally { database.close(); }
}, text);

test("external module contributes navigation, a page action, and a restorable document editor", async ({ page }) => {
  await page.goto(shell());
  await expect(page.getByRole("navigation", { name: "Application extensions" })).toBeVisible();
  await page.getByRole("link", { name: "Synthetic extension", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Synthetic extension page", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run module action", exact: true }).click();
  await expect(page.getByText("Module-owned service count:")).toContainText("1");

  await page.getByRole("link", { name: "Workbench", exact: true }).click();
  await page.getByRole("button", { name: "Create document", exact: true }).click();
  await page.getByRole("menuitem", { name: "Synthetic protocol", exact: true }).click();
  await expect(page.getByRole("main", { name: "Synthetic protocol editor" })).toBeVisible();
  await page.getByLabel("Synthetic message", { exact: true }).fill("preserved across module absence");
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved locally" })).toBeVisible();
  await expect.poll(() => canonicalProjectContains(page, "preserved across module absence")).toBe(true);

  await page.goto(shell("modules=0"));
  await expect(page.getByRole("navigation", { name: "Application extensions" })).toHaveCount(0);
  await page.getByRole("button", { name: "EXT Synthetic protocol", exact: true }).click();
  await expect(page.getByRole("region", { name: "Unavailable extension document" })).toContainText("test.fake.protocol");
  await page.getByRole("button", { name: "EXT Synthetic protocol", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByLabel("Document name", { exact: true }).fill("Renamed protocol");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "EXT Renamed protocol", exact: true })).toBeVisible();
  await expect.poll(() => canonicalProjectContains(page, "Renamed protocol")).toBe(true);

  await page.goto(shell());
  await page.getByRole("button", { name: "EXT Renamed protocol", exact: true }).click();
  await expect(page.getByRole("main", { name: "Synthetic protocol editor" })).toBeVisible();
  await expect(page.getByLabel("Synthetic message", { exact: true })).toHaveValue("preserved across module absence");
});

test("incompatible composition reports the conflict before rendering a partial application", async ({ page }) => {
  await page.goto(shell("conflict=1"));
  await expect(page.getByRole("alert")).toHaveText("Duplicate extension module ID: test.fake");
  await expect(page.getByRole("navigation", { name: "Application extensions" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run module action", exact: true })).toHaveCount(0);
});
