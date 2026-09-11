import { test, expect } from "@playwright/test";
import { installPersistenceMock } from "./persistence-mock";
test.beforeEach(async ({ page }) => installPersistenceMock(page));

test("empty authentication and body states stay compact", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("tab", { name: /^Auth/ }).click();
  const noAuthentication = page.getByText("No authentication", { exact: true });
  await expect(noAuthentication).toBeVisible();
  expect(
    await noAuthentication
      .locator("..")
      .evaluate((element) => getComputedStyle(element).flexDirection),
  ).toBe("row");
  expect((await page.locator("#request-auth-type-panel").boundingBox())!.height).toBeLessThan(
    100,
  );

  await page.getByRole("tab", { name: "Body", exact: true }).click();
  const noBody = page.getByText("No body", { exact: true }).first();
  await expect(noBody).toBeVisible();
  expect(
    await noBody
      .locator("..")
      .evaluate((element) => getComputedStyle(element).flexDirection),
  ).toBe("row");
  await page.screenshot({
    path: "test-results/request-empty-body.png",
    fullPage: true,
  });

  await page.getByRole("tab", { name: "Binary", exact: true }).click();
  const binaryPicker = page.locator('button[aria-label="Choose body file"]');
  await expect(binaryPicker).toBeVisible();
  expect((await binaryPicker.boundingBox())!.height).toBeLessThan(100);
  await page.screenshot({
    path: "test-results/request-binary-body.png",
    fullPage: true,
  });
});

test("Bearer is masked, generates a locked header, and preserves separate auth drafts", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Auth", exact: true }).click();
  await page.getByRole("tab", { name: "Bearer Token", exact: true }).click();
  const token = page.getByLabel("Bearer token", { exact: true });
  const prefix = page.getByRole("combobox", { name: "Token prefix" });
  expect(await prefix.evaluate((element) => element.getBoundingClientRect().height)).toBe(
    await token.evaluate(
      (element) => element.parentElement!.getBoundingClientRect().height,
    ),
  );
  await token.fill("Bearer demo-token");
  await token.focus();
  expect(
    await token.evaluate((element) =>
      element.classList.contains("ui-focus-ring"),
    ),
  ).toBe(false);
  await expect(token).toHaveValue("demo-token");
  await expect(token).toHaveAttribute("type", "password");
  await page
    .getByRole("button", { name: "Reveal Bearer token", exact: true })
    .click();
  await expect(token).toHaveAttribute("type", "text");
  await page.getByRole("tab", { name: /^Headers/ }).click();
  await expect(page.locator('input[value="Authorization"]')).toBeDisabled();
  const generatedHeader = page.getByRole("textbox", {
    name: "Value for Authorization",
    exact: true,
  });
  await expect(generatedHeader).toBeDisabled();
  await expect(generatedHeader).toHaveAttribute("type", "password");
  await page
    .getByRole("button", { name: "Reveal Value for Authorization" })
    .click();
  await expect(generatedHeader).toHaveValue("Bearer demo-token");
  await page.getByRole("tab", { name: /^Auth/ }).click();
  await page.getByRole("tab", { name: "Basic Auth", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill("user");
  await page.getByLabel("Password", { exact: true }).fill("secret");
  await page.getByRole("tab", { name: "Bearer Token", exact: true }).click();
  await expect(page.getByLabel("Bearer token", { exact: true })).toHaveValue(
    "demo-token",
  );
  const jwt = [
    Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
    Buffer.from(
      '{"sub":"1234567890","name":"John Doe","admin":true}',
    ).toString("base64url"),
    "signature",
  ].join(".");
  await page.getByLabel("Bearer token", { exact: true }).fill(jwt);
  await page.getByRole("button", { name: /^Inspect JWT/ }).click();
  await expect(page.locator('[aria-label="Header JWT JSON"]')).toBeVisible();
  await expect(page.locator('[aria-label="Claims JWT JSON"]')).toBeVisible();
  const previewHeights = await page
    .locator(".ui-json-preview .cm-editor")
    .evaluateAll((editors) =>
      editors.map((editor) => editor.getBoundingClientRect().height),
    );
  expect(previewHeights).toHaveLength(2);
  expect(previewHeights[0]).toBe(previewHeights[1]);
  await expect(
    page.getByText("Decoded locally. The signature has not been verified."),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/auth-bearer.png",
    fullPage: true,
  });
});

