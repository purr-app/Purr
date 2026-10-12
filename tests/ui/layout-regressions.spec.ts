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

test("environment width follows its name up to a cap with Variables immediately beside it", async ({ page }) => {
  await page.setViewportSize({ width: 1560, height: 950 });
  await page.goto("/");
  const environment = page.getByRole("button", { name: "Select environment" });
  const variables = page.getByRole("button", { name: "Open variables" });
  const before = await environment.boundingBox();
  await page.getByRole("button", { name: "Select workspace" }).click();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  await page.getByLabel("Workspace name", { exact: true }).fill("Long workspace name ".repeat(6));
  expect(await environment.boundingBox()).toEqual(before);
  const workspaceBefore = await page.getByRole("button", { name: "Select workspace" }).boundingBox();
  await environment.click();
  await page.getByRole("button", { name: "New environment", exact: true }).click();
  await page.getByRole("dialog", { name: "New environment" }).getByLabel("Environment name", { exact: true }).fill("Local");
  await page.getByRole("dialog", { name: "New environment" }).getByRole("button", { name: "Save", exact: true }).click();
  const short = (await environment.boundingBox())!;
  expect(short.width).toBeLessThan(before!.width);
  let adjacent = (await variables.boundingBox())!;
  expect(adjacent.x - short.x - short.width).toBeLessThanOrEqual(4);
  await page.getByLabel("Environment name", { exact: true }).fill("Long environment ".repeat(7));
  await page.getByRole("heading", { name: "Variables", exact: true }).click();
  const long = (await environment.boundingBox())!;
  expect(long.width).toBeGreaterThan(short.width);
  expect(long.width).toBeLessThanOrEqual(192);
  adjacent = (await variables.boundingBox())!;
  expect(adjacent.x - long.x - long.width).toBeLessThanOrEqual(4);
  expect(await page.getByRole("button", { name: "Select workspace" }).boundingBox()).toEqual(workspaceBefore);
  await page.setViewportSize({ width: 1000, height: 700 });
  const narrowEnvironment = (await environment.boundingBox())!;
  const narrowVariables = (await variables.boundingBox())!;
  expect(narrowEnvironment.width).toBeGreaterThan(0);
  expect(narrowVariables.x - narrowEnvironment.x - narrowEnvironment.width).toBeLessThanOrEqual(4);
  await expect(variables).toBeVisible();
});

test("header controls stay clickable beside the command palette at narrow widths", async ({ page }) => {
  await page.goto("/");
  const environment = page.getByRole("button", { name: "Select environment" });
  const variables = page.getByRole("button", { name: "Open variables" });
  const cookies = page.getByRole("button", { name: /^Cookies \d+$/ });
  const palette = page.getByRole("button", { name: "Open command palette" });
  for (const width of [1280, 1000]) {
    await page.setViewportSize({ width, height: 900 });
    const environmentBox = (await environment.boundingBox())!;
    const variablesBox = (await variables.boundingBox())!;
    const cookiesBox = (await cookies.boundingBox())!;
    const paletteBox = (await palette.boundingBox())!;
    expect(environmentBox.width).toBeGreaterThan(0);
    expect(environmentBox.x + environmentBox.width).toBeLessThanOrEqual(variablesBox.x);
    expect(variablesBox.x + variablesBox.width).toBeLessThanOrEqual(cookiesBox.x);
    expect(cookiesBox.x + cookiesBox.width).toBeLessThanOrEqual(paletteBox.x);
    await environment.click({ trial: true });
    await variables.click({ trial: true });
    await cookies.click({ trial: true });
    await palette.click({ trial: true });
  }
  await cookies.click();
  await expect(page.getByRole("button", { name: "Add cookie", exact: true })).toBeVisible();
});

test("workspace deletion stays at the bottom of General settings", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Select workspace" }).click();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  const panel = page.locator("#workspace-settings-panel");
  const button = panel.getByRole("button", { name: "Delete workspace", exact: true });
  const box = (await panel.boundingBox())!;
  const danger = (await button.boundingBox())!;
  expect(box.y + box.height - danger.y - danger.height).toBeLessThanOrEqual(16);
  await page.setViewportSize({ width: 1000, height: 400 });
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeVisible();
  await expect(panel.getByLabel("Workspace name", { exact: true })).toBeAttached();
});
