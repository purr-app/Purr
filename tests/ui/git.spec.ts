import { expect, test, type Page } from "@playwright/test";
import { installGitMock } from "../fixtures/git-mock";
async function sourceControl(page: Page) { await page.getByRole("button", { name: "Source control", exact: true }).click(); await expect(page.getByRole("tab", { name: "Source control", exact: true })).toBeVisible(); return page.getByRole("complementary", { name: "Source control", exact: true }); }
async function importDialog(page: Page) { await page.getByRole("button", { name: "Select workspace", exact: true }).click(); await page.getByRole("button", { name: "New workspace", exact: true }).hover(); await page.getByRole("menuitem", { name: "Import", exact: true }).click(); return page.getByRole("dialog", { name: "Import workspace" }); }

test("rail opens semantic and exact YAML diff; checkbox staging commits only selected files", async ({ page }) => {
  await installGitMock(page); await page.goto("/"); const sidebar = await sourceControl(page);
  await expect(sidebar.getByRole("button", { name: "Sync 1 ahead 2 behind" })).toBeVisible();
  await sidebar.getByRole("button", { name: /Get user.*documents\/get-user.yaml/ }).click();
  const panel = page.locator("#git-workspace-panel"); await expect(panel.getByRole("tab", { name: "Semantic", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(panel).toContainText("https://api.example.test/users/123"); await expect(panel).toContainText("X-Debug"); await expect(panel).toContainText("Disabled");
  await panel.getByRole("tab", { name: "YAML", exact: true }).click(); await expect(panel.locator(".cm-mergeView")).toBeVisible(); await expect(panel.locator(".cm-editor")).toHaveCount(2);
  await sidebar.getByRole("checkbox", { name: "Stage Get user", exact: true }).click(); await expect(sidebar.getByRole("checkbox", { name: "Unstage Get user", exact: true })).toHaveAttribute("aria-checked", "true");
  await sidebar.getByRole("textbox", { name: "Commit message" }).fill("Update user endpoint"); await sidebar.getByRole("button", { name: "Commit", exact: true }).click();
  await expect(sidebar.getByRole("checkbox", { name: "Unstage Get user", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__gitCalls.some((call: any) => call.args?.query?.action?.type === "commit" && call.args.query.action.message === "Update user endpoint"))).toBe(true);
  await page.getByRole("tab", { name: /Get user/ }).click(); await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("https://api.example.test/users/123");
});

test("switch offers stash and keeps the stash on the original branch", async ({ page }) => {
  await installGitMock(page); await page.goto("/"); const sidebar = await sourceControl(page);
  await sidebar.getByRole("button", { name: "Select Git branch" }).click(); await page.getByRole("button", { name: "feature/team", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Uncommitted changes" }); await expect(dialog).toBeVisible(); await dialog.getByRole("button", { name: "Stash and continue" }).click();
  await expect(sidebar.getByRole("button", { name: "Select Git branch" })).toContainText("feature/team");
  await sidebar.getByRole("button", { name: "Stashes", exact: true }).click(); await expect(page.locator("#git-workspace-panel")).toContainText("Purr [main]");
  expect(await page.evaluate(() => (window as any).__gitCalls.filter((call: any) => call.args?.query?.action?.type === "applyStash").length)).toBe(0);
});

test("staging later edits to an indexed rename includes only its current path", async ({ page }) => {
  await installGitMock(page); await page.goto("/");
  await page.evaluate(() => { const file = (window as any).__gitStatus.files[0]; file.index = "R"; file.worktree = "M"; file.oldPath = "documents/original.yaml"; });
  const sidebar = await sourceControl(page); await sidebar.getByRole("button", { name: "Refresh Git" }).click();
  await sidebar.getByRole("checkbox", { name: "Stage Get user", exact: true }).click();
  await expect(sidebar.getByRole("checkbox", { name: "Stage Get user", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__gitCalls.find((call: any) => call.args?.query?.action?.type === "stage")?.args.query.action.paths)).toEqual(["documents/get-user.yaml"]);
});

test("merge conflicts provide source/result editing and finish after resolution", async ({ page }) => {
  await installGitMock(page, { conflicts: true }); await page.goto("/"); const sidebar = await sourceControl(page);
  await sidebar.getByRole("button", { name: "Pull", exact: true }).click(); await page.getByRole("dialog", { name: "Uncommitted changes" }).getByRole("button", { name: "Continue safely" }).click();
  const panel = page.locator("#git-workspace-panel"); await expect(panel.getByRole("heading", { name: "Resolve conflicts" })).toBeVisible();
  await expect(panel.getByRole("tab", { name: "Base", exact: true })).toBeVisible(); await expect(panel.locator(".cm-editor")).toHaveCount(2);
  await panel.getByRole("button", { name: "Use incoming file" }).click();
  const result = panel.locator(".cm-content[contenteditable=true]"); await expect(result).toContainText("/incoming");
  await result.click(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.type("invalid: ["); await panel.getByRole("button", { name: "Mark resolved" }).click();
  await expect(panel.getByRole("alert")).toContainText("Invalid"); await expect(result).toBeVisible();
  await panel.getByRole("button", { name: "Use incoming file" }).click(); await expect(result).toContainText("/incoming");
  await result.click(); await page.keyboard.press("ControlOrMeta+End"); await page.keyboard.type("\n# reviewed"); await expect(result).toBeFocused(); await expect(result).toContainText("# reviewed");
  await panel.getByRole("button", { name: "Mark resolved" }).click();
  expect(await page.evaluate(() => (window as any).__gitCalls.find((call: any) => call.args?.query?.action?.type === "resolveConflict")?.args.query.action.content)).toContain("# reviewed");
  await panel.getByRole("button", { name: "Finish operation" }).click(); await expect(panel.getByRole("heading", { name: "Source control", exact: true })).toBeVisible();
});

test("new workspace chooses a project directory and optionally initializes Git", async ({ page }) => {
  await installGitMock(page); await page.goto("/"); await page.getByRole("button", { name: "Select workspace", exact: true }).click(); await page.getByRole("button", { name: "New workspace", exact: true }).hover(); await page.getByRole("menuitem", { name: "New empty", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New workspace", exact: true }); await dialog.getByRole("textbox", { name: "Workspace name" }).fill("Team API"); await dialog.getByRole("textbox", { name: "Project directory" }).fill("/projects/team-api"); await dialog.getByRole("checkbox", { name: "Initialize Git" }).click(); await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByRole("button", { name: "Select workspace", exact: true })).toContainText("Team API");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("purr-native-persistence-test")!).workspaces.some((workspace: any) => workspace.directory === "/projects/team-api"))).toBe(true);
});

test("import accepts a Git URL and rejects invalid repositories without replacing the workspace", async ({ page }) => {
  await installGitMock(page, { cloneError: true }); await page.goto("/"); const dialog = await importDialog(page);
  await expect(dialog).not.toContainText("Postman Collection"); await dialog.getByRole("textbox", { name: "Path or URL", exact: true }).fill("https://example.test/team/api.git"); await expect(dialog.getByRole("tab", { name: "Git repository", exact: true })).toHaveAttribute("aria-selected", "true");
  await dialog.getByRole("textbox", { name: "Project directory", exact: true }).fill("/projects/clone"); await dialog.getByRole("button", { name: "Clone", exact: true }).click(); await expect(dialog.getByRole("alert")).toContainText("not a valid Purr workspace"); await expect(page.getByRole("button", { name: "Select workspace", exact: true })).toContainText("API project");
});

test("Git panels remain usable in a narrow window and use Purr tokens", async ({ page }) => {
  await installGitMock(page); await page.setViewportSize({ width: 980, height: 680 }); await page.goto("/"); const sidebar = await sourceControl(page);
  await sidebar.getByRole("button", { name: /Get user.*documents\/get-user.yaml/ }).click(); await expect(page.locator("#git-workspace-panel")).toContainText("Before");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("git-semantic.png") });
});

test("cloning opens a separate workspace and keeps the existing one intact", async ({ page }) => {
  await installGitMock(page); await page.goto("/"); const dialog = await importDialog(page);
  await dialog.getByRole("tab", { name: "Git repository", exact: true }).click(); await dialog.getByRole("textbox", { name: "Repository URL", exact: true }).fill("git@example.test:team/project.git"); await dialog.getByRole("textbox", { name: "Project directory", exact: true }).fill("/projects/cloned"); await dialog.getByRole("button", { name: "Clone", exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByRole("button", { name: "Select workspace", exact: true })).toContainText("Cloned API");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("purr-native-persistence-test")!).workspaces.some((workspace: any) => workspace.id === "git-fixture"))).toBe(true);
});

test("incoming changes preserve local editors until an explicit review choice", async ({ page }) => {
  await installGitMock(page, { editorConflict: true }); await page.goto("/"); await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("https://api.example.test/users/local");
  await page.getByRole("button", { name: "Review changes", exact: true }).click(); const panel = page.locator("#git-workspace-panel"); await expect(panel.getByRole("heading", { name: "Local editor changed on disk" })).toBeVisible(); await expect(panel).toContainText("https://api.example.test/users/local");
  await panel.getByRole("tab", { name: "Base → Incoming", exact: true }).click(); await expect(panel).toContainText("https://api.example.test/users/incoming"); await panel.getByRole("button", { name: "Keep local edits", exact: true }).click();
  await page.getByRole("tab", { name: /GET Get user/ }).click(); await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("https://api.example.test/users/local");
  const content = await page.evaluate(() => JSON.parse(localStorage.getItem("purr-native-persistence-test")!).workspaces.find((workspace: any) => workspace.id === "git-fixture").files["documents/get-user.yaml"].content);
  expect(content).toContain("/users/incoming"); expect(content).not.toContain("/users/local");
});

test("workspace settings exposes project relocation with a directory picker", async ({ page }) => {
  await installGitMock(page); await page.goto("/"); await page.getByRole("button", { name: "Select workspace", exact: true }).click(); await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  await page.getByRole("button", { name: "Move project…", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "Move project", exact: true });
  await dialog.getByRole("textbox", { name: "Project directory", exact: true }).fill("/projects/moved-api"); await dialog.getByRole("button", { name: "Move project", exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByRole("tabpanel", { name: "Workspace settings", exact: true })).toContainText("/projects/moved-api");
});
