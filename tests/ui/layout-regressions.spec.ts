import { expect, test } from "@playwright/test";
import { installPersistenceMock } from "./persistence-mock";

test.beforeEach(async ({ page }) => installPersistenceMock(page));

test("multipart fields keep usable name, type, and value columns", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Body", exact: true }).click();
  await page.getByRole("tab", { name: "Form-Data", exact: true }).click();
  const row = page.locator(".ui-multipart-row").first();
  await expect(row).toHaveCSS("display", "grid");
  const name = row.getByRole("textbox", { name: "name", exact: true });
  const value = row.getByRole("textbox", { name: "form-data field value", exact: true });
  const type = row.getByRole("combobox", { name: "Field type" });
  expect((await name.boundingBox())!.width).toBeGreaterThan(100);
  expect((await value.boundingBox())!.width).toBeGreaterThan(150);
  expect((await type.boundingBox())!.width).toBeLessThanOrEqual(80);
  await name.fill("message");
  await row.getByRole("textbox", { name: "Value for message" }).fill("hello");
  await type.click();
  await page.getByRole("option", { name: "File", exact: true }).click();
  await expect(row.locator('button[aria-label="Choose file for message"]')).toBeVisible();
});
