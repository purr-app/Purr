import { expect, test } from "@playwright/test";
import { installPersistenceMock } from "./persistence-mock";
test.beforeEach(async ({ page }) => installPersistenceMock(page));

test("response tabs expose formatted body, query tools, cookies and timeline", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const body = JSON.stringify({
      data: { users: [{ name: "Alex", active: true }] },
      count: 1,
    });
    (window as any).isTauri = true;
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command !== "start_http") throw new Error("Unexpected command");
        return {
          status: 200,
          statusText: "OK",
          durationMs: 84,
          headersDurationMs: 70,
          downloadDurationMs: 12,
          httpVersion: "HTTP/2",
          localAddress: "192.168.1.10:53001",
          remoteAddress: "203.0.113.42:443",
          headers: [
            ["content-type", "application/json; charset=utf-8"],
            ["report-to", '{"group":"edge","max_age":3600}'],
            ["set-cookie", "sid=secret; Path=/; HttpOnly"],
          ],
          bodyBase64: btoa(body),
        };
      },
    };
  });
  await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("https://api.example.com/users/42");
  await page.getByRole("tab", { name: "Auth", exact: true }).click();
  await page.getByRole("tab", { name: "Bearer Token", exact: true }).click();
  await page.getByLabel("Bearer token", { exact: true }).fill("private-token");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const response = page.getByRole("region", { name: "HTTP response" });
  await expect(response).toBeVisible();
  await expect(response.getByLabel("Response summary")).toContainText(
    "200 OKHTTP/2•84 ms•",
  );
  await expect(response.getByText("JSON", { exact: true })).toBeVisible();
  await expect(response.locator(".cm-lineNumbers")).toBeVisible();
  await expect(response.locator(".cm-foldGutter")).toBeVisible();
  await expect(response.getByLabel("Response body viewer")).toContainText(
    '"active": true',
  );
  await response.getByLabel("Response body viewer", { exact: true }).click();
  await page.keyboard.press("Control+f");
  const responseFind = response.getByLabel("Find in response", { exact: true });
  await expect(responseFind).toBeFocused();
  await responseFind.fill("Alex");
  await expect(response.getByText("1/1", { exact: true })).toBeVisible();
  await expect(response.locator(".cm-searchMatch")).toHaveCount(1);
  await response.getByRole("button", { name: "Next match", exact: true }).click();
  await response.getByRole("button", { name: "Close find", exact: true }).click();
  await expect(responseFind).toHaveCount(0);
  await page.screenshot({
    path: "test-results/response-body.png",
    fullPage: true,
  });

  const activeLine = response.locator(".cm-line").filter({ hasText: '"active": true' });
  await activeLine.hover();
  const hoverRadii = await activeLine.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.borderTopLeftRadius, style.borderTopRightRadius];
  });
  expect(hoverRadii[0]).toBe(hoverRadii[1]);
  await activeLine.click();
  await expect(page.getByRole("menu", { name: "Response field actions", exact: true })).toHaveCount(0);
  await activeLine.click({ button: "right" });
  const fieldMenu = page.getByRole("menu", { name: "Response field actions", exact: true });
  await expect(fieldMenu).toBeVisible();
  await expect(fieldMenu.getByRole("separator")).toHaveCount(1);
  await expect(fieldMenu.getByRole("menuitem", { name: /JSONPath/ })).toContainText("$.data.users[0].active");
  await page.keyboard.press("Escape");

  expect(await response.locator(".cm-line span").count()).toBeGreaterThan(0);
  await response.getByRole("button", { name: "Raw", exact: true }).click();
  await expect(
    response.locator(".cm-line span:not(.cm-matchingBracket)"),
  ).toHaveCount(0);
  await expect(response.getByLabel("Response body viewer")).toContainText(
    '{"data":{"users":[{"name":"Alex","active":true}]},"count":1}',
  );
  await response.getByRole("button", { name: "Pretty", exact: true }).click();

  const jqQuery = response.getByLabel("jq response query");
  await jqQuery.click();
  const rootSuggestion = page.getByRole("option", { name: ".", exact: true });
  await expect(rootSuggestion).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(rootSuggestion).toBeVisible();
  await jqQuery.fill(".data.users[0].");
  await page
    .getByRole("option", { name: ".data.users[0].name", exact: true })
    .click();
  await expect(response.getByText("Showing filtered result.")).toBeVisible();
  await expect(response.getByLabel("Response body viewer")).toContainText(
    '"Alex"',
  );
  await page.screenshot({
    path: "test-results/response-filtered.png",
    fullPage: true,
  });
  await response.getByRole("button", { name: "Clear jq response query" }).click();
  await expect(response.getByText("Showing filtered result.")).toHaveCount(0);
  await expect(response.getByLabel("Response body viewer")).toContainText(
    '"active": true',
  );
  await response.getByRole("combobox", { name: "Response query language" }).click();
  await page.getByRole("option", { name: "JSONPath", exact: true }).click();
  await response.getByLabel("jsonpath response query").fill("$.count");
  await expect(response.getByLabel("Response body viewer")).toContainText("1");

  await response.getByRole("button", { name: "Hex", exact: true }).click();
  await expect(response.getByLabel("Response body viewer")).toContainText(
    "00000000",
  );
  await response.getByRole("button", { name: "Base64", exact: true }).click();
  await expect(response.getByLabel("Response body viewer")).toContainText(
    "eyJkYXRh",
  );

  await response.getByRole("tab", { name: /^Headers/ }).click();
  await expect(response.getByText("application/json; charset=utf-8")).toBeVisible();
  await page.keyboard.press("Control+f");
  const headerFind = response.getByLabel("Find in response", { exact: true });
  await headerFind.fill("report-to");
  await expect(headerFind).toBeFocused();
  await expect(response.getByText("1/1", { exact: true })).toBeVisible();
  await response.getByRole("button", { name: "Close find", exact: true }).click();
  await response
    .getByRole("button", { name: "Format JSON value for report-to" })
    .click();
  await expect(response.getByLabel("report-to header JSON")).toContainText(
    '"max_age": 3600',
  );
  await response.getByRole("tab", { name: /^Cookie/ }).click();
  await expect(response.getByText("sid", { exact: true })).toBeVisible();
  await expect(response.getByRole("textbox")).toHaveCount(0);
  await expect(response.getByText("Path=/ · HttpOnly")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/response-cookies.png",
    fullPage: true,
  });
  await response
    .getByRole("button", { name: "Show sid cookie attributes" })
    .click();
  await expect(response.getByText("Path=/ · HttpOnly")).toBeVisible();
  await response.getByRole("button", { name: "Reveal sid cookie value" }).click();
  await expect(response.getByText("secret", { exact: true })).toBeVisible();

  await response.getByRole("tab", { name: "Timeline", exact: true }).click();
  await expect(response.getByText("Connection + TTFB (70 ms)")).toBeVisible();
  await page.keyboard.press("Control+f");
  const timelineFind = response.getByLabel("Find in response", { exact: true });
  await timelineFind.fill("Preparing request");
  await expect(timelineFind).toBeFocused();
  await expect(response.getByText("1/1", { exact: true })).toBeVisible();
  await response.getByRole("button", { name: "Close find", exact: true }).click();
  await expect(response.getByText("Connection + TTFB (70 ms)").locator("span")).toHaveClass(/bg-action-brand/);
  await expect(response.getByLabel("Response time waterfall")).toHaveCount(0);
  await response.getByRole("button", { name: "Show breakdown" }).click();
  await expect(response.getByLabel("Response time waterfall")).toBeVisible();
  await expect(response.getByLabel("Network timeline log")).toContainText(
    "Preparing request to https://api.example.com/users/42",
  );
  await expect(response.getByLabel("Network timeline log")).toContainText(
    "HTTP/2 200 OK",
  );
  await expect(response.getByText("Authorization: Bearer ••••••••")).toBeVisible();
  await expect(
    response.getByText("set-cookie: sid=••••••••; Path=/; HttpOnly"),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 650 });
  await response.getByText(/^Response body received/).scrollIntoViewIfNeeded();
  await expect.poll(() => response.getByLabel("Response timeline", { exact: true }).evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(response.getByRole("tab", { name: "Trace", exact: true })).toBeDisabled();
  const responseTabs = await response.getByRole("tab").allTextContents();
  expect(responseTabs.at(-1)?.trim()).toBe("Request");
  await expect(response.getByRole("tab", { name: "Bench", exact: true })).toHaveCount(0);
  await response.getByRole("button", { name: "Network details" }).hover();
  const network = page.getByRole("dialog");
  await expect(network.getByText("Network", { exact: true })).toBeVisible();
  await expect(network).toContainText("192.168.1.10:53001");
  await expect(network).toContainText("203.0.113.42:443");
  await page.screenshot({
    path: "test-results/response-timeline.png",
    fullPage: true,
  });
});

