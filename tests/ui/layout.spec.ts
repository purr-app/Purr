import { expect, test, type Page } from "@playwright/test";

async function mockSuccessfulRequest(page: Page) {
  await page.addInitScript(() => {
    (window as any).isTauri = true;
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command !== "send_http") throw new Error("Unexpected command");
        return {
          status: 200,
          statusText: "OK",
          durationMs: 12,
          httpVersion: "HTTP/2",
          headers: [["content-type", "application/json"]],
          bodyBase64: btoa('{"ready":true}'),
        };
      },
    };
  });
}

test("canvas collapses to the URL and reopens request details beside a dimmed response", async ({
  page,
}) => {
  await mockSuccessfulRequest(page);
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Canvas view" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator('[data-request-details="expanded"]')).toBeVisible();
  await expect(page.getByRole("region", { name: "Response not sent" })).toHaveCount(
    0,
  );

  const urlBar = page.locator("[data-request-url-bar]");
  const request = page.getByRole("region", { name: "Request composer" });
  const details = page.locator("[data-request-details]");
  const cookies = details.getByRole("button", { name: /^Cookies/ });
  const params = details.getByRole("tab", { name: "Params" });
  await expect(cookies).toBeVisible();
  expect((await cookies.boundingBox())!.y).toBe((await params.boundingBox())!.y);
  await expect(urlBar.getByRole("button", { name: /^Cookies/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("region", { name: "HTTP response" })).toBeVisible();
  await expect(details).toHaveAttribute("inert", "");
  await expect(page.getByRole("tablist", { name: "Request options" })).toHaveCount(0);
  await expect.poll(async () => (await request.boundingBox())!.height - (await urlBar.boundingBox())!.height).toBeLessThanOrEqual(2);
  await page.screenshot({
    path: "test-results/layout-canvas-response.png",
    fullPage: true,
  });

  await page.getByRole("button", { name: "Expand request details" }).click();
  await expect(params).toBeVisible();
  const panes = page.locator('[data-split-orientation="horizontal"] > section');
  await expect.poll(async () => Math.abs((await panes.nth(0).boundingBox())!.height - (await panes.nth(1).boundingBox())!.height)).toBeLessThan(2);
  await expect(page.getByRole("button", { name: "Focus Response viewer" })).toBeVisible();
  await page.screenshot({ path: "test-results/layout-canvas-edit.png", fullPage: true });

  await page.getByRole("button", { name: "Focus Response viewer" }).click();
  await expect(details).toHaveAttribute("inert", "");
  await expect(page.getByRole("region", { name: "HTTP response" })).toBeVisible();
});

test("horizontal and vertical views expose a resizable response empty state", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Horizontal split view" }).click();

  const horizontal = page.locator('[data-split-orientation="horizontal"]');
  await expect(horizontal).toBeVisible();
  await expect(page.getByRole("region", { name: "Response not sent" })).toBeVisible();
  const horizontalSeparator = horizontal.getByRole("separator");
  await expect(horizontalSeparator).toHaveAttribute("aria-orientation", "horizontal");
  const horizontalPanes = horizontal.locator(":scope > section");
  const topBox = await horizontalPanes.nth(0).boundingBox();
  const bottomBox = await horizontalPanes.nth(1).boundingBox();
  expect(topBox).not.toBeNull();
  expect(bottomBox).not.toBeNull();
  expect(topBox!.y).toBeLessThan(bottomBox!.y);
  await page.screenshot({
    path: "test-results/layout-horizontal-empty.png",
    fullPage: true,
  });

  await page.getByRole("button", { name: "Vertical split view" }).click();
  const vertical = page.locator('[data-split-orientation="vertical"]');
  await expect(vertical).toBeVisible();
  const verticalSeparator = vertical.getByRole("separator");
  await expect(verticalSeparator).toHaveAttribute("aria-orientation", "vertical");
  const beforeResize = Number(await verticalSeparator.getAttribute("aria-valuenow"));
  await verticalSeparator.focus();
  await page.keyboard.press("ArrowRight");
  await expect(verticalSeparator).toHaveAttribute(
    "aria-valuenow",
    String(beforeResize + 4),
  );
  const verticalPanes = vertical.locator(":scope > section");
  const leftBox = await verticalPanes.nth(0).boundingBox();
  const rightBox = await verticalPanes.nth(1).boundingBox();
  expect(leftBox).not.toBeNull();
  expect(rightBox).not.toBeNull();
  expect(leftBox!.x).toBeLessThan(rightBox!.x);
  const separatorBox = (await verticalSeparator.boundingBox())!;
  await page.mouse.move(separatorBox.x + separatorBox.width / 2, separatorBox.y + separatorBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(separatorBox.x + 90, separatorBox.y + separatorBox.height / 2, { steps: 5 });
  await page.mouse.up();
  expect(Number(await verticalSeparator.getAttribute("aria-valuenow"))).toBeGreaterThan(beforeResize + 4);
  await page.screenshot({
    path: "test-results/layout-vertical-empty.png",
    fullPage: true,
  });

  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+2" : "Control+Shift+2");
  await expect(page.locator('[data-workbench-view="horizontal"]')).toBeVisible();
});

test("body editors fill tall and split panes without losing the selected tab or draft", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/");
  await page.getByRole("tab", { name: "Body", exact: true }).click();
  await page.getByRole("tab", { name: "Text", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "TEXT request body" });
  await editor.fill("Keep this draft when switching views.");
  const panel = page.locator("#body-format-panel");
  const codeScroller = panel.locator(".cm-scroller");
  await expect.poll(async () => Math.abs((await panel.boundingBox())!.height - (await codeScroller.boundingBox())!.height)).toBeLessThan(2);
  const requestBox = (await page.getByRole("region", { name: "Request composer" }).boundingBox())!;
  expect(requestBox.width).toBeGreaterThan(1500);
  await page.screenshot({ path: "test-results/layout-canvas-body.png", fullPage: true });

  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+3" : "Control+Shift+3");
  await expect(page.getByRole("button", { name: "Vertical split view" })).toHaveAttribute("aria-pressed", "true");
  for (const mode of ["Horizontal split view", "Vertical split view", "Canvas view"]) {
    await page.getByRole("button", { name: mode }).click();
    await expect(editor).toHaveText("Keep this draft when switching views.");
    await expect.poll(async () => Math.abs((await panel.boundingBox())!.height - (await codeScroller.boundingBox())!.height)).toBeLessThan(2);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "Horizontal split view" }).click();
  await editor.fill(Array.from({ length: 150 }, (_, i) => `Line ${i + 1}`).join("\n"));
  await codeScroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => codeScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({ path: "test-results/layout-body-scroll.png", fullPage: true });
});

test("response cookies empty state fills the response surface", async ({ page }) => {
  await mockSuccessfulRequest(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("tab", { name: /^Cookie/ }).click();
  const empty = page.getByText("This response did not set any cookies.");
  await expect(empty).toBeVisible();
  const panel = page.locator("#response-panel");
  await expect.poll(async () => {
    const messageBox = (await empty.boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    return Math.abs((messageBox.y + messageBox.height / 2) - (panelBox.y + panelBox.height / 2));
  }).toBeLessThan(2);
  await page.screenshot({ path: "test-results/layout-cookies-empty.png", fullPage: true });
});
