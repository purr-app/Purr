import { expect, test, type Page } from "@playwright/test";
import { installPersistenceMock } from "./persistence-mock";
type PaneTransition = { heights: number[]; response: number; root: number; gutter: number; connected: boolean };
test.beforeEach(async ({ page }) => installPersistenceMock(page));

async function mockSuccessfulRequest(page: Page, delayMs = 0) {
  await page.addInitScript((delayMs) => {
    (window as any).isTauri = true;
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command !== "start_http") throw new Error("Unexpected command");
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
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
  }, delayMs);
}

test("canvas collapses to the request tabs and reopens request details beside a dimmed response", async ({
  page,
}) => {
  await mockSuccessfulRequest(page);
  await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("https://api.example.com/users/42");

  const controlHeights = await Promise.all([
    page.getByRole("button", { name: "Choose HTTP method", exact: true }).evaluate((element) => element.getBoundingClientRect().height),
    page.getByLabel("Request URL", { exact: true }).evaluate((element) => element.getBoundingClientRect().height),
    page.getByRole("button", { name: "Send", exact: true }).evaluate((element) => element.getBoundingClientRect().height),
  ]);
  expect(new Set(controlHeights).size).toBe(1);

  const headerCenters = await Promise.all([
    page.getByRole("button", { name: "Hide sidebar", exact: true }).evaluate((element) => { const box = element.getBoundingClientRect(); return box.y + box.height / 2; }),
    page.getByRole("button", { name: "Select workspace", exact: true }).evaluate((element) => { const box = element.getBoundingClientRect(); return box.y + box.height / 2; }),
    page.getByRole("button", { name: "Open command palette", exact: true }).evaluate((element) => { const box = element.getBoundingClientRect(); return box.y + box.height / 2; }),
    page.getByRole("button", { name: "Canvas view", exact: true }).evaluate((element) => { const box = element.getBoundingClientRect(); return box.y + box.height / 2; }),
  ]);
  expect(Math.max(...headerCenters) - Math.min(...headerCenters)).toBeLessThan(1);

  const activeDocumentTab = page.getByRole("tablist", { name: "Documents", exact: true }).getByRole("tab", { selected: true });
  const tabCenters = await activeDocumentTab.locator("span").evaluateAll((spans) => spans.slice(0, 2).map((span) => { const box = span.getBoundingClientRect(); return box.y + box.height / 2; }));
  expect(Math.abs(tabCenters[0] - tabCenters[1])).toBeLessThan(2);

  await expect(page.getByRole("button", { name: "Canvas view" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator('[data-request-details="expanded"]')).toBeVisible();
  await expect(page.getByRole("region", { name: "Response not sent" })).toHaveCount(
    0,
  );

  const urlBar = page.locator("[data-request-url-bar]");
  const requestPane = page.getByRole("region", { name: "Request editor", exact: true });
  const details = page.locator("[data-request-details]");
  const requestOptions = page.getByRole("tablist", { name: "Request options" });
  const requestOptionsBar = page.locator("[data-request-options-bar]");
  const cookies = page.locator("header").getByRole("button", { name: /^Cookies/ });
  const params = requestOptions.getByRole("tab", { name: "Params" });
  await expect(cookies).toBeVisible();
  expect((await cookies.boundingBox())!.y).toBeLessThan((await params.boundingBox())!.y);
  await expect(urlBar.getByRole("button", { name: /^Cookies/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("region", { name: "HTTP response" })).toBeVisible();
  await expect(details).toHaveAttribute("inert", "");
  await expect(requestOptions).toBeVisible();
  await expect(requestOptions.getByRole("tab", { selected: true })).toHaveCount(0);
  await expect.poll(async () => Math.abs((await requestPane.boundingBox())!.height - (await urlBar.boundingBox())!.height - (await requestOptionsBar.boundingBox())!.height)).toBeLessThanOrEqual(2);
  const codeButton = page.getByRole("button", { name: "Open request code" });
  const expandButton = page.getByRole("button", { name: "Expand request details" });
  expect((await codeButton.boundingBox())!.x).toBeLessThan((await expandButton.boundingBox())!.x);
  await page.screenshot({
    path: "test-results/layout-canvas-response.png",
    fullPage: true,
  });

  await params.click();
  await expect(params).toBeVisible();
  await expect(params).toHaveAttribute("aria-selected", "true");
  await expect(details).not.toHaveAttribute("inert", "");
  const panes = page.locator('[data-split-orientation="horizontal"] > section');
  await expect.poll(async () => {
    const requestPane = (await panes.nth(0).boundingBox())!;
    const responsePane = (await panes.nth(1).boundingBox())!;
    return requestPane.height / (requestPane.height + responsePane.height);
  }).toBeGreaterThan(0.84);
  await expect(page.getByRole("button", { name: "Focus Response viewer" })).toBeVisible();
  await page.screenshot({ path: "test-results/layout-canvas-edit.png", fullPage: true });

  await page.getByRole("button", { name: "Focus Response viewer" }).click();
  await expect(details).toHaveAttribute("inert", "");
  await expect(page.getByRole("region", { name: "HTTP response" })).toBeVisible();
});

for (const delayMs of [0, 700]) test(`first Send animates to the full response layout (${delayMs} ms response)`, async ({ page }) => {
  await mockSuccessfulRequest(page, delayMs);
  await page.goto("/");
  await page.getByRole("button", { name: "Select environment" }).click();
  await page.getByRole("button", { name: "New environment", exact: true }).click();
  await page.getByLabel("Environment name", { exact: true }).fill("Development");
  if (delayMs) {
    await page.getByRole("button", { name: "Variable", exact: true }).click();
    await page.getByLabel("Variable name", { exact: true }).fill("test_secret");
    await page.getByLabel("Variable value", { exact: true }).fill("test-only-value");
    await page.getByRole("switch", { name: "Sensitive & masked secret", exact: true }).click();
    await page.getByRole("button", { name: "Save variable", exact: true }).click();
  }
  await page.getByRole("tab", { name: "Variables", exact: true }).hover();
  await page.getByRole("button", { name: "Close variables", exact: true }).click();
  if (delayMs) {
    await expect(page.getByRole("status").filter({ hasText: "Saved locally" })).toBeVisible();
    await page.reload();
  }
  await page.getByLabel("Request URL", { exact: true }).fill("https://api.example.com/users/42");
  await page.getByRole("tab", { name: "Body", exact: true }).click();
  await page.getByRole("tab", { name: "JSON", exact: true }).click();
  await page.getByRole("textbox", { name: "JSON request body" }).fill('{"name":"Focus animation","settings":{"visible":true}}');
  const sampleTransition = async (label: string) => {
    await page.evaluate((label) => {
      const request = document.querySelector<HTMLElement>('[aria-label="Request editor"]')!;
      const response = document.querySelector<HTMLElement>('[aria-label="Response viewer"]')!;
      const root = request.parentElement!;
      const durationToken = getComputedStyle(root).getPropertyValue("--duration-layout").trim();
      const duration = Number.parseFloat(durationToken) * (durationToken.endsWith("ms") ? 1 : 1000);
      (window as Window & { paneTransition?: Promise<PaneTransition> }).paneTransition = new Promise((resolve) => {
        document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.addEventListener("click", () => {
          const heights = [request.getBoundingClientRect().height];
          const started = performance.now();
          const sample = () => {
            heights.push(request.getBoundingClientRect().height);
            if (performance.now() - started < duration + 200) requestAnimationFrame(sample);
            else resolve({ heights, response: response.getBoundingClientRect().height, root: root.getBoundingClientRect().height,
              gutter: root.querySelector('[role="separator"]')!.getBoundingClientRect().height,
              connected: request.isConnected });
          };
          requestAnimationFrame(sample);
        }, { once: true, capture: true });
      });
    }, label);
    await page.getByRole("button", { name: label, exact: true }).click();
    return page.evaluate(() => (window as Window & { paneTransition: Promise<PaneTransition> }).paneTransition);
  };
  const first = await sampleTransition("Send");
  expect(first.connected, "Send must preserve the animated request pane").toBe(true);
  await expect(page.getByRole("region", { name: "HTTP response", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Expand request details", exact: true }).click();
  const focus = page.getByRole("button", { name: "Focus Response viewer", exact: true });
  await expect(focus).toBeVisible();
  // Wait for the reverse transition before comparing the manual focus path.
  await page.locator('[data-split-orientation]').evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
  const manual = await sampleTransition("Focus Response viewer");
  await page.getByRole("button", { name: "Expand request details", exact: true }).click();
  await page.locator('[data-split-orientation]').evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
  const repeat = await sampleTransition("Send");
  for (const result of [first, manual, repeat]) {
    const start = result.heights[0];
    const end = result.heights.at(-1)!;
    const intermediateHeights = result.heights.filter((height) => height < start - 2 && height > end + 2);
    expect(new Set(intermediateHeights.map(Math.round)).size, JSON.stringify(result.heights)).toBeGreaterThanOrEqual(2);
    expect(result.response).toBeGreaterThan(result.root * 0.8);
    expect(result.connected).toBe(true);
    expect(Math.abs(end + result.gutter + result.response - result.root)).toBeLessThan(2);
    expect(Math.abs(end - first.heights.at(-1)!)).toBeLessThan(2);
  }
  expect(Math.abs(first.heights.at(-1)! - manual.heights.at(-1)!)).toBeLessThan(2);
  expect(Math.abs(first.response - manual.response)).toBeLessThan(2);
});

test("empty URLs focus an invalid input and URL parts use semantic colors", async ({ page }) => {
  await page.goto("/");
  const url = page.getByLabel("Request URL", { exact: true });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(url).toBeFocused();
  await expect(url).toHaveAttribute("aria-invalid", "true");
  await expect(url).toHaveClass(/border-accent-red/);
  await expect(page.getByRole("region", { name: "Request error" })).toHaveCount(0);

  await url.fill("https://api.example.com/users/42?state=open");
  await expect(url).toHaveAttribute("aria-invalid", "false");
  await expect(page.locator('[data-url-part="protocol"]')).toHaveClass(/text-action-emerald/);
  await expect(page.locator('[data-url-part="base"]')).toHaveClass(/text-syntax-property/);
  await expect(page.locator('[data-url-part="path"]')).toHaveClass(/text-syntax-attribute/);
  await expect(page.locator('[data-url-part="query"]')).toHaveClass(/text-accent-orange/);
  await url.fill("https://{{path}}.typicode.com/todos/1");
  await expect(page.locator('[data-url-part="base"]')).toHaveText("{{path}}.typicode.com");
  await expect(page.locator('[data-url-part="path"]')).toHaveText("/todos/1");
  await url.fill("https://api.example.com/users/:id");
  await expect(page.locator('[data-url-accent="path-param"]')).toHaveText(":id");
  await page.getByRole("tab", { name: /^Params/ }).click();
  await expect(page.getByText("Path params", { exact: true })).toBeVisible();
  await expect(page.getByText("Query params", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Params 1", exact: true })).toBeVisible();
  await page.getByLabel("Value for id", { exact: true }).fill("42");
});

test("request failures replace response details with one Error tab", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("http://[::1");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const error = page.getByRole("region", { name: "Request error" });
  await expect(error).toBeVisible();
  await expect(error.getByRole("tab")).toHaveCount(1);
  await expect(error.getByRole("tab", { name: "Error", exact: true })).toBeVisible();
  await expect(error.getByRole("alert")).toContainText("Enter a valid HTTP or HTTPS URL.");
  await expect(page.getByRole("region", { name: "HTTP response" })).toHaveCount(0);
});

test("pending requests hide an existing response, disable tabs, and cancel with Escape", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).isTauri = true;
    (window as any).__requestCount = 0;
    (window as any).__cancelCount = 0;
    const response = { status: 200, statusText: "OK", durationMs: 12, httpVersion: "HTTP/2", headers: [["content-type", "application/json"]], bodyBase64: btoa('{"ready":true}') };
    (window as any).__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      if (command === "cancel_http") { (window as any).__cancelCount += 1; return; }
      if (command !== "start_http") throw new Error("Unexpected command");
      (window as any).__requestCount += 1;
      if ((window as any).__requestCount === 1) return response;
      return new Promise((resolve) => { (window as any).__finishPendingRequest = () => resolve(response); });
    } };
  });
  await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("https://api.example.com/users/42");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("region", { name: "HTTP response" })).toBeVisible();

  await page.getByRole("button", { name: "Send", exact: true }).click();
  const pending = page.getByRole("region", { name: "Response pending" });
  await expect(pending).toBeVisible();
  await expect(pending.getByRole("status")).toContainText("Waiting for response");
  await expect(pending.locator("[data-response-elapsed]")).toHaveClass(/text-action-emerald/);
  const running = page.getByRole("button", { name: /Request running/ });
  await expect(running).toContainText("Running ·");
  await expect(running).toContainText("esc");
  await page.screenshot({ path: "test-results/response-pending.png", fullPage: true });
  expect(await pending.getByRole("tab").count()).toBeGreaterThan(1);
  for (const tab of await pending.getByRole("tab").all()) await expect(tab).toBeDisabled();
  await expect(page.getByRole("region", { name: "HTTP response" })).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(pending).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__cancelCount)).toBe(1);
  await expect(page.getByRole("region", { name: "HTTP response" })).toBeVisible();
  await page.evaluate(() => (window as any).__finishPendingRequest());
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
  const sidebarWidth = (await page.getByRole("complementary", { name: "Workspace documents" }).boundingBox())!.width;
  expect(requestBox.width).toBeGreaterThan(1500 - sidebarWidth);
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
  await page.getByLabel("Request URL", { exact: true }).fill("https://api.example.com/users/42");
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
