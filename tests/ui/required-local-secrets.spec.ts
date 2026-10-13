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
  expect(saved).toEqual([{ ref: "purr/secret-fixture/credentials/variables/token", value: "" }]);
  await page.getByRole("button", { name: `Remove local value for ${owner}`, exact: true }).click();
  await expect(page.getByText("Missing locally", { exact: true })).toBeVisible();
  const removed = await page.evaluate(() => (window as unknown as { secretFixture: { events: unknown[] } }).secretFixture.events);
  expect(removed).toEqual([{ ref: "purr/secret-fixture/credentials/variables/token", value: "" }, { ref: "purr/secret-fixture/credentials/variables/token", value: null }]);
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

test("healthy secret refresh gives feedback without reloading or unlocking storage", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Retry / Unlock", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByText("Secret statuses refreshed.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).secretFixture.retries)).toEqual([]);
  await page.evaluate(() => (window as any).secretFixture.renderEmpty());
  await expect(page.getByRole("button", { name: "Refresh status", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry / Unlock", exact: true })).toHaveCount(0);
});

test("retry shows progress and reports storage that remains locked", async ({ page }) => {
  await page.evaluate(() => {
    (window as any).secretFixture.render({ status: "locked", code: "synthetic-locked" });
    (window as any).secretFixture.holdRetry();
  });
  await page.getByRole("button", { name: "Retry / Unlock", exact: true }).click();
  await expect(page.getByRole("button", { name: "Checking…", exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).secretFixture.releaseRetry());
  await expect(page.getByRole("alert")).toContainText("Protected storage is locked.");
  await expect(page.getByRole("button", { name: "Retry / Unlock", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: `Set value for ${owner}`, exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).secretFixture.events)).toEqual([]);
});

test("retry distinguishes restored access from a still unavailable runtime key", async ({ page }) => {
  await page.evaluate(() => {
    (window as any).secretFixture.render({ status: "available" }, { status: "unavailable", code: "synthetic-runtime" });
    (window as any).secretFixture.setRetryResult({ status: "available" });
  });
  await expect(page.getByText(/Protected response storage is unavailable/)).toBeVisible();
  await page.getByRole("button", { name: "Retry / Unlock", exact: true }).click();
  await expect(page.getByText("Protected storage access restored. Secret statuses refreshed.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh status", exact: true })).toBeVisible();
  await expect(page.getByText(/Protected response storage is unavailable/)).toHaveCount(0);
});


test("legacy local references direct the user to the owning field without allowing unscoped writes", async ({ page }) => {
  await page.evaluate(() => (window as unknown as { secretFixture: { renderLegacy(): void } }).secretFixture.renderLegacy());
  await expect(page.getByText(/reference belongs to an older storage format/)).toBeVisible();
  await expect(page.getByRole("button", { name: `Set value for ${owner}`, exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Open owner", exact: true }).click();
  const result = await page.evaluate(() => {
    const fixture = (window as unknown as { secretFixture: { events: unknown[]; owners: string[] } }).secretFixture;
    return { events: fixture.events, owners: fixture.owners };
  });
  expect(result.events).toEqual([]); expect(result.owners).toEqual(["token"]);
});
