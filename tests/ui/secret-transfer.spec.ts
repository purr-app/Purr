import { expect, test, type Page } from "@playwright/test";
import { installSecretTransferMock } from "../fixtures/secret-transfer-mock";

async function openSettings(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Select workspace" }).click();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  await page.getByRole("tab", { name: "Secrets and encryption", exact: true }).click();
}
async function calls(page: Page) { return page.evaluate(() => (window as any).__transferCalls); }
async function password(page: Page) {
  await expect(page.getByRole("dialog").locator("input").first()).toBeFocused();
  await page.getByLabel("Package password", { exact: true }).fill(" synthetic password ");
  await page.getByLabel("Confirm password", { exact: true }).fill(" synthetic password ");
}

test("browser clearly exposes desktop-only transfer without fallback", async ({ page }) => {
  await openSettings(page);
  await expect(page.getByRole("button", { name: "Export secrets", exact: true })).toBeDisabled();
  await expect(page.getByText("Secret transfer and recovery require the Purr desktop app.")).toBeVisible();
});

test("selected export requires selection and password, preserves spaces, explicitly omits unavailable secrets", async ({ page }) => {
  await installSecretTransferMock(page); await openSettings(page);
  await page.getByRole("button", { name: "Export secrets", exact: true }).click();
  const write = page.getByRole("button", { name: "Choose export file", exact: true });
  await password(page); await expect(write).toBeEnabled();
  await page.getByRole("checkbox", { name: "Bearer token", exact: true }).check();
  await expect(write).toBeEnabled();
  await expect(page.getByRole("region", { name: "Unavailable secrets" })).toContainText("No saved value on this device");
  await page.getByRole("checkbox", { name: "Exclude missing value", exact: true }).check();
  await expect(write).toBeEnabled();
  await expect(page.getByText(/Referenced dependencies/)).toContainText("GLOBAL_HOST");
  await write.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const action = (await calls(page)).find((entry: any) => entry.type === "exportSelected");
  expect(action.references).toEqual(["saved-token"]); expect(action.omittedRefs).toEqual(["saved-missing"]);
  expect(action.password).toBe(" synthetic password "); expect(action.operationId).toBeTruthy();
});

test("export filter preserves selection and live validation explains disabled action", async ({ page }) => {
  await installSecretTransferMock(page); await openSettings(page);
  await page.getByRole("button", { name: "Export secrets", exact: true }).click();
  const write = page.getByRole("button", { name: "Choose export file", exact: true });
  await page.getByRole("checkbox", { name: "Bearer token", exact: true }).check();
  await page.getByLabel("Find saved secrets").fill("missing");
  await expect(page.getByText(/explicitly omitted/)).toHaveCount(0);
  await page.getByLabel("Find saved secrets").fill("does-not-exist");
  await expect(page.getByText("No saved secrets match this search. Selected secrets remain selected.")).toBeVisible();
  await page.getByLabel("Package password", { exact: true }).fill("short");
  await expect(page.getByRole("alert")).toContainText("at least 12 characters");
  await page.getByLabel("Package password", { exact: true }).fill("😀".repeat(12));
  await expect(page.getByRole("alert")).toContainText("Confirm the package password");
  await page.getByLabel("Confirm password", { exact: true }).fill("different value");
  await expect(page.getByRole("alert")).toContainText("Passwords do not match");
  await page.getByLabel("Confirm password", { exact: true }).fill("😀".repeat(12));
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(write).toBeEnabled();
});

