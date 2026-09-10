import { expect, test, type Page } from "@playwright/test";

const mod = process.platform === "darwin" ? "Meta" : "Control";
const tabs = (page: Page) => page.getByRole("tablist", { name: "Documents", exact: true }).getByRole("tab");
const saved = (page: Page) => expect(page.getByRole("status").filter({ hasText: "Saved locally" })).toBeVisible();

async function saveDocument(page: Page, name: string) {
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await page.getByLabel("Document name", { exact: true }).fill(name);
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
}

async function createEnvironment(page: Page, name: string, values: Record<string, string>) {
  await page.getByRole("button", { name: "Select environment" }).click();
  await page.getByRole("button", { name: "New environment", exact: true }).click();
  await page.getByLabel("Environment name", { exact: true }).fill(name);
  for (const [index, [key, value]] of Object.entries(values).entries()) {
    await page.getByRole("button", { name: "Add variable", exact: true }).click();
    await page.getByLabel(`Variable ${index + 1} name`, { exact: true }).fill(key);
    await page.getByLabel(`Variable ${index + 1} value`, { exact: true }).fill(value);
  }
  await page.getByRole("button", { name: "Save environment", exact: true }).click();
}

async function mockDesktop(page: Page, delayed = false) {
  await page.addInitScript(({ delayed }) => {
    (window as any).isTauri = true;
    (window as any).__requests = [];
    (window as any).__commands = [];
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: any) => {
        (window as any).__commands.push(command);
        if (command === "load_workspace_store") return JSON.parse(localStorage.getItem("native-test-store") ?? "null");
        if (command === "save_workspace") {
          const store = JSON.parse(localStorage.getItem("native-test-store") ?? '{"activeWorkspaceId":"personal","workspaces":[]}');
          store.workspaces = [...store.workspaces.filter((workspace: any) => workspace.id !== args.workspace.id), args.workspace];
          localStorage.setItem("native-test-store", JSON.stringify(store)); return;
        }
        if (command === "set_active_workspace") {
          const store = JSON.parse(localStorage.getItem("native-test-store")!); store.activeWorkspaceId = args.id;
          localStorage.setItem("native-test-store", JSON.stringify(store)); return;
        }
        if (command !== "send_http") return;
        (window as any).__requests.push(args.request);
        const response = { status: 200, statusText: "OK", durationMs: 42, httpVersion: "HTTP/2", headers: [["content-type", "application/json"], ["set-cookie", "persisted=one; Secure; HttpOnly; Path=/"]], bodyBase64: btoa('{"source":"first-document"}') };
        if (delayed) return new Promise((resolve) => { (window as any).__finishRequest = () => resolve(response); });
        return response;
      },
    };
  }, { delayed });
}

test("documents, workspace selection, environments and independent layouts survive reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Select workspace" })).toContainText("Personal");
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("");
  await page.getByLabel("Request URL", { exact: true }).fill("{{base}}/users");
  await saveDocument(page, "List users");
  await expect(page.getByRole("region", { name: "HTTP", exact: true }).getByRole("button", { name: "GET List users" })).toBeVisible();
  await page.getByRole("button", { name: "New HTTP request", exact: true }).click();
  await expect(tabs(page)).toHaveCount(2);
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/draft");
  await createEnvironment(page, "Local", { base: "https://example.com" });
  await page.getByRole("button", { name: "Vertical split view" }).click();
  const separator = page.getByRole("separator", { name: "Resize Request editor and Response viewer" });
  await separator.focus(); await page.keyboard.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "54");
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await saved(page);
  await page.reload();
  await expect(tabs(page)).toHaveCount(2);
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("https://example.com/draft");
  await expect(page.getByRole("button", { name: "Select environment" })).toContainText("Local");
  await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();
  await expect(separator).toHaveAttribute("aria-valuenow", "54");
  await page.getByRole("button", { name: "Select workspace" }).click();
  await page.getByRole("button", { name: "New workspace", exact: true }).click();
  await page.getByLabel("Workspace name", { exact: true }).fill("Acme Backend");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Canvas view" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Select environment" })).toContainText("No environment");
  await expect(page.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
  await saved(page); await page.reload();
  await expect(page.getByRole("button", { name: "Select workspace" })).toContainText("Acme Backend");
  await page.getByRole("button", { name: "Select workspace" }).click();
  await page.getByRole("button", { name: "Personal", exact: true }).click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(separator).toHaveAttribute("aria-valuenow", "54");
  await page.screenshot({ path: "test-results/workspaces-restored.png", fullPage: true });
});

