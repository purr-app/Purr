import { expect, test, type Page } from "@playwright/test";
import { installPersistenceMock } from "./persistence-mock";
test.beforeEach(async ({ page }) => installPersistenceMock(page));

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
  for (const [key, value] of Object.entries(values)) {
    await page.getByRole("button", { name: "Variable", exact: true }).click();
    await page.getByLabel("Variable name", { exact: true }).fill(key);
    await page.getByLabel("Variable value", { exact: true }).fill(value);
    await page.getByRole("button", { name: "Save variable", exact: true }).click();
  }
  await page.getByRole("tab", { name: "Variables", exact: true }).hover();
  await page.getByRole("button", { name: "Close variables", exact: true }).click();
}

async function mockDesktop(page: Page, delayed = false) {
  await page.addInitScript(({ delayed }) => {
    (window as any).isTauri = true;
    (window as any).__requests = [];
    (window as any).__commands = [];
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: any) => {
        (window as any).__commands.push(command);
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
  await expect(page.getByRole("complementary", { name: "Workspace documents" })).not.toBeVisible();
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
  // Measure settled drag positions rather than a mid-transition frame under load.
  await first.locator("..").evaluate(async (element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  await second.locator("..").evaluate(async (element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  await page.mouse.up();
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
  await expect(draftGroup).toHaveCount(0);

  await page.getByRole("button", { name: "Create document", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "HTTP request", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "HTTP request", exact: true }).click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(draftGroup).toHaveCount(0);

  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/discard-me");
  await expect(draftGroup.getByRole("button", { name: "GET example.com/discard-me", exact: true })).toBeVisible();
  await draftGroup.getByRole("button", { name: "Document actions for example.com/discard-me", exact: true }).click();
  await page.getByRole("menuitem", { name: "Discard draft", exact: true }).click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(draftGroup).toHaveCount(0);

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

test("workspace settings tab manages identity, shared headers and scoped auth", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Select workspace" }).click();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  const settings = page.getByRole("region", { name: "Workspace settings", exact: true });
  await expect(page.getByRole("tab", { name: "Workspace settings", exact: true })).toHaveAttribute("aria-selected", "true");
  await settings.getByLabel("Workspace name", { exact: true }).fill("Personal API");
  await settings.getByLabel("Workspace description", { exact: true }).fill("Shared API defaults");
  await settings.getByRole("tab", { name: "Shared headers", exact: true }).click();
  await settings.getByPlaceholder("Header-name", { exact: true }).fill("X-Workspace");
  await settings.getByRole("textbox", { name: "Value for X-Workspace", exact: true }).fill("shared-value");
  await settings.getByRole("combobox", { name: "Requests for X-Workspace", exact: true }).click();
  await expect(page.getByRole("option", { name: "GraphQL", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "All requests", exact: true }).click();
  await settings.getByRole("tab", { name: "Shared auth", exact: true }).click();
  await settings.getByRole("button", { name: "Add shared auth", exact: true }).click();
  await settings.getByLabel("Auth name", { exact: true }).fill("Main API auth");
  await settings.getByRole("tab", { name: "Bearer Token", exact: true }).click();
  await settings.getByLabel("Bearer token", { exact: true }).fill("workspace-token");
  await settings.getByRole("button", { name: "Save authentication", exact: true }).click();
  await expect(settings.getByText("Main API auth", { exact: true })).toBeVisible();
  await expect(settings.getByText("Bearer Token · All requests", { exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Add shared auth", exact: true })).toBeDisabled();
  await settings.getByRole("button", { name: "Edit Main API auth", exact: true }).click();
  await settings.getByRole("combobox", { name: "Requests using this authentication", exact: true }).click();
  await page.getByRole("option", { name: "HTTP", exact: true }).click();
  await settings.getByRole("button", { name: "Save authentication", exact: true }).click();
  await settings.getByRole("button", { name: "Add shared auth", exact: true }).click();
  await expect(settings.getByRole("combobox", { name: "Requests using this authentication", exact: true })).toContainText("GraphQL");
  await settings.getByLabel("Auth name", { exact: true }).fill("GraphQL auth");
  await settings.getByRole("tab", { name: "Bearer Token", exact: true }).click();
  await settings.getByLabel("Bearer token", { exact: true }).fill("graphql-token");
  await settings.getByRole("button", { name: "Save authentication", exact: true }).click();
  await expect(settings.getByText("Bearer Token · HTTP requests", { exact: true })).toBeVisible();
  await expect(settings.getByText("Bearer Token · GraphQL requests", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: /Untitled Request/, exact: true }).click();

  await page.getByLabel("Request URL", { exact: true }).fill("https://api.example.com/users/42");
  await page.getByRole("tab", { name: /^Headers/ }).click();
  await expect(page.getByRole("button", { name: "Inherited 1", exact: true })).toBeVisible();
  const sharedHeaderToggle = page.getByRole("checkbox", { name: "Include X-Workspace", exact: true });
  await sharedHeaderToggle.click();
  await expect(sharedHeaderToggle).toHaveAttribute("aria-checked", "false");
  await sharedHeaderToggle.click();
  await expect(sharedHeaderToggle).toHaveAttribute("aria-checked", "true");
  await page.getByRole("tab", { name: /^Auth/ }).click();
  await expect(page.getByRole("tab", { name: "Inherit", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText(/Authentication inherited from Main API auth/)).toContainText("Bearer Token");
  await expect(page.getByRole("combobox", { name: "Inherit authentication from", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await expect(page.locator("#request-section-settings").getByRole("checkbox")).toHaveCount(0);

  await page.getByRole("button", { name: "Open request code", exact: true }).click();
  const code = page.getByRole("dialog", { name: "Request code" });
  await expect(code.getByLabel("Request code viewer")).toContainText("curl");
  await expect(code.getByLabel("Request code viewer")).toContainText("X-Workspace: shared-value");
  await code.getByRole("tab", { name: "HTTP/1.1", exact: true }).click();
  await expect(code.getByLabel("Request code viewer")).toContainText("GET /users/42 HTTP/1.1");
  await code.getByRole("button", { name: "Close dialog", exact: true }).click();

  await page.getByRole("button", { name: "Send", exact: true }).click();
  const sent = await page.evaluate(() => (window as any).__requests.at(-1));
  expect(sent.headers).toContainEqual(["X-Workspace", "shared-value"]);
  expect(sent.headers).toContainEqual(["Authorization", "Bearer workspace-token"]);
  const response = page.getByRole("region", { name: "HTTP response", exact: true });
  await response.getByRole("tab", { name: "Request", exact: true }).click();
  await expect(response.getByLabel("HTTP request viewer")).toContainText("GET /users/42 HTTP/1.1");
  await expect(response.getByLabel("HTTP request viewer")).toContainText("Authorization: Bearer ********");
  await response.getByRole("button", { name: "Reveal request secrets", exact: true }).click();
  await expect(response.getByLabel("HTTP request viewer")).toContainText("Authorization: Bearer workspace-token");
});

test("sidebar context menu renames saved documents", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/original");
  await saveDocument(page, "Original name");
  const row = page.getByRole("region", { name: "HTTP", exact: true }).getByRole("button", { name: "GET Original name", exact: true });
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename document", exact: true }).click();
  await page.getByLabel("Document name", { exact: true }).fill("Renamed request");
  await page.getByRole("dialog", { name: "Rename document" }).getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("region", { name: "HTTP", exact: true }).getByRole("button", { name: "GET Renamed request", exact: true })).toBeVisible();
});

test("response and workspace cookies survive persistence and the workspace folder opens natively", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Personal · Local workspace", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__commands.filter((command: string) => command === "open_project_folder").length)).toBe(1);

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

test("variables use explicit drafts, validate duplicate names without blocking typing, and toggle atomically", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open variables", exact: true }).click();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("button", { name: "Variable", exact: true }).click();
  await expect(page.getByLabel("Variable name", { exact: true })).toBeFocused();
  await page.getByLabel("Variable name", { exact: true }).fill("test");
  await page.getByLabel("Variable value", { exact: true }).fill("draft-only");
  await saved(page); await page.reload();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.getByText("draft-only", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Variable", exact: true }).click();
  await page.getByLabel("Variable name", { exact: true }).fill("test");
  await page.getByLabel("Variable value", { exact: true }).fill("persisted");
  await page.getByRole("button", { name: "Save variable", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel variable changes", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Variable", exact: true }).click();
  const name = page.getByLabel("Variable name", { exact: true });
  await name.fill("test");
  await expect(page.getByText("Variable “test” already exists.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save variable", exact: true })).toBeDisabled();
  await name.press("End"); await name.type("2");
  await expect(name).toHaveValue("test2");
  await expect(page.getByText("Variable “test” already exists.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel variable changes", exact: true }).click();

  await page.getByRole("checkbox", { name: "Enable test", exact: true }).click();
  await saved(page); await page.reload();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Enable test", exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Effective", exact: true }).click();
  await expect(page.getByText("test", { exact: true })).toHaveCount(0);
});

test("Static variables support the bottom quick row and a Dynamic form survives request navigation", async ({ page }) => {
  await page.goto("/");
  await saveDocument(page, "Source request");
  await page.getByRole("button", { name: "Open variables", exact: true }).click();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.getByText("Select a variable to inspect its definition and usage.", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Add static variable", exact: true }).click();
  await expect(page.getByLabel("New variable name", { exact: true })).toBeFocused();
  await page.getByLabel("New variable name", { exact: true }).fill("discard-with-escape");
  await page.getByLabel("New variable name", { exact: true }).press("Escape");
  await expect(page.getByLabel("New variable name", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Add static variable", exact: true }).click();
  await page.getByRole("button", { name: "Cancel static variable", exact: true }).click();
  await expect(page.getByLabel("New variable name", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Add static variable", exact: true }).click();
  await page.getByLabel("New variable name", { exact: true }).fill("inline_value");
  await page.getByLabel("New variable value", { exact: true }).fill("from-row");
  await page.getByRole("button", { name: "Save static variable", exact: true }).click();
  await expect(page.getByLabel("Variable name inline_value", { exact: true })).toHaveValue("inline_value");
  await expect(page.getByLabel("Variable value inline_value", { exact: true })).toHaveValue("from-row");

  await page.getByRole("button", { name: "Variable", exact: true }).click();
  await page.getByLabel("Variable name", { exact: true }).fill("dynamic_value");
  await page.getByRole("tab", { name: "Dynamic Request", exact: true }).click();
  await page.getByRole("combobox", { name: "Dynamic variable source request", exact: true }).click();
  await expect(page.getByRole("option", { name: "Source request", exact: true }).getByText("GET", { exact: true })).toBeVisible();
  await page.getByRole("option", { name: "Source request", exact: true }).click();
  await expect(page.getByRole("region", { name: "Source dependency request", exact: true }).getByText("GET", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Jump to request/ }).click();
  await expect(page.getByRole("tab", { name: /Source request/ })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Variables", exact: true }).click();
  await expect(page.getByLabel("Variable name", { exact: true })).toHaveValue("dynamic_value");
  await expect(page.getByRole("tab", { name: "Dynamic Request", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByLabel("Search variables", { exact: true }).click();
  await expect(page.getByLabel("Variable name", { exact: true })).toHaveCount(0);
});

test("Secret is independent of reveal; browser preview persists ciphertext and restores the environment", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Select environment" }).click();
  await page.getByRole("button", { name: "New environment", exact: true }).click();
  const environmentNameBox = await page.getByLabel("Environment name", { exact: true }).boundingBox();
  const addVariableBox = await page.getByRole("button", { name: "Variable", exact: true }).boundingBox();
  expect(addVariableBox?.height).toBe(environmentNameBox?.height);
  await page.getByLabel("Environment name", { exact: true }).fill("Secure staging");
  await page.getByRole("button", { name: "Variable", exact: true }).click();
  await page.getByLabel("Variable name", { exact: true }).fill("access_token");
  await page.getByLabel("Variable value", { exact: true }).fill("purr-test-secret-not-in-project");
  await page.getByRole("switch", { name: "Sensitive & masked secret", exact: true }).click();
  await expect(page.getByLabel("Variable value", { exact: true })).toHaveAttribute("type", "password");
  await expect(page.getByRole("switch", { name: "Sensitive & masked secret", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Save variable", exact: true }).click();
  await page.getByRole("button", { name: "Reveal value", exact: true }).click();
  await expect(page.getByLabel("Variable value", { exact: true })).toHaveAttribute("type", "text");
  await page.getByRole("tab", { name: "Variables", exact: true }).hover();
  await page.getByRole("button", { name: "Close variables", exact: true }).click();
  await saved(page); await page.reload();
  await expect(page.getByRole("button", { name: "Select environment" })).toContainText("Secure staging");
  const storage = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open("purr-preview-v2"); request.onsuccess = () => resolve(request.result); });
    const all = (name: string) => new Promise<any[]>((resolve) => { const request = db.transaction(name).objectStore(name).getAll(); request.onsuccess = () => resolve(request.result); });
    const projects = await all("projects"); const secrets = await all("secrets"); const keys = await all("keys"); db.close();
    return { leaked: JSON.stringify(projects).includes("purr-test-secret-not-in-project"), encrypted: secrets.length > 0 && secrets.every((entry) => entry.data instanceof ArrayBuffer && entry.iv instanceof Uint8Array), exportable: keys.some((key) => key.extractable), legacy: localStorage.getItem("purr.workspaces.v1") };
  });
  expect(storage).toEqual({ leaked: false, encrypted: true, exportable: false, legacy: null });
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
