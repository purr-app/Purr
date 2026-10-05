import { expect, test } from "@playwright/test";
import { installPersistenceMock } from "./persistence-mock";

test.beforeEach(async ({ page }) => installPersistenceMock(page));

test("long environment scrolls inside Variables without moving the application page", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { createCoreServices } = await import("/src/app/composition/core-services.ts" as string);
    const persistence = createCoreServices().persistence;
    const store = await persistence.load();
    const workspace = store.workspaces[0];
    workspace.environments.push({ id: "long-environment", name: "Long environment", variables: Array.from({ length: 60 }, (_, index) => ({
      id: `variable-${index}`, name: `variable_${index}`, value: `value_${index}`, kind: "static" as const, enabled: true, sensitive: false,
    })) });
    await persistence.save(store);
  });
  await page.reload();
  await page.getByRole("button", { name: "Open variables", exact: true }).click();
  await page.getByRole("navigation", { name: "Variable scopes" }).getByRole("button", { name: "Long environment" }).click();
  const list = page.getByRole("region", { name: "Variable list" });
  const before = await list.evaluate((element) => ({ height: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(before.scrollHeight).toBeGreaterThan(before.height);
  await list.hover();
  await page.mouse.wheel(0, 900);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.evaluate(() => window.scrollTo(0, 900));
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).toBe("clip");
});
