import { expect, test } from "@playwright/test";

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
        if (command === "load_workspace_store") return null;
        if (command === "save_workspace" || command === "set_active_workspace") return;
        if (command !== "send_http") throw new Error("Unexpected command");
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
  await page.screenshot({
    path: "test-results/response-body.png",
    fullPage: true,
  });

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
  await expect(response.getByRole("tab", { name: "Bench", exact: true })).toBeDisabled();
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