test("API key placement, OAuth fields, cookies and compact responsive layout", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("https://api.example.com/users/42");
  await page.getByRole("tab", { name: "Auth", exact: true }).click();
  await page.getByRole("tab", { name: "API Key", exact: true }).click();
  await page.getByLabel("Key name", { exact: true }).fill("api_key");
  await page.getByLabel("Key value", { exact: true }).fill("abc");
  const apiControlHeights = await Promise.all([
    page
      .getByLabel("Key name", { exact: true })
      .evaluate((element) => element.getBoundingClientRect().height),
    page
      .getByLabel("Key value", { exact: true })
      .evaluate(
        (element) => element.parentElement!.getBoundingClientRect().height,
      ),
    page
      .getByRole("combobox", { name: "Add API key to" })
      .evaluate((element) => element.getBoundingClientRect().height),
  ]);
  expect(new Set(apiControlHeights).size).toBe(1);
  await page.getByRole("combobox", { name: "Add API key to" }).click();
  await page.getByRole("option", { name: "Query param", exact: true }).click();
  await page.getByRole("tab", { name: /^Params/ }).click();
  await expect(page.locator('input[value="api_key"]')).toBeDisabled();
  await page.getByRole("tab", { name: /^Auth/ }).click();
  await page.getByRole("tab", { name: "OAuth 2.0", exact: true }).click();
  await expect(
    page.getByLabel("Authorization URL", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("combobox", { name: "OAuth grant type" }).click();
  await page
    .getByRole("option", { name: "Authorization Code + PKCE", exact: true })
    .click();
  await expect(page.getByLabel("Callback URL", { exact: true })).toHaveValue(
    "http://127.0.0.1:8976/oauth/callback",
  );
  await page.screenshot({
    path: "test-results/auth-oauth.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: /^Cookies/ }).click();
  await page.getByRole("button", { name: "Add cookie", exact: true }).click();
  await page.getByLabel("Cookie name", { exact: true }).fill("session_id");
  await page.getByLabel("Cookie value", { exact: true }).fill("session");
  await page.getByRole("button", { name: "Save cookie", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Enable session_id", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("checkbox", { name: "Enable session_id", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "Enable session_id", exact: true }),
  ).not.toBeChecked();
  await page.setViewportSize({ width: 600, height: 900 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
});

test("request pipeline applies auth, learns cookies and sends them on the next request", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    (window as any).__testRequests = calls;
    (window as any).isTauri = true;
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: any) => {
        if (command !== "send_http") throw new Error("Unexpected command");
        calls.push(args.request);
        return {
          status: 200,
          statusText: "OK",
          durationMs: 1,
          headers: [["Set-Cookie", "sid=one; Secure; HttpOnly; Path=/"]],
          bodyBase64: btoa('{"access_token":"response-token"}'),
        };
      },
    };
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Auth", exact: true }).click();
  await page.getByRole("tab", { name: "Basic Auth", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill("user");
  await page.getByLabel("Password", { exact: true }).fill("pass");
  await page.getByLabel("Request URL", { exact: true }).fill("https://api.example.com/users/42");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "HTTP response" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__testRequests.length))
    .toBe(2);
  const requests = await page.evaluate(() => (window as any).__testRequests);
  expect(requests[0].headers).toContainEqual([
    "Authorization",
    "Basic dXNlcjpwYXNz",
  ]);
  expect(requests[1].headers).toContainEqual(["Cookie", "sid=one"]);
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await page.getByLabel("Document name", { exact: true }).fill("Token request");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "New HTTP request", exact: true }).click();
  await page.getByLabel("Request URL", { exact: true }).fill("https://api.example.com/profile");
  await page.getByRole("tab", { name: /^Auth/ }).click();
  await page.getByRole("tab", { name: "Bearer Token", exact: true }).click();
  await page
    .getByRole("button", { name: "Use token from response", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Token request document", exact: true }).click();
  await page.getByRole("option", { name: "Token request", exact: true }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__testRequests.length))
    .toBe(4);
  expect((await page.evaluate(() => (window as any).__testRequests))[2].url).toBe("https://api.example.com/users/42");
  expect(
    (await page.evaluate(() => (window as any).__testRequests))[3].headers,
  ).toContainEqual(["Authorization", "Bearer response-token"]);
});

test("OAuth refreshes while another request tab is open", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).isTauri = true;
    (window as any).__tokenCalls = [];
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: any) => {
        if (command !== "send_http") return;
        const calls = (window as any).__tokenCalls;
        calls.push(args.request);
        return {
          status: 200,
          statusText: "OK",
          durationMs: 1,
          headers: [],
          bodyBase64: btoa(
            JSON.stringify({
              access_token:
                calls.length === 1 ? "first-access" : "renewed-access",
              token_type: "Bearer",
              expires_in: calls.length === 1 ? 2 : 3600,
            }),
          ),
        };
      },
    };
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Auth", exact: true }).click();
  await page.getByRole("tab", { name: "OAuth 2.0", exact: true }).click();
  await page
    .getByLabel("Token URL", { exact: true })
    .fill("https://auth.example.com/token");
  await page.getByLabel("Client ID", { exact: true }).fill("client");
  await page.getByLabel("Client Secret", { exact: true }).fill("secret");
  await page
    .getByRole("button", { name: "Fetch & use token", exact: true })
    .click();
  await expect(
    page.getByLabel("OAuth access token", { exact: true }),
  ).toHaveValue("first-access");
  await page.getByRole("tab", { name: /^Headers/ }).click();
  await expect(
    page.locator('input[value="Bearer renewed-access"]'),
  ).toBeVisible({ timeout: 10000 });
  expect(await page.evaluate(() => (window as any).__tokenCalls.length)).toBe(
    2,
  );
});