test("select all includes available secrets only", async ({ page }) => {
  await installSecretTransferMock(page); await openSettings(page);
  await page.getByRole("button", { name: "Export secrets", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Bearer token", exact: true })).toBeChecked();
  await expect(page.getByRole("region", { name: "Unavailable secrets" })).toContainText("Missing password");
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Bearer token", exact: true })).not.toBeChecked();
});

test("import preview keeps existing values by default and disables unknown declarations", async ({ page }) => {
  await installSecretTransferMock(page); await openSettings(page);
  await page.getByRole("button", { name: "Import secrets", exact: true }).click();
  await expect(page.getByLabel("Package password", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Choose package", exact: true }).click();
  await page.getByLabel("Package password", { exact: true }).fill("synthetic password");
  await page.getByRole("button", { name: "Preview secrets", exact: true }).click();
  const actions = await calls(page);
  expect(actions.findIndex((action: any) => action.type === "selectImportFile")).toBeLessThan(actions.findIndex((action: any) => action.type === "prepareImport"));
  expect(actions.find((action: any) => action.type === "prepareImport").stagedId).toBe("synthetic-selected-file");
  await expect(page.getByRole("checkbox", { name: "Import: New token", exact: true })).toBeChecked();
  const replace = page.getByRole("checkbox", { name: "Replace: Existing token", exact: true });
  await expect(replace).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Unavailable here: Unknown token", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Package password", { exact: true })).toHaveCount(0);
  await replace.check();
  await page.getByRole("button", { name: "Import selected values", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await calls(page)).find((entry: any) => entry.type === "commitImport").references).toEqual(["new-token", "existing-token"]);
  await expect(page.getByText("Secrets imported. Current device keys were preserved and secret statuses refreshed.")).toBeVisible();
});

test("failed package preparation clears password and never commits", async ({ page }) => {
  await installSecretTransferMock(page, { invalidImport: true }); await openSettings(page);
  await page.getByRole("button", { name: "Import secrets", exact: true }).click();
  await page.getByRole("button", { name: "Choose package", exact: true }).click();
  await page.getByLabel("Package password", { exact: true }).fill("wrong synthetic password");
  await page.getByRole("button", { name: "Preview secrets", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("No values were imported");
  await expect(page.getByLabel("Package password", { exact: true })).toHaveValue("");
  expect((await calls(page)).some((entry: any) => entry.type === "commitImport")).toBe(false);
});

test("cancel drops import preview; recovery requests matching key and backup passwords", async ({ page }) => {
  await installSecretTransferMock(page); await openSettings(page);
  await page.getByRole("button", { name: "Recovery options", exact: true }).click();
  await page.getByRole("dialog", { name: "Recovery", exact: true }).getByRole("button", { name: "Recover secrets", exact: true }).click();
  await expect(page.getByLabel("Recovery key password", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Choose recovery files", exact: true }).click();
  await expect(page.getByLabel("Recovery key password", { exact: true })).toBeFocused();
  await page.getByLabel("Recovery key password", { exact: true }).fill("synthetic key password");
  await page.getByLabel("Credential backup password", { exact: true }).fill("synthetic backup password");
  await page.getByRole("button", { name: "Preview secrets", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Review secret import", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(async () => (await calls(page)).find((entry: any) => entry.type === "cancel")?.previewId).toBe("synthetic-preview");
  const prepare = (await calls(page)).find((entry: any) => entry.type === "prepareRecovery");
  expect(prepare.stagedId).toBe("synthetic-recovery-files");
  expect((await calls(page)).findIndex((entry: any) => entry.type === "selectRecoveryFiles")).toBeLessThan((await calls(page)).findIndex((entry: any) => entry.type === "prepareRecovery"));
  expect(prepare.keyPassword).toBe("synthetic key password"); expect(prepare.backupPassword).toBe("synthetic backup password");
});

test("workspace export opens the native folder picker directly", async ({ page }) => {
  await installSecretTransferMock(page); await openSettings(page);
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await page.getByRole("button", { name: "Export workspace", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await calls(page)).some((entry: any) => entry.type === "exportConfiguration")).toBe(true);
  await expect(page.getByText("Export workspace completed.", { exact: true })).toBeVisible();
});

test("recovery actions have a compact password dialog and return to the recovery menu", async ({ page }) => {
  await installSecretTransferMock(page); await openSettings(page);
  await page.getByRole("button", { name: "Recovery options", exact: true }).click();
  const menu = page.getByRole("dialog", { name: "Recovery", exact: true });
  await expect(menu).toContainText("credential backup");
  await expect(menu).toBeFocused();
  await expect(menu.getByRole("link", { name: "Purr documentation" })).toHaveAttribute("href", "https://usepurr.com/docs/");
  await menu.getByRole("button", { name: "Export recovery key", exact: true }).click();
  const passwordDialog = page.getByRole("dialog", { name: "Export recovery key", exact: true });
  const bounds = await passwordDialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.height).toBeLessThan((page.viewportSize()?.height ?? 900) / 2);
  await passwordDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(menu).toBeVisible();
  await menu.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("busy export cancellation calls native operation cancel and reports actual result", async ({ page }) => {
  await installSecretTransferMock(page, { delayedExport: true }); await openSettings(page);
  await page.getByRole("button", { name: "Recovery options", exact: true }).click();
  await page.getByRole("dialog", { name: "Recovery", exact: true }).getByRole("button", { name: "Export recovery key", exact: true }).click();
  await password(page);
  await page.getByRole("button", { name: "Choose export file", exact: true }).click();
  await expect(page.getByRole("button", { name: "Working…", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("Export cancelled.", { exact: true })).toBeVisible();
  const actions = await calls(page);
  expect(actions.find((entry: any) => entry.type === "cancel").operationId).toBe(actions.find((entry: any) => entry.type === "exportRecoveryKey").operationId);
});

test("lost commit reply retains operation identity and checks receipt without repeating import", async ({ page }) => {
  await installSecretTransferMock(page, { lostCommitReply: true }); await openSettings(page);
  await page.getByRole("button", { name: "Import secrets", exact: true }).click();
  await page.getByRole("button", { name: "Choose package", exact: true }).click();
  await page.getByLabel("Package password", { exact: true }).fill("synthetic password");
  await page.getByRole("button", { name: "Preview secrets", exact: true }).click();
  await page.getByRole("button", { name: "Import selected values", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("operation ID is preserved");
  await page.getByRole("button", { name: "Check outcome", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await calls(page)).filter((entry: any) => entry.type === "commitImport")).toHaveLength(1);
});


test("expired preview cannot publish any values", async ({ page }) => {
  await installSecretTransferMock(page, { expiredPreview: true }); await openSettings(page);
  await page.getByRole("button", { name: "Import secrets", exact: true }).click();
  await page.getByRole("button", { name: "Choose package", exact: true }).click();
  await page.getByLabel("Package password", { exact: true }).fill("synthetic password");
  await page.getByRole("button", { name: "Preview secrets", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Preview expired or invalidated");
  await expect(page.getByRole("button", { name: "Import selected values", exact: true })).toBeDisabled();
  expect((await calls(page)).some((entry: any) => entry.type === "commitImport")).toBe(false);
});


test("incoming values reveal individually and hide without changing import selection", async ({ page }) => {
  await installSecretTransferMock(page); await openSettings(page);
  await page.getByRole("button", { name: "Import secrets", exact: true }).click();
  await page.getByRole("button", { name: "Choose package", exact: true }).click();
  await page.getByLabel("Package password", { exact: true }).fill("synthetic password");
  await page.getByRole("button", { name: "Preview secrets", exact: true }).click();
  expect((await calls(page)).some((entry: any) => entry.type === "revealPreviewValue")).toBe(false);
  await page.getByRole("button", { name: "Reveal incoming Existing token", exact: true }).click();
  await expect(page.getByLabel("Incoming value Existing token", { exact: true })).toHaveText("synthetic incoming existing-token");
  await expect(page.getByRole("checkbox", { name: "Replace: Existing token", exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Reveal incoming New token", exact: true }).click();
  await expect(page.getByLabel("Incoming value Existing token", { exact: true })).toHaveText("••••••••");
  await expect(page.getByLabel("Incoming value New token", { exact: true })).toHaveText("synthetic incoming new-token");
  await page.getByRole("button", { name: "Hide incoming New token", exact: true }).click();
  await expect(page.getByLabel("Incoming value New token", { exact: true })).toHaveText("••••••••");
});


test("import select all includes replacements but excludes unknown declarations", async ({ page }) => {
  await installSecretTransferMock(page); await openSettings(page);
  await page.getByRole("button", { name: "Import secrets", exact: true }).click();
  await page.getByRole("button", { name: "Choose package", exact: true }).click();
  await page.getByLabel("Package password", { exact: true }).fill("synthetic password");
  await page.getByRole("button", { name: "Preview secrets", exact: true }).click();
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Replace: Existing token", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Unavailable here: Unknown token", exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await expect(page.getByRole("button", { name: "Import selected values", exact: true })).toBeDisabled();
});

test("export reveals a saved value without changing selection", async ({ page }) => {
  await installSecretTransferMock(page); await openSettings(page);
  await page.evaluate(() => localStorage.setItem("purr-native-secure-test", JSON.stringify({"saved-token":"synthetic-saved-value"})));
  await page.getByRole("button", { name: "Export secrets", exact: true }).click();
  await page.getByRole("button", { name: "Reveal saved Bearer token", exact: true }).click();
  await expect(page.getByLabel("Saved value Bearer token", { exact: true })).toHaveText("synthetic-saved-value");
  await expect(page.getByRole("checkbox", { name: "Bearer token", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Hide saved Bearer token", exact: true }).click();
  await expect(page.getByLabel("Saved value Bearer token", { exact: true })).toHaveText("••••••••");
});


test("single import password fills its section", async ({ page }) => {
  await installSecretTransferMock(page); await openSettings(page);
  await page.getByRole("button", { name: "Import secrets", exact: true }).click();
  await page.getByRole("button", { name: "Choose package", exact: true }).click();
  const input = page.getByLabel("Package password", { exact: true });
  const grid = input.locator("xpath=ancestor::section[1]").locator(".grid");
  const widths = await Promise.all([input.locator("xpath=ancestor::*[@data-secret-input-control][1]").boundingBox(), grid.boundingBox()]);
  expect(widths[0]!.width).toBeGreaterThan(widths[1]!.width * 0.95);
});

for (const [code, explanation] of [
  ["recovery-key-unlock-failed", "Could not unlock the recovery key"],
  ["recovery-backup-unlock-failed", "Could not unlock the credential backup"],
  ["recovery-key-mismatch", "does not match this credential backup"],
  ["recovery-workspace-mismatch", "belong to another workspace"],
] as const) {
  test(`recovery explains ${code} without publishing values`, async ({ page }) => {
    await installSecretTransferMock(page, { failureCode: code }); await openSettings(page);
    await page.getByRole("button", { name: "Recovery options", exact: true }).click();
    await page.getByRole("button", { name: "Recover secrets", exact: true }).click();
    await page.getByRole("button", { name: "Choose recovery files", exact: true }).click();
    await expect(page.getByText("Recovery key", { exact: true })).toBeVisible();
    await expect(page.getByText("Credential backup", { exact: true })).toBeVisible();
    await page.getByLabel("Recovery key password", { exact: true }).fill("synthetic key password");
    await page.getByLabel("Credential backup password", { exact: true }).fill("synthetic backup password");
    await page.getByRole("button", { name: "Preview secrets", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(explanation);
    await expect(page.getByRole("alert")).toContainText("No values were imported");
    expect((await calls(page)).some((entry: any) => entry.type === "commitImport")).toBe(false);
  });
}

test("wrong recovery file types are explained before asking for passwords", async ({ page }) => {
  await installSecretTransferMock(page, { selectionFailure: "recovery-files-invalid" }); await openSettings(page);
  await page.getByRole("button", { name: "Recovery options", exact: true }).click();
  await page.getByRole("button", { name: "Recover secrets", exact: true }).click();
  await page.getByRole("button", { name: "Choose recovery files", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Choose one recovery-key file");
  await expect(page.getByLabel("Recovery key password", { exact: true })).toHaveCount(0);
});
