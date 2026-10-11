import { expect, test } from "@playwright/test";
import { installPersistenceMock } from "./persistence-mock";

test.beforeEach(async ({ page }) => installPersistenceMock(page));

test("multipart fields keep usable name, type, and value columns", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Body", exact: true }).click();
  await page.getByRole("tab", { name: "Form-Data", exact: true }).click();
  const row = page.locator(".ui-multipart-row").first();
  await expect(row).toHaveCSS("display", "grid");
  const name = row.getByRole("textbox", { name: "name", exact: true });
  const value = row.getByRole("textbox", { name: "form-data field value", exact: true });
  const type = row.getByRole("combobox", { name: "Field type" });
  expect((await name.boundingBox())!.width).toBeGreaterThan(100);
  expect((await value.boundingBox())!.width).toBeGreaterThan(150);
  expect((await type.boundingBox())!.width).toBeLessThanOrEqual(80);
  await name.fill("message");
  await row.getByRole("textbox", { name: "Value for message" }).fill("hello");
  await type.click();
  await page.getByRole("option", { name: "File", exact: true }).click();
  await expect(row.locator('button[aria-label="Choose file for message"]')).toBeVisible();
});

test("workspace menus wrap long names and keep the creation submenu on screen", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Select workspace" }).click();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  const name = "Workspace ".repeat(12) + "12345";
  await page.getByLabel("Workspace name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Select workspace" }).click();
  const menu = page.getByRole("dialog", { name: "Workspaces", exact: true });
  expect((await menu.boundingBox())!.width).toBeLessThanOrEqual(416);
  const label = menu.getByRole("button", { name, exact: true }).locator("span");
  await expect(label).toHaveText(name);
  expect(await label.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByRole("button", { name: "New workspace", exact: true }).click();
  const submenu = page.getByRole("menu", { name: "New workspace options" });
  await expect(submenu).toBeVisible();
  const box = (await submenu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await submenu.getByRole("menuitem", { name: "New empty" }).click();
  await expect(page.getByRole("dialog", { name: "New workspace", exact: true })).toBeVisible();
});

test("shared authentication edits in place and preserves profile order", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Select workspace" }).click();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  await page.getByRole("tab", { name: "Shared auth", exact: true }).click();
  for (const name of ["First", "Second", "Third"]) {
    await page.getByRole("button", { name: "Add shared auth" }).click();
    await page.getByLabel("Auth name", { exact: true }).fill(name);
    await page.getByRole("tab", { name: "Bearer Token", exact: true }).click();
    await page.getByLabel("Bearer token", { exact: true }).fill("{{token}}");
    await page.getByRole("button", { name: "Save authentication" }).click();
  }
  await page.getByRole("button", { name: "Edit Second", exact: true }).click();
  const editor = page.getByRole("group", { name: "Edit authentication Second", exact: true });
  const first = (await page.getByRole("button", { name: "Edit First" }).boundingBox())!;
  const third = (await page.getByRole("button", { name: "Edit Third" }).boundingBox())!;
  const box = (await editor.boundingBox())!;
  expect(box.y).toBeGreaterThan(first.y);
  expect(box.y + box.height).toBeLessThan(third.y);
  await editor.getByLabel("Auth name", { exact: true }).fill("Renamed");
  await page.getByRole("button", { name: "Save authentication" }).click();
  await expect(page.getByRole("button", { name: /^Edit (First|Renamed|Third)$/ })).toHaveText(["", "", ""]);
  expect(await page.getByRole("button", { name: /^Edit (First|Renamed|Third)$/ }).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))).toEqual(["Edit First", "Edit Renamed", "Edit Third"]);
});

test("variable definition disables inline edits until it closes", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open variables" }).click();
  await page.getByRole("navigation", { name: "Variable scopes" }).getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("button", { name: "Variable", exact: true }).click();
  await page.getByLabel("Variable name", { exact: true }).fill("base_url");
  await page.getByLabel("Variable value", { exact: true }).fill("https://example.com");
  await page.getByRole("button", { name: "Save variable", exact: true }).click();
  await expect(page.getByLabel("Variable name base_url", { exact: true })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Enable base_url", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Variable value base_url", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel variable changes" }).click();
  await expect(page.getByLabel("Variable value base_url", { exact: true })).toBeEnabled();
  await page.getByLabel("Variable value base_url", { exact: true }).fill("https://updated.example.com");
  await expect(page.getByLabel("Variable value base_url", { exact: true })).toHaveValue("https://updated.example.com");
});

test("workspace and environment names do not move adjacent toolbar controls", async ({ page }) => {
  await page.goto("/");
  const environment = page.getByRole("button", { name: "Select environment" });
  const variables = page.getByRole("button", { name: "Open variables" });
  const before = await environment.boundingBox();
  const variablesBefore = await variables.boundingBox();
  await page.getByRole("button", { name: "Select workspace" }).click();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  await page.getByLabel("Workspace name", { exact: true }).fill("Long workspace name ".repeat(6));
  expect(await environment.boundingBox()).toEqual(before);
  expect(await variables.boundingBox()).toEqual(variablesBefore);
  const workspaceBefore = await page.getByRole("button", { name: "Select workspace" }).boundingBox();
  await environment.click();
  await page.getByRole("button", { name: "New environment", exact: true }).click();
  await page.getByRole("dialog", { name: "New environment" }).getByLabel("Environment name", { exact: true }).fill("Long environment ".repeat(7));
  await page.getByRole("dialog", { name: "New environment" }).getByRole("button", { name: "Save", exact: true }).click();
  expect(await page.getByRole("button", { name: "Select workspace" }).boundingBox()).toEqual(workspaceBefore);
  expect(await variables.boundingBox()).toEqual(variablesBefore);
});