test("OAuth ignores a late token after the client configuration changes", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).isTauri = true;
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command !== "send_http") return;
        return new Promise((resolve) => {
          (window as any).__completeToken = () =>
            resolve({
              status: 200,
              statusText: "OK",
              durationMs: 1,
              headers: [],
              bodyBase64: btoa(
                '{"access_token":"stale-access","token_type":"Bearer","expires_in":3600}',
              ),
            });
        });
      },
    };
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Auth", exact: true }).click();
  await page.getByRole("tab", { name: "OAuth 2.0", exact: true }).click();
  await page
    .getByLabel("Token URL", { exact: true })
    .fill("https://auth.example.com/token");
  await page.getByLabel("Client ID", { exact: true }).fill("client");
  await page.getByLabel("Client Secret", { exact: true }).fill("secret");
  await page
    .getByRole("button", { name: "Fetch & use token", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Client ID", { exact: true }).fill("different-client");
  await page.evaluate(() => (window as any).__completeToken());
  await expect(page.getByText("Not authorized", { exact: true })).toBeVisible();
  await expect(
    page.getByLabel("OAuth access token", { exact: true }),
  ).toHaveCount(0);
});

test("PKCE authorization passes a challenge and exchanges the code with its verifier", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).isTauri = true;
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: any) => {
        if (command === "authorize_oauth") {
          (window as any).__authorization = args;
          return "returned-code";
        }
        if (command === "send_http") {
          (window as any).__exchange = args.request;
          return {
            status: 200,
            statusText: "OK",
            durationMs: 1,
            headers: [],
            bodyBase64: btoa(
              '{"access_token":"pkce-access","token_type":"Bearer","refresh_token":"refresh-token","expires_in":3600}',
            ),
          };
        }
      },
    };
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Auth", exact: true }).click();
  await page.getByRole("tab", { name: "OAuth 2.0", exact: true }).click();
  await page.getByRole("combobox", { name: "OAuth grant type" }).click();
  await page
    .getByRole("option", { name: "Authorization Code + PKCE", exact: true })
    .click();
  await page
    .getByLabel("Authorization URL", { exact: true })
    .fill("https://auth.example.com/authorize");
  await page
    .getByLabel("Token URL", { exact: true })
    .fill("https://auth.example.com/token");
  await page.getByLabel("Client ID", { exact: true }).fill("client");
  await page
    .getByRole("button", { name: "Authorize & use token", exact: true })
    .click();
  await expect(
    page.getByLabel("OAuth access token", { exact: true }),
  ).toHaveValue("pkce-access");
  const authorization = await page.evaluate(
    () => (window as any).__authorization,
  );
  const exchange = await page.evaluate(() => (window as any).__exchange);
  const params = new URL(authorization.authorizationUrl).searchParams;
  expect(params.get("code_challenge_method")).toBe("S256");
  expect(params.get("state")).toBe(authorization.state);
  const form = new URLSearchParams(
    Buffer.from(exchange.bodyBase64, "base64").toString(),
  );
  expect(form.get("code")).toBe("returned-code");
  expect(form.get("code_verifier")!.length).toBeGreaterThanOrEqual(43);
  expect(form.get("client_secret")).toBeNull();
  await expect(
    page.getByText("Refresh token available", { exact: true }),
  ).toBeVisible();
});
