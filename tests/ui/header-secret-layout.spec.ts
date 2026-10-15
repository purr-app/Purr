import { expect, test } from "@playwright/test";

test("sensitive and public headers keep the same value and lock columns", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: /^Auth/ }).click();
  await page.getByRole("tab", { name: "Bearer Token", exact: true }).click();
  await page.getByLabel("Bearer token", { exact: true }).fill("synthetic-auth-token");
  await page.getByRole("tab", { name: /^Headers/ }).click();
  for (const name of ["X-Secret", "X-Public"]) {
    await page.getByPlaceholder("Header-name").last().fill(name);
    await page.getByLabel(`Value for ${name}`, { exact: true }).fill(`synthetic-${name}`);
  }
  await page.getByRole("button", { name: "Sensitive X-Secret", exact: true }).click();
  const secret = page.getByLabel("Value for X-Secret", { exact: true });
  const ordinary = page.getByLabel("Value for X-Public", { exact: true });
  await expect(secret).toHaveAttribute("type", "password");
  const secretBox = (await secret.boundingBox())!;
  const publicBox = (await ordinary.boundingBox())!;
  expect(Math.abs(secretBox.x - publicBox.x)).toBeLessThan(1);
  expect(Math.abs(secretBox.width - publicBox.width)).toBeLessThan(1);
  const authBox = (await page.getByLabel("Value for Authorization", { exact: true }).boundingBox())!;
  expect(Math.abs(secretBox.x - authBox.x)).toBeLessThan(1);
  expect(Math.abs(secretBox.width - authBox.width)).toBeLessThan(1);
  const secretLock = (await page.getByRole("button", { name: "Sensitive X-Secret", exact: true }).boundingBox())!;
  const publicLock = (await page.getByRole("button", { name: "Sensitive X-Public", exact: true }).boundingBox())!;
  expect(Math.abs(secretLock.x - publicLock.x)).toBeLessThan(1);
  await page.getByRole("button", { name: "Reveal Value for X-Secret", exact: true }).click();
  await expect(secret).toHaveValue("synthetic-X-Secret");
  await expect(secret).toHaveAttribute("type", "text");
});
