import { expect, test, type Page } from "@playwright/test";
import { installOpenWorkspaceMock, portableSecretRef, portableWorkspaceId } from "../fixtures/open-workspace-mock";

async function importDialog(page: Page) {
  await page.getByRole("button", { name: "Select workspace", exact: true }).click();
  await page.getByRole("button", { name: "New workspace", exact: true }).hover();
  await page.getByRole("menu", { name: "New workspace options" }).getByRole("menuitem", { name: "Import", exact: true }).click();
  return page.getByRole("dialog", { name: "Import workspace", exact: true });
}
async function openFolder(page: Page) {
  const dialog = await importDialog(page);
  await dialog.getByRole("button", { name: "Choose folder instead", exact: true }).click();
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
}

test("folder import uses the existing New workspace import entry", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Select workspace", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open workspace folder", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "New workspace", exact: true }).hover();
  await expect(page.getByRole("menuitem", { name: "Import", exact: true })).toBeVisible();
});

test("cancelled folder picker leaves the workspace unchanged", async ({ page }) => {
  await installOpenWorkspaceMock(page, { cancel: true });
  await page.goto("/");
  const dialog = await importDialog(page);
  await dialog.getByRole("button", { name: "Choose folder instead", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Import", exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (window as any).__openWorkspaceCalls.some((call: any) => call.command === "plugin:dialog|open"))).toBe(true);
  await expect(page.getByRole("button", { name: "Select workspace", exact: true })).toContainText("Personal");
  expect(await page.evaluate(() => (window as any).__openWorkspaceCalls.some((call: any) => call.command === "open_project_directory"))).toBe(false);
});

for (const error of ["Workspace manifest is missing.", "This workspace ID is already open from another folder."]) {
  test(`folder error preserves current workspace: ${error}`, async ({ page }) => {
    await installOpenWorkspaceMock(page, { error });
    await page.goto("/");
    await openFolder(page);
    await expect(page.getByRole("dialog", { name: "Import workspace" }).getByRole("alert")).toContainText(error);
    await expect(page.getByRole("button", { name: "Select workspace", exact: true })).toContainText("Personal");
  });
}

test("copied folder keeps identity and missing secret declarations, then accepts secret import", async ({ page }) => {
  await installOpenWorkspaceMock(page);
  await page.goto("/");
  await openFolder(page);
  await expect(page.getByRole("button", { name: "Select workspace", exact: true })).toContainText("Portable workspace");
  await page.getByRole("button", { name: "Open variables", exact: true }).click();
  await page.getByRole("navigation", { name: "Variable scopes" }).getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.getByLabel("Variable value API_TOKEN", { exact: true })).toHaveText("Local secret missing");
  await page.getByRole("button", { name: "Select workspace", exact: true }).click();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  await page.getByRole("tab", { name: "Secrets and encryption", exact: true }).click();
  await page.getByRole("button", { name: "Import secrets", exact: true }).click();
  await page.getByRole("button", { name: "Choose package", exact: true }).click();
  await page.getByLabel("Package password", { exact: true }).fill("synthetic password");
  await page.getByRole("button", { name: "Preview secrets", exact: true }).click();
  await page.getByRole("button", { name: "Import selected values", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const persisted = await page.evaluate(({ id, reference }) => {
    const snapshot = JSON.parse(localStorage.getItem("purr-native-persistence-test")!);
    const secrets = JSON.parse(localStorage.getItem("purr-native-secure-test")!);
    return { id: snapshot.activeWorkspaceId, workspace: snapshot.workspaces.find((workspace: any) => workspace.id === id), secret: secrets[reference] };
  }, { id: portableWorkspaceId, reference: portableSecretRef });
  expect(persisted.id).toBe(portableWorkspaceId);
  expect(persisted.workspace.files["purr.yaml"].content).toContain(portableSecretRef);
  expect(persisted.workspace.files["purr.yaml"].content).not.toContain("synthetic-imported-token");
  expect(persisted.secret).toBe("synthetic-imported-token");
  await page.reload();
  await expect(page.getByRole("button", { name: "Select workspace", exact: true })).toContainText("Portable workspace");
  await page.getByRole("button", { name: "Open variables", exact: true }).click();
  await page.getByRole("navigation", { name: "Variable scopes" }).getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.getByLabel("Variable value API_TOKEN", { exact: true })).toHaveText("••••••••");
  await openFolder(page);
  await page.getByRole("button", { name: "Select workspace", exact: true }).click();
  await expect(page.getByRole("button", { name: "Portable workspace", exact: true })).toHaveCount(1);
});


test("a direct purr.yaml path opens the same canonical workspace", async ({ page }) => {
  await installOpenWorkspaceMock(page);
  await page.goto("/");
  const dialog = await importDialog(page);
  await dialog.getByRole("textbox", { name: /Path or URL/i }).fill("/synthetic/copied-workspace/purr.yaml");
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Select workspace", exact: true })).toContainText("Portable workspace");
  expect(await page.evaluate(() => (window as any).__openWorkspaceCalls.find((call: any) => call.command === "open_project_directory").args.directory)).toBe("/synthetic/copied-workspace/purr.yaml");
});

test("a non-Purr collection continues through the existing importer", async ({ page }) => {
  await installOpenWorkspaceMock(page, { nonPurr: true });
  await page.goto("/");
  const dialog = await importDialog(page);
  await dialog.getByRole("textbox", { name: /Path or URL/i }).fill("/synthetic/postman.json");
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Import complete", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select workspace", exact: true })).toContainText("Collection fixture");
  expect(await page.evaluate(() => (window as any).__openWorkspaceCalls.some((call: any) => call.command === "import_collection"))).toBe(true);
  expect(await page.evaluate(() => (window as any).__openWorkspaceCalls.some((call: any) => call.command === "open_project_directory"))).toBe(false);
});
