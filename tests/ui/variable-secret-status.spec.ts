import { expect, test } from "@playwright/test";

test("secret status refreshes after a delayed save without reopening Variables", async ({ page }) => {
  await page.route("**/__variable-status-tests", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Variable status fixture</title>" }));
  await page.goto("/__variable-status-tests");
  await page.evaluate(async () => {
    const refresh = (await import("/@react-refresh")).default;
    refresh.injectIntoGlobalHook(window);
    Object.assign(window, { $RefreshReg$: () => {}, $RefreshSig$: () => (type: unknown) => type, __vite_plugin_react_preamble_installed__: true });
    const { mountVariableSecretStatusFixture } = await import("/tests/fixtures/variable-secret-status-harness.tsx");
    Object.assign(window, { variableStatusFixture: mountVariableSecretStatusFixture() });
  });
  await page.getByRole("button", { name: "Variable", exact: true }).click();
  await page.getByLabel("Variable name", { exact: true }).fill("new_secret");
  await page.getByLabel("Variable value", { exact: true }).fill("synthetic-secret-value");
  await page.getByRole("switch", { name: "Sensitive & masked secret", exact: true }).click();
  await page.getByRole("button", { name: "Save variable", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save variable", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Variable value new_secret", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).variableStatusFixture.finishSave());
  await expect(page.getByLabel("Variable value new_secret", { exact: true })).toHaveText("••••••••");
});
