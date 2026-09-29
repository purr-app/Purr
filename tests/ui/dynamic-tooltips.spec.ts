import { expect, test, type Locator, type Page } from "@playwright/test";
import { installPersistenceMock } from "./persistence-mock";

async function createVariable(page: Page) {
  await page.getByRole("button", { name: "Select environment" }).click();
  await page.getByRole("button", { name: "New environment", exact: true }).click();
  await page.getByLabel("Environment name", { exact: true }).fill("Tooltip environment");
  await page.getByRole("button", { name: "Variable", exact: true }).click();
  await page.getByLabel("Variable name", { exact: true }).fill("tooltip_var");
  await page.getByLabel("Variable value", { exact: true }).fill("value");
  await page.getByRole("button", { name: "Save variable", exact: true }).click();
  await page.getByRole("tab", { name: "Variables", exact: true }).hover();
  await page.getByRole("button", { name: "Close variables", exact: true }).click();
}

async function inspectTooltip(page: Page, token: Locator) {
  await token.hover();
  const action = page.getByRole("button", { name: "Go to definition", exact: true });
  await expect(action).toBeVisible();
  const tooltip = action.locator("xpath=ancestor::*[contains(@class, 'cm-tooltip')][1]");
  const viewport = page.viewportSize()!;
  // CodeMirror mounts offscreen, then measures and positions on the next frame.
  await expect.poll(async () => {
    const box = await tooltip.boundingBox();
    return Boolean(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height);
  }).toBe(true);
  const rect = await tooltip.boundingBox();
  expect(rect).not.toBeNull();
  expect(rect!.y).toBeGreaterThanOrEqual(0);
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(viewport.height);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width);
  // Visible geometry alone does not detect clipping behind a request section.
  expect(await action.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const topmost = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return topmost === element || element.contains(topmost);
  })).toBe(true);
  return action;
}

for (const mode of ["Canvas view", "Horizontal split view", "Vertical split view"]) {
  for (const kind of ["http", "graphql"] as const) {
    test(`${kind} variable tooltip stays visible near the editor top and after scroll in ${mode}`, async ({ page }) => {
      await installPersistenceMock(page);
      await page.goto("/");
      await createVariable(page);
      await page.getByRole("button", { name: mode, exact: true }).click();
      let editor: Locator;
      if (kind === "http") {
        await page.getByRole("tab", { name: "Body", exact: true }).click();
        await page.getByRole("tab", { name: "JSON", exact: true }).click();
        editor = page.getByRole("textbox", { name: "JSON request body", exact: true });
        await editor.fill('{"first":"{{tooltip_var}}",\n' + Array.from({ length: 70 }, (_, index) => `"row${index}":${index},`).join("\n") + '\n"last":"{{tooltip_var}}"}');
      } else {
        await page.getByRole("button", { name: "Create document", exact: true }).click();
        await page.getByRole("menuitem", { name: "GraphQL request", exact: true }).click();
        editor = page.getByRole("textbox", { name: "GraphQL query", exact: true });
        await editor.fill('query { user(id: "{{tooltip_var}}") { id } }\n' + Array.from({ length: 70 }, (_, index) => `# row ${index}`).join("\n") + '\nquery Other { user(id: "{{tooltip_var}}") { id } }');
      }
      const scroller = editor.locator("xpath=ancestor::*[contains(@class, 'cm-scroller')][1]");
      await scroller.evaluate((element) => { element.scrollTop = 0; });
      await inspectTooltip(page, editor.locator(".cm-template-variable").first());
      await page.mouse.move(0, 0);
      await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      const action = await inspectTooltip(page, editor.locator(".cm-template-variable").last());
      await action.click();
      await expect(page.getByRole("tab", { name: "Variables", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByLabel("Variable name", { exact: true })).toHaveValue("tooltip_var");
    });
  }
}
