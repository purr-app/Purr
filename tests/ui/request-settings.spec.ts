import { expect, test } from "@playwright/test";
import { installPersistenceMock } from "./persistence-mock";

test.beforeEach(async ({ page }) => {
  await installPersistenceMock(page);
  await page.addInitScript(() => {
    (window as any).isTauri = true;
    (window as any).__requests = [];
    (window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command !== "start_http") return;
      (window as any).__requests.push(args.request);
      return { status: 302, statusText: "Found", durationMs: 1,
        headers: [["Location", "/redirected"]], bodyBase64: "" };
    } };
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
});

test("request settings have section hierarchy, persist, and control execution", async ({ page }) => {
  const settings = page.getByLabel("Request settings", { exact: true });
  await expect(settings.getByRole("heading", { level: 2 })).toHaveText(["Tracing", "Redirects", "Connection", "Cookies"]);
  const titleSize = await settings.getByRole("heading", { name: "Tracing", exact: true }).evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
  const labelSize = await settings.getByRole("heading", { name: "Tracing provider", exact: true }).evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
  expect(titleSize).toBeGreaterThan(labelSize);
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.test/settings");
  await settings.getByRole("spinbutton", { name: "Maximum redirects", exact: true }).fill("3");
  await settings.getByRole("switch", { name: "Follow redirects", exact: true }).click();
  await expect(settings.getByRole("spinbutton", { name: "Maximum redirects", exact: true })).toBeDisabled();
  const timeout = settings.getByRole("spinbutton", { name: "Maximum timeout (ms)", exact: true });
  await timeout.fill("15000");
  await settings.getByRole("switch", { name: "Validate TLS certificates", exact: true }).click();
  await settings.getByRole("combobox", { name: "HTTP version", exact: true }).click();
  await page.getByRole("option", { name: "HTTP/1.1", exact: true }).click();
  const sendCookies = settings.getByRole("switch", { name: "Automatically send cookies", exact: true });
  const storeCookies = settings.getByRole("switch", { name: "Automatically store cookies", exact: true });
  await sendCookies.click();
  await expect(storeCookies).toBeChecked();
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await page.getByLabel("Document name", { exact: true }).fill("Configured request");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("purr-native-persistence-test") ?? "")).toContain("http1");
  await page.reload();
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await expect(timeout).toHaveValue("15000");
  await expect(sendCookies).not.toBeChecked();
  await expect(storeCookies).toBeChecked();
  await expect(settings.getByRole("switch", { name: "Validate TLS certificates", exact: true })).not.toBeChecked();
  await settings.getByRole("heading", { name: "Tracing", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/request-settings.png", fullPage: true });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__requests.length)).toBe(1);
  const wire = await page.evaluate(() => (window as any).__requests[0]);
  expect(wire.transportSettings).toMatchObject({ httpVersion: "http1", validateTlsCertificates: false });
  expect(wire.transportSettings.timeoutMs).toBeGreaterThan(14000);
  expect(wire.transportSettings.timeoutMs).toBeLessThanOrEqual(15000);
});

test("numeric settings reject out-of-range input and cookie switches stay independent", async ({ page }) => {
  const settings = page.getByLabel("Request settings", { exact: true });
  const timeout = settings.getByRole("spinbutton", { name: "Maximum timeout (ms)", exact: true });
  await timeout.fill("0");
  await expect(timeout).toHaveAttribute("aria-invalid", "true");
  await timeout.press("Tab");
  await expect(timeout).toHaveValue("60000");
  const redirects = settings.getByRole("spinbutton", { name: "Maximum redirects", exact: true });
  await redirects.fill("51");
  await redirects.press("Tab");
  await expect(redirects).toHaveValue("10");
  const store = settings.getByRole("switch", { name: "Automatically store cookies", exact: true });
  const send = settings.getByRole("switch", { name: "Automatically send cookies", exact: true });
  await store.click();
  await expect(send).toBeChecked();
  await send.click();
  await send.click();
  await expect(store).not.toBeChecked();
});
