import { expect, test } from "@playwright/test";

const owner = "Synthetic fixture / token";
test.beforeEach(async ({ page }) => {
  await page.route("**/__required-secret-tests", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Required secrets fixture</title>" }));
  await page.goto("/__required-secret-tests");
  await page.evaluate(async () => {
    const refreshPath = "/@react-refresh";
    const refresh = (await import(refreshPath)).default;
    refresh.injectIntoGlobalHook(window);
    Object.assign(window, { $RefreshReg$: () => {}, $RefreshSig$: () => (type: unknown) => type, __vite_plugin_react_preamble_installed__: true });
    const path = "/tests/fixtures/required-local-secrets-harness.tsx";
    const { mountRequiredSecretsFixture } = await import(path);
    Object.assign(window, { secretFixture: await mountRequiredSecretsFixture() });
  });
});

test("required secrets editor never prefills stored values and distinguishes empty set from removal", async ({ page }) => {
  await expect(page.getByText("Available locally", { exact: true })).toBeVisible();
  await expect(page.getByText(/format v1/)).toBeVisible();
  await expect(page.getByText("MUST_NOT_RENDER_EXISTING_VALUE")).toHaveCount(0);
  await page.getByRole("button", { name: `Set value for ${owner}`, exact: true }).click();
  await expect(page.getByLabel(`New local value for ${owner}`, { exact: true })).toHaveAttribute("type", "password");
  await expect(page.getByLabel(`New local value for ${owner}`, { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Save local value", exact: true }).click();
  await expect(page.getByText("Local value saved.", { exact: true })).toBeVisible();
  await expect(page.getByText("Available locally", { exact: true })).toBeVisible();
  const saved = await page.evaluate(() => (window as unknown as { secretFixture: { events: unknown[] } }).secretFixture.events);
  expect(saved).toEqual([{ ref: "purr/secret-fixture/variables/token", value: "" }]);
  await page.getByRole("button", { name: `Remove local value for ${owner}`, exact: true }).click();
  await expect(page.getByText("Missing locally", { exact: true })).toBeVisible();
  const removed = await page.evaluate(() => (window as unknown as { secretFixture: { events: unknown[] } }).secretFixture.events);
  expect(removed).toEqual([{ ref: "purr/secret-fixture/variables/token", value: "" }, { ref: "purr/secret-fixture/variables/token", value: null }]);
  await expect(page.getByRole("button", { name: `Set value for ${owner}`, exact: true })).toBeEnabled();
});

test("unknown protected baseline disables editing while retaining owner and retry actions", async ({ page }) => {
  await page.evaluate(() => (window as unknown as { secretFixture: { render: (state: { status: string; code: string }) => void } }).secretFixture.render({ status: "corrupt", code: "synthetic-corruption" }));
  await expect(page.getByText(/Protected storage is corrupt/)).toBeVisible();
  await expect(page.getByRole("button", { name: `Set value for ${owner}`, exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: `Remove local value for ${owner}`, exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Open owner", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Retry / Unlock", exact: true })).toBeEnabled();
});
