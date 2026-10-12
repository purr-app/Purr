import { expect, test } from "@playwright/test";
import { installPersistenceMock } from "./persistence-mock";

for (const fixture of [
  { code: "root-key-conflict", message: "The available encryption keys do not match." },
  { code: "root-retirement-pending", message: "Key migration is incomplete because Purr could not remove the old plaintext key file." },
]) test(`${fixture.code} stays read-only across repeated explicit retries without changing protected data`, async ({ page }) => {
  await installPersistenceMock(page);
  await page.addInitScript(() => { (window as any).isTauri = true; (window as any).__TAURI_INTERNALS__ = { invoke: async () => undefined }; });
  await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("https://synthetic.test/root-key-recovery");
  await page.getByRole("tab", { name: /^Auth/ }).click();
  await page.getByRole("tab", { name: "Basic Auth", exact: true }).click();
  await page.getByLabel("Password", { exact: true }).fill("SYNTHETIC_VALUE_MUST_SURVIVE_RETRY");
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await page.getByLabel("Document name", { exact: true }).fill("Root recovery fixture");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("region", { name: "Workspace", exact: true })).toHaveAttribute("aria-busy", "false");
  const protectedData = () => page.evaluate(() => ({
    files: JSON.parse(localStorage.getItem("purr-native-persistence-test")!).workspaces[0].files,
    secrets: localStorage.getItem("purr-native-secure-test"),
    revisions: localStorage.getItem("purr-native-secure-revisions-test"),
  }));
  const original = await protectedData();
  await page.addInitScript((code) => { (window as any).__purrProtectedState = { status: "recovery-required", code }; }, fixture.code);
  await page.reload();
  await expect(page.getByText(fixture.message, { exact: false }).first()).toBeVisible();
  await page.evaluate(() => {
    const native = (window as any).__TAURI_INTERNALS__;
    const invoke = native.invoke;
    (window as any).__rootRetryCount = 0;
    native.invoke = (command: string, args: unknown) => {
      if (command === "retry_protected_storage") (window as any).__rootRetryCount++;
      return invoke(command, args);
    };
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole("button", { name: "GET Root recovery fixture", exact: true }).click();
    await page.getByRole("tab", { name: /^Headers/ }).click();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Required local secrets", exact: true }).click();
    await expect(page.getByRole("region", { name: "Required local secrets", exact: true })).toContainText(fixture.message);
    expect(await page.evaluate(() => (window as any).__rootRetryCount)).toBe(attempt);
    await page.getByRole("button", { name: "Retry / Unlock", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__rootRetryCount)).toBe(attempt + 1);
    await expect(page.getByText(fixture.message, { exact: false }).first()).toBeVisible();
    expect(await protectedData()).toEqual(original);
  }
  await page.getByRole("button", { name: "Required local secrets", exact: true }).click();
  await page.evaluate(() => { (window as any).__purrProtectedState = { status: "available" }; });
  await page.getByRole("button", { name: "Retry / Unlock", exact: true }).click();
  await expect(page.getByText(fixture.message, { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "GET Root recovery fixture", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: /^Auth/ }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("SYNTHETIC_VALUE_MUST_SURVIVE_RETRY");
});