test("command palette and shortcuts navigate, duplicate and recover closed drafts", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/one");
  await saveDocument(page, "First request");
  await page.keyboard.press(`${mod}+n`);
  await expect(tabs(page)).toHaveCount(2);
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/two");
  await page.keyboard.press(`${mod}+w`);
  await expect(tabs(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page.getByRole("combobox", { name: "Search commands" }).fill("example.com/two");
  await page.keyboard.press("Enter");
  await expect(tabs(page)).toHaveCount(2);
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("https://example.com/two");
  await page.keyboard.press(`${mod}+d`);
  await expect(tabs(page)).toHaveCount(3);
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/duplicate");
  await page.keyboard.press(`${mod}+k`);
  await page.getByRole("combobox", { name: "Search commands" }).fill("First request");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("https://example.com/one");
  await page.keyboard.press(`${mod}+b`);
  await expect(page.getByRole("complementary", { name: "Workspace documents" })).toHaveCount(0);
  await page.keyboard.press(`${mod}+Shift+2`);
  await expect(page.getByRole("button", { name: "Horizontal split view" })).toHaveAttribute("aria-pressed", "true");
});

test("document tabs can be reordered and keep their order after reload", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/first");
  await saveDocument(page, "First request with a long name");
  await page.getByRole("button", { name: "New HTTP request", exact: true }).click();
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/second");
  await saveDocument(page, "B");

  const first = tabs(page).filter({ hasText: "First request with a long name" });
  const second = tabs(page).filter({ hasText: "B" });
  const firstBox = (await first.boundingBox())!;
  const secondBox = (await second.boundingBox())!;
  await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(firstBox.x + firstBox.width * 0.9, firstBox.y + firstBox.height * 2, { steps: 8 });
  await expect.poll(() => first.locator("..").getAttribute("style")).not.toContain("0px");
  await expect.poll(() => first.locator("..").evaluate((element) => getComputedStyle(element).transitionProperty)).toContain("transform");
  await expect.poll(() => second.locator("..").evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).m42)).toBe(0);
  await expect(second.locator("..")).toHaveCSS("opacity", "1");
  const beforeDrop = { first: await first.locator("..").boundingBox(), second: await second.locator("..").boundingBox() };
  await page.mouse.up();
  const afterDrop = { first: await first.locator("..").boundingBox(), second: await second.locator("..").boundingBox() };
  expect(Math.abs(afterDrop.first!.x - beforeDrop.first!.x)).toBeLessThan(firstBox.width / 10);
  expect(Math.abs(afterDrop.second!.x - beforeDrop.second!.x)).toBeLessThan(secondBox.width / 10);
  await expect(tabs(page).nth(0)).toContainText("B");
  await expect(tabs(page).nth(1)).toContainText("First request with a long name");
  await saved(page);
  await page.reload();
  await expect(tabs(page).nth(0)).toContainText("B");
  await expect(tabs(page).nth(1)).toContainText("First request with a long name");
});

test("sidebar opens one italic preview tab that pins itself after editing", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/first");
  await saveDocument(page, "First");
  await page.getByRole("button", { name: "New HTTP request", exact: true }).click();
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/second");
  await saveDocument(page, "Second");
  await page.getByRole("button", { name: "Close Second", exact: true }).click();
  await page.getByRole("button", { name: "Close First", exact: true }).click();
  await expect(tabs(page)).toHaveCount(0);

  const requests = page.getByRole("region", { name: "HTTP", exact: true });
  await requests.getByRole("button", { name: "GET First", exact: true }).click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(tabs(page).locator("span").nth(1)).toHaveClass(/italic/);
  await requests.getByRole("button", { name: "GET Second", exact: true }).click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(tabs(page).first()).toContainText("Second");
  await expect(tabs(page).locator("span").nth(1)).toHaveClass(/italic/);

  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/second-edited");
  await expect(tabs(page).locator("span").nth(1)).not.toHaveClass(/italic/);
  await requests.getByRole("button", { name: "GET First", exact: true }).click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).filter({ hasText: "First" }).locator("span").nth(1)).toHaveClass(/italic/);
  await expect(tabs(page).filter({ hasText: "Second" }).locator("span").nth(1)).not.toHaveClass(/italic/);
});

