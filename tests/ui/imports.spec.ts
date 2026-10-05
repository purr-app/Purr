import { expect, test, type Page } from "@playwright/test";
import { installPersistenceMock } from "./persistence-mock";

async function desktopImporter(page: Page) {
  await installPersistenceMock(page);
  await page.addInitScript(() => {
    (window as any).isTauri = true;
    (window as any).__importCalls = [];
    (window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command === "plugin:dialog|open") return "/fixtures/postman.json";
      if (command !== "import_collection") return;
      (window as any).__importCalls.push(args);
      if (args.source.path === "/invalid.json") throw new Error("Select a Postman environment export.");
      const id = args.importId;
      const ref = `purr/${args.workspaceId}/imports/postman/${id}`;
      const environment = args.target === "environment";
      const result = { adapter: environment ? "postman-environment" : "postman-collection",
        workspace: { id: args.workspaceId, name: "Postman fixture", variables: [], headers: [], auth: [] },
        resources: environment ? [{ id, kind: "environment", name: "Imported env", variables: [
          { id: `${id}-url`, name: "baseUrl", kind: "static", value: "https://environment.test", enabled: true, sensitive: false },
          { id: `${id}-token`, name: "token", kind: "static", secretRef: ref, enabled: true, sensitive: true },
        ] }] : [{ id, kind: "http", name: "Imported request", method: "GET", url: "https://example.test", params: [], pathParams: [], headers: [], body: { type: "none" }, auth: { type: "none" } }],
        secrets: environment ? [{ ref, value: "private-import-token" }] : [],
        diagnostics: environment ? [] : [{ severity: "warning", code: "unsupported-script", message: "Postman script was not imported or executed.", sourcePath: "#/event/0" }],
      };
      if (args.source.path === "/slow.json") return new Promise((resolve) => { (window as any).__finishImport = () => resolve(result); });
      return result;
    } };
  });
}
async function openCollectionImport(page: Page) {
  await page.getByRole("button", { name: "Select workspace" }).click();
  await page.getByRole("button", { name: "New workspace", exact: true }).hover();
  await page.getByRole("menu", { name: "New workspace options" }).getByRole("menuitem", { name: "Import", exact: true }).click();
}

test("collection import commits and shows grouped warnings only after completion", async ({ page }) => {
  await desktopImporter(page); await page.goto("/"); await openCollectionImport(page);
  const dialog = page.getByRole("dialog", { name: "Import workspace" });
  await expect(dialog).toContainText("Postman Collection");
  await dialog.getByLabel("File path or URL").fill("/slow.json");
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Importing…" })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Import complete" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__importCalls.length)).toBe(1);
  await page.evaluate(() => (window as any).__finishImport());
  const report = page.getByRole("dialog", { name: "Import complete" });
  await expect(report).toBeVisible(); await expect(report).toContainText("HTTP requests");
  await report.locator("summary").click(); await expect(report).toContainText("#/event/0");
  await report.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("tab", { name: /Imported request/ })).toBeVisible();
  await page.reload(); await expect(page.getByRole("tab", { name: /Imported request/ })).toBeVisible();
});

test("environment import works without an existing env, preserves the draft and renames repeat imports", async ({ page }) => {
  await desktopImporter(page); await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("https://draft.test");
  await page.getByRole("button", { name: "Open variables", exact: true }).click();
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole("button", { name: "Import environment", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Import environment" });
    await expect(dialog.getByRole("button", { name: "Choose folder instead" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Choose import file" }).click();
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    const report = page.getByRole("dialog", { name: "Import complete" });
    await expect(report).toContainText("Secrets stored securely");
    await expect(report).not.toContainText("private-import-token");
    if (attempt) await expect(report).toContainText("renamed");
    await report.getByRole("button", { name: "Done" }).click();
  }
  await expect(page.getByRole("navigation", { name: "Variable scopes" }).getByRole("button", { name: "Imported env (2)", exact: true })).toBeVisible();
  const snapshot = await page.evaluate(() => localStorage.getItem("purr-native-persistence-test"));
  expect(snapshot).not.toContain("private-import-token");
  await page.getByRole("tab", { name: "Variables", exact: true }).hover();
  await page.getByRole("button", { name: "Close variables", exact: true }).click();
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("https://draft.test");
  await expect(page.getByRole("status").filter({ hasText: "Saved locally" })).toBeVisible();
  await page.reload(); await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("https://draft.test");
});

test("invalid environment stays in the dialog and can be corrected without partial imports", async ({ page }) => {
  await desktopImporter(page); await page.goto("/");
  await page.getByRole("button", { name: "Open variables", exact: true }).click();
  await page.getByRole("button", { name: "Import environment", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import environment" });
  await dialog.getByLabel("File path or URL").fill("/invalid.json");
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("environment export");
  await expect(page.getByRole("dialog", { name: "Import complete" })).toHaveCount(0);
  await dialog.getByLabel("File path or URL").fill("/valid.json");
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Import complete" })).toBeVisible();
});

test("environment import does not discard an unsaved variable draft", async ({ page }) => {
  await desktopImporter(page); await page.goto("/");
  await page.getByRole("button", { name: "Open variables", exact: true }).click();
  await page.getByRole("navigation", { name: "Variable scopes" }).getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("button", { name: "Variable", exact: true }).click();
  await page.getByLabel("Variable name", { exact: true }).fill("pending");
  await expect(page.getByRole("button", { name: "Import environment", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Variable name", { exact: true })).toHaveValue("pending");
});
