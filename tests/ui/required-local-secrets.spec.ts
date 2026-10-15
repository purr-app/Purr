import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/__required-secret-tests", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Required secrets fixture</title>" }));
  await page.goto("/__required-secret-tests");
  await page.evaluate(async () => {
    const refresh = (await import("/@react-refresh")).default;
    refresh.injectIntoGlobalHook(window);
    Object.assign(window, { $RefreshReg$: () => {}, $RefreshSig$: () => (type: unknown) => type, __vite_plugin_react_preamble_installed__: true });
    await import("/src/styles/globals.css");
    const { mountRequiredSecretsFixture } = await import("/tests/fixtures/required-local-secrets-harness.tsx");
    Object.assign(window, { secretFixture: await mountRequiredSecretsFixture() });
  });
  await page.getByRole("button", { name: "Manage secrets" }).click();
});

test("manager masks values, forbids empty replacements and makes removal missing", async ({ page }) => {
  const value = page.getByLabel("Secret value token", { exact: true });
  await expect(value).toHaveValue("••••••••");
  await expect(page.getByText("MUST_NOT_RENDER_EXISTING_VALUE")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).secretFixture.resolutionCalls())).toBe(0);
  await expect(value).toBeDisabled();
  await value.click({ force: true });
  await expect(page.getByRole("button", { name: "Save value" })).toHaveCount(0);
  await page.getByRole("button", { name: "Edit token", exact: true }).click();
  await expect(value).toHaveValue("");
  await expect(page.getByRole("button", { name: "Save value" })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const before = await dialog.boundingBox();
  const row = value.locator("..");
  const rowBefore = await row.boundingBox();
  await page.getByRole("button", { name: "Remove token" }).click();
  await expect(page.getByText("Remove local value for “token”?", { exact: true })).toBeVisible();
  await expect(value).toHaveCount(0);
  const confirmation = page.getByRole("button", { name: "Confirm remove" });
  await expect(confirmation).toHaveClass(/text-accent-red/);
  expect((await dialog.boundingBox())?.height).toBe(before?.height);
  const confirmationRow = confirmation.locator("../..");
  expect((await confirmationRow.boundingBox())?.height).toBe(rowBefore?.height);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(value).toHaveValue("••••••••");
  await page.getByRole("button", { name: "Remove token" }).click();
  await confirmation.click();
  await expect(value).toHaveAttribute("placeholder", "Missing locally");
  expect(await page.evaluate(() => (window as any).secretFixture.events)).toEqual([
    { ref: "purr/secret-fixture/credentials/variables/token", value: null },
  ]);
});

test("search, reveal and explicit save affect only the selected secret", async ({ page }) => {
  await page.getByLabel("Find local secrets").fill("token");
  await page.getByRole("button", { name: "Reveal token" }).click();
  const value = page.getByLabel("Secret value token", { exact: true });
  await expect(value).toHaveValue("MUST_NOT_RENDER_EXISTING_VALUE");
  expect(await page.evaluate(() => (window as any).secretFixture.resolutionCalls())).toBe(1);
  await expect(value).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save value" })).toHaveCount(0);
  await page.getByRole("button", { name: "Hide token", exact: true }).click();
  await expect(value).toHaveValue("••••••••");
  await page.getByRole("button", { name: "Edit token", exact: true }).click();
  await expect(value).toHaveValue("");
  await expect(value).toHaveAttribute("placeholder", "Enter replacement value…");
  await value.fill("replacement-after-retry");
  await page.evaluate(() => (window as any).secretFixture.failSave());
  await page.getByRole("button", { name: "Save value" }).click();
  await expect(page.getByRole("alert")).toContainText("Your entry is preserved");
  await expect(value).toHaveValue("replacement-after-retry");
  await page.getByRole("button", { name: "Save value" }).click();
  expect(await page.evaluate(() => (window as any).secretFixture.events)).toEqual([
    { ref: "purr/secret-fixture/credentials/variables/token", value: "replacement-after-retry" },
  ]);
  await expect(value).toBeDisabled();
  await expect(value).toHaveValue("••••••••");
  await page.getByLabel("Find local secrets").fill("absent");
  await expect(page.getByText("No secrets match this search.")).toBeVisible();
});

test("locked storage can be retried without exposing the value", async ({ page }) => {
  await page.evaluate(() => (window as any).secretFixture.render({ status: "locked", code: "synthetic-locked" }));
  await expect(page.getByRole("button", { name: "Retry / Unlock" })).toBeVisible();
  await expect(page.getByLabel("Secret value token")).toBeDisabled();
  await page.evaluate(() => (window as any).secretFixture.setRetryResult({ status: "available" }));
  await page.getByRole("button", { name: "Retry / Unlock" }).click();
  await expect(page.getByRole("button", { name: "Retry / Unlock" })).toHaveCount(0);
  await expect(page.getByLabel("Secret value token")).toHaveValue("••••••••");
});

test("legacy reference remains read only and can open its owner", async ({ page }) => {
  await page.evaluate(() => (window as any).secretFixture.renderLegacy());
  await expect(page.getByLabel("Secret value token")).toBeDisabled();
  await expect(page.getByText(/older secret reference/)).toBeVisible();
  await page.getByRole("button", { name: "Open owner of token" }).click();
  expect(await page.evaluate(() => (window as any).secretFixture.owners)).toEqual(["token"]);
});