test("blank tabs stay out of Drafts and real drafts can be discarded from the sidebar", async ({ page }) => {
  await page.goto("/");
  const draftGroup = page.getByRole("region", { name: "Drafts", exact: true });
  await expect(draftGroup.getByRole("button")).toHaveCount(1);

  await page.getByRole("button", { name: "Create document", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "HTTP request", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "HTTP request", exact: true }).click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(draftGroup.getByRole("button")).toHaveCount(1);

  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/discard-me");
  await expect(draftGroup.getByRole("button", { name: "GET example.com/discard-me", exact: true })).toBeVisible();
  await draftGroup.getByRole("button", { name: "Document actions for example.com/discard-me", exact: true }).click();
  await page.getByRole("menuitem", { name: "Discard draft", exact: true }).click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(draftGroup.getByRole("button")).toHaveCount(1);

  await page.getByRole("button", { name: "Create document", exact: true }).click();
  await page.getByRole("menuitem", { name: "HTTP request", exact: true }).click();
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/first-draft");
  await page.getByRole("button", { name: "New HTTP request", exact: true }).click();
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/second-draft");
  await expect(page.getByRole("button", { name: "Discard all drafts", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Discard all drafts", exact: true }).click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Discard all drafts", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Open command palette" }).click();
  await expect(page.getByRole("dialog", { name: "Search documents and commands" })).toBeVisible();
  await expect(page.getByText("Quick actions", { exact: true })).toBeVisible();
});

test("saved requests use a working copy until changes are explicitly saved", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/saved");
  await saveDocument(page, "Stable request");
  await expect(page.getByRole("button", { name: "Save document", exact: true })).toHaveCount(0);

  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/temporary");
  await expect(page.getByRole("button", { name: "Save document", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close Stable request", exact: true }).click();
  await page.getByRole("region", { name: "HTTP", exact: true }).getByRole("button", { name: "GET Stable request", exact: true }).click();
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("https://example.com/saved");

  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/explicit-save");
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save document", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Close Stable request", exact: true }).click();
  await page.getByRole("region", { name: "HTTP", exact: true }).getByRole("button", { name: "GET Stable request", exact: true }).click();
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("https://example.com/explicit-save");
});

test("saved documents can be deleted from the sidebar context menu", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/remove");
  await saveDocument(page, "Remove me");
  const row = page.getByRole("region", { name: "HTTP", exact: true }).getByRole("button", { name: "GET Remove me", exact: true });
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete document", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(0);
});

test("response and workspace cookies survive persistence and the workspace folder opens natively", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Personal · Local workspace", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__commands.filter((command: string) => command === "open_workspace_folder").length)).toBe(1);

  await page.getByLabel("Request URL", { exact: true }).fill("https://api.example.com/users/42");
  await saveDocument(page, "Persistent result");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("region", { name: "HTTP response", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cookies 1", exact: true })).toBeVisible();
  await saved(page);
  await page.reload();

  await expect(page.getByRole("region", { name: "HTTP response", exact: true })).toBeVisible();
  await expect(page.locator(".ui-response-code")).toContainText("first-document");
  await page.getByRole("button", { name: "Cookies 1", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Cookies 1", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Request composer", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Workspace cookies", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Enable persisted", exact: true })).toBeChecked();
  await saved(page);
  await page.reload();
  await expect(page.getByRole("tab", { name: "Cookies 1", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Workspace cookies", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Enable persisted", exact: true })).toBeChecked();
  await page.screenshot({ path: "test-results/workspace-cookies-tab.png", fullPage: true });
  await page.getByRole("button", { name: "Close workspace cookies", exact: true }).click();
  await expect(page.getByRole("region", { name: "HTTP response", exact: true })).toBeVisible();
});

test("dialogs focus their primary field instead of the close button", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Select workspace" }).click();
  await page.getByRole("button", { name: "New workspace", exact: true }).click();
  await expect(page.getByLabel("Workspace name", { exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Close dialog", exact: true })).not.toBeFocused();
});

test("environment templates reach native request URL, auth, headers and JSON while editor stays templated", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await createEnvironment(page, "Local", { base: "https://example.com", id: "42", key: "X-Tenant", tenant: "acme", token: "local-token" });
  await page.getByLabel("Request URL", { exact: true }).fill("{{base}}/users/{{id}}?name={{tenant}}");
  await page.getByRole("tab", { name: "Auth", exact: true }).click();
  await page.getByRole("tab", { name: "Bearer Token", exact: true }).click();
  await page.getByLabel("Bearer token", { exact: true }).fill("{{token}}");
  await page.getByRole("tab", { name: /^Headers/ }).click();
  await page.locator('input[placeholder="Header-name"]:not(:disabled)').fill("{{key}}");
  await page.getByLabel("Value for {{key}}", { exact: true }).fill("{{tenant}}");
  await page.getByRole("tab", { name: "Body", exact: true }).click();
  await page.getByRole("tab", { name: "JSON", exact: true }).click();
  await page.locator(".cm-content[contenteditable=true]").fill('{"id":{{id}},"tenant":"{{tenant}}"}');
  await page.keyboard.press(`${mod}+Enter`);
  await expect(page.getByRole("region", { name: "HTTP response", exact: true })).toBeVisible();
  const request = await page.evaluate(() => (window as any).__requests[0]);
  expect(request.url).toBe("https://example.com/users/42?name=acme");
  expect(request.headers).toContainEqual(["Authorization", "Bearer local-token"]);
  expect(request.headers).toContainEqual(["X-Tenant", "acme"]);
  expect(JSON.parse(Buffer.from(request.bodyBase64, "base64").toString())).toEqual({ id: 42, tenant: "acme" });
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("{{base}}/users/{{id}}?name={{tenant}}");
  await saved(page); await page.reload();
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("{{base}}/users/{{id}}?name={{tenant}}");
  await expect(page.locator(".cm-content[contenteditable=true]")).toContainText('{{id}}');
  await page.getByRole("button", { name: "Select environment" }).click();
  await page.getByRole("button", { name: "No environment", exact: true }).click();
  await page.keyboard.press(`${mod}+Enter`);
  await expect(page.getByRole("alert")).toContainText('Environment variable “base” is not defined');
  expect(await page.evaluate(() => (window as any).__requests.length)).toBe(0);
});

test("late responses belong to the originating document, not the active tab", async ({ page }) => {
  await mockDesktop(page, true);
  await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/first");
  await saveDocument(page, "In flight");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__requests.length)).toBe(1);
  await page.getByRole("button", { name: "New HTTP request", exact: true }).click();
  await page.evaluate(() => (window as any).__finishRequest());
  await expect(page.getByRole("region", { name: "HTTP response", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("");
  await tabs(page).filter({ hasText: "In flight" }).click();
  await expect(page.getByRole("region", { name: "HTTP response", exact: true })).toBeVisible();
  await expect(page.locator(".ui-response-code")).toContainText("first-document");
});

test("binary attachments restore their bytes from workspace storage", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Body", exact: true }).click();
  await page.getByRole("tab", { name: "Binary", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: "payload.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 127, 255, 42]) });
  await saved(page); await page.reload();
  await expect(page.getByText("payload.bin", { exact: true })).toBeVisible();
  const bytes = await page.evaluate(async () => {
    const { loadWorkspaceStore } = await import("/src/features/workspaces/services/workspace-storage.ts" as string);
    const store = await loadWorkspaceStore();
    return [...new Uint8Array(await store.workspaces[0].documents[0].request.body.binary.file.arrayBuffer())];
  });
  expect(bytes).toEqual([0, 127, 255, 42]);
});

test("damaged workspace data is reported without overwriting the original", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("purr.workspaces.v1", "broken-json"));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Retry loading workspaces" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("purr.workspaces.v1"))).toBe("broken-json");
});
