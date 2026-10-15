import { expect, test, type Page } from "@playwright/test";
import { installPersistenceMock } from "./persistence-mock";

async function savedFixture(page: Page) {
  await installPersistenceMock(page);
  await page.addInitScript(() => { (window as any).isTauri = true; (window as any).__TAURI_INTERNALS__ = { invoke: async () => undefined }; });
  await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("https://synthetic.test/secret-lifecycle");
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await page.getByLabel("Document name", { exact: true }).fill("Synthetic lifecycle");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("region", { name: "Workspace", exact: true })).toHaveAttribute("aria-busy", "false");
}

test("legacy explicit Save requires one coherent format upgrade and Cancel preserves definitions", async ({ page }) => {
  await savedFixture(page);
  await page.evaluate(() => {
    const snapshot = JSON.parse(localStorage.getItem("purr-native-persistence-test")!);
    for (const workspace of snapshot.workspaces) for (const file of Object.values(workspace.files) as any[]) {
      file.content = file.content.replace(/^purr: 2/m, "purr: 1"); file.revision += "-legacy";
    }
    localStorage.setItem("purr-native-persistence-test", JSON.stringify(snapshot));
  });
  await page.reload();
  await page.getByLabel("Request URL", { exact: true }).fill("https://synthetic.test/updated");
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  const upgrade = page.getByRole("dialog", { name: "Upgrade workspace format", exact: true });
  await expect(upgrade).toBeVisible();
  await upgrade.getByRole("button", { name: "Cancel", exact: true }).click();
  const versions = () => page.evaluate(() => JSON.parse(localStorage.getItem("purr-native-persistence-test")!).workspaces.flatMap((workspace: any) => Object.values(workspace.files).filter((file: any) => /^purr: /m.test(file.content)).map((file: any) => /^purr: (\d+)/m.exec(file.content)![1])));
  expect(await versions()).toEqual(["1", "1"]);
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("https://synthetic.test/updated");
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await upgrade.getByRole("button", { name: "Upgrade and save", exact: true }).click();
  await expect(upgrade).toHaveCount(0);
  expect(await versions()).toEqual(["2", "2"]);
  await page.getByLabel("Request URL", { exact: true }).fill("https://synthetic.test/updated-again");
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await expect(page.getByRole("region", { name: "Workspace", exact: true })).toHaveAttribute("aria-busy", "false");
  await expect(upgrade).toHaveCount(0);
});

test("degraded protected storage keeps public navigation and blocks Send until Retry", async ({ page }) => {
  await savedFixture(page);
  const files = await page.evaluate(() => JSON.parse(localStorage.getItem("purr-native-persistence-test")!).workspaces[0].files);
  await page.addInitScript(() => { (window as any).__purrProtectedState = { status: "locked", code: "synthetic-locked" }; });
  await page.reload();
  await expect(page.getByText(/Protected storage is locked/).first()).toBeVisible();
  await page.getByRole("button", { name: "GET Synthetic lifecycle", exact: true }).click();
  await page.getByRole("tab", { name: /^Headers/ }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Required local secrets", exact: true }).click();
  await page.getByRole("button", { name: "Manage secrets", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Manage local secrets", exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("purr-native-persistence-test")!).workspaces[0].files)).toEqual(files);
  await page.evaluate(() => { (window as any).__purrProtectedState = { status: "available" }; });
  await page.getByRole("button", { name: "Retry / Unlock", exact: true }).click();
  await expect(page.getByText(/Protected storage is locked/)).toHaveCount(0);
});

test("legacy shared authentication Save confirms upgrade once and preserves entries on Cancel", async ({ page }) => {
  await savedFixture(page);
  await page.evaluate(() => {
    const snapshot = JSON.parse(localStorage.getItem("purr-native-persistence-test")!);
    for (const workspace of snapshot.workspaces) for (const file of Object.values(workspace.files) as any[]) {
      file.content = file.content.replace(/^purr: 2/m, "purr: 1"); file.revision += "-legacy";
    }
    localStorage.setItem("purr-native-persistence-test", JSON.stringify(snapshot));
  });
  await page.reload();
  await page.getByRole("button", { name: "Select workspace", exact: true }).click();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  await page.getByRole("tab", { name: "Shared auth", exact: true }).click();
  await page.getByRole("button", { name: "Add shared auth", exact: true }).click();
  await page.getByLabel("Auth name", { exact: true }).fill("Synthetic shared profile");
  await page.getByRole("tab", { name: "Basic Auth", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill("synthetic-user");
  await page.getByLabel("Password", { exact: true }).fill("synthetic-shared-A");
  await page.getByRole("button", { name: "Save authentication", exact: true }).click();
  const upgrade = page.getByRole("dialog", { name: "Upgrade workspace format", exact: true });
  await expect(upgrade).toBeVisible();
  await upgrade.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("synthetic-shared-A");
  expect(await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("purr-native-secure-test") ?? "{}")))).not.toContain("synthetic-shared-A");
  const manifest = () => page.evaluate(() => JSON.parse(localStorage.getItem("purr-native-persistence-test")!).workspaces[0].files["purr.yaml"].content as string);
  expect(await manifest()).toMatch(/^purr: 1/m);
  await page.getByRole("button", { name: "Save authentication", exact: true }).click();
  await upgrade.getByRole("button", { name: "Upgrade and save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit Synthetic shared profile", exact: true })).toBeVisible();
  expect(await manifest()).toMatch(/^purr: 2/m);
  expect(await manifest()).not.toContain("synthetic-shared-A");
  expect(await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("purr-native-secure-test") ?? "{}")))).toContain("synthetic-shared-A");
  await page.getByRole("button", { name: "Edit Synthetic shared profile", exact: true }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("synthetic-shared-A");
  await page.getByLabel("Password", { exact: true }).fill("synthetic-shared-B");
  await page.getByRole("button", { name: "Save authentication", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit Synthetic shared profile", exact: true })).toBeVisible();
  await expect(upgrade).toHaveCount(0);
  expect(await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("purr-native-secure-test") ?? "{}")))).toContain("synthetic-shared-B");
});