test("HTML and simple media render safely while binary responses use the native save dialog", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).isTauri = true;
    (window as any).__download = null;
    (window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command === "save_response_body") { (window as any).__download = args; return "/Users/test/quarterly report.pdf"; }
      if (command !== "start_http") throw new Error(`Unexpected command: ${command}`);
      const path = new URL(args.request.url).pathname;
      if (path === "/page") return { status: 200, statusText: "OK", durationMs: 4, headers: [["content-type", "text/html; charset=utf-8"]], bodyBase64: btoa('<!doctype html><html><body><h1>Purr HTML</h1><script>document.body.textContent="unsafe"</script></body></html>') };
      if (path === "/pixel.png") return { status: 200, statusText: "OK", durationMs: 4, headers: [["content-type", "image/png"]], bodyBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };
      if (path === "/sound.mp3") return { status: 200, statusText: "OK", durationMs: 4, headers: [["content-type", "audio/mpeg"]], bodyBase64: btoa("ID3") };
      if (path === "/movie.mp4") return { status: 200, statusText: "OK", durationMs: 4, headers: [["content-type", "video/mp4"]], bodyBase64: btoa("media") };
      return { status: 200, statusText: "OK", durationMs: 4, headers: [["content-type", "application/pdf"], ["content-disposition", "attachment; filename*=UTF-8''quarterly%20report.pdf"]], bodyBase64: btoa("%PDF-1.7 binary") };
    } };
  });
  await page.goto("/");
  const url = page.getByLabel("Request URL", { exact: true });
  await url.fill("https://example.com/page");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const response = page.getByRole("region", { name: "HTTP response" });
  await expect(response.getByRole("button", { name: "Preview", exact: true })).toHaveAttribute("aria-pressed", "true");
  const html = page.frameLocator('iframe[title="HTML response preview"]');
  await expect(html.getByRole("heading", { name: "Purr HTML" })).toBeVisible();
  await expect(html.getByText("unsafe", { exact: true })).toHaveCount(0);

  await url.fill("https://example.com/pixel.png");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(response.getByRole("img", { name: "Response preview", exact: true })).toBeVisible();

  await url.fill("https://example.com/sound.mp3");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(response.getByLabel("Audio response preview", { exact: true })).toBeVisible();

  await url.fill("https://example.com/movie.mp4");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(response.getByLabel("Video response preview", { exact: true })).toBeVisible();

  await url.fill("https://example.com/report");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(response.getByText("Binary response", { exact: true })).toBeVisible();
  await expect(response.getByText("quarterly report.pdf", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/response-binary-download.png", fullPage: true });
  await response.getByRole("button", { name: "Download…", exact: true }).click();
  await expect(response.getByRole("status")).toContainText("Saved to /Users/test/quarterly report.pdf");
  const download = await page.evaluate(() => (window as any).__download);
  expect(download.suggestedName).toBe("quarterly report.pdf");
  expect(download.extension).toBe("pdf");
  expect(atob(download.bodyBase64)).toBe("%PDF-1.7 binary");
});
