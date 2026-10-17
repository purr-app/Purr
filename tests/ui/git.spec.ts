import { expect, test, type Page } from "@playwright/test";
import { installGitMock } from "../fixtures/git-mock";
async function sourceControl(page: Page) { await page.getByRole("button", { name: "Source control", exact: true }).click(); await expect(page.getByRole("region", { name: "Git workspace", exact: true })).toBeVisible(); await expect(page.getByRole("tab", { name: "Source control", exact: true })).toHaveCount(0); return page.getByRole("complementary", { name: "Source control", exact: true }); }
async function importDialog(page: Page) { await page.getByRole("button", { name: "Select workspace", exact: true }).click(); await page.getByRole("button", { name: "New workspace", exact: true }).hover(); await page.getByRole("menuitem", { name: "Import", exact: true }).click(); return page.getByRole("dialog", { name: "Import workspace" }); }

test("rail opens semantic and exact YAML diff; button staging commits only selected files", async ({ page }) => {
  await installGitMock(page); await page.goto("/"); const sidebar = await sourceControl(page);
  await expect(sidebar.getByRole("button", { name: "Sync 1 ahead 2 behind" })).toBeVisible();
  await sidebar.getByRole("button", { name: /Get user.*documents\/get-user.yaml/ }).click();
  const panel = page.locator("#git-workspace-panel"); await expect(panel.getByRole("tab", { name: "Semantic", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(panel).toContainText("https://api.example.test/users/123"); await expect(panel).toContainText("X-Debug"); await expect(panel).toContainText("Disabled");
  await panel.getByRole("tab", { name: "YAML", exact: true }).click(); await expect(panel.locator(".cm-mergeView")).toBeVisible(); await expect(panel.locator(".cm-editor")).toHaveCount(2);
  await sidebar.getByRole("button", { name: "Stage all files", exact: true }).click(); await expect(sidebar.getByRole("region", { name: "Staged changes", exact: true })).toContainText("Get user");
  await sidebar.getByRole("textbox", { name: "Commit message" }).fill("Update user endpoint"); await sidebar.getByRole("button", { name: "Commit", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "Unstage Get user", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__gitCalls.some((call: any) => call.args?.query?.action?.type === "commit" && call.args.query.action.message === "Update user endpoint"))).toBe(true);
  await page.getByRole("button", { name: "Documents", exact: true }).click(); await page.getByRole("tab", { name: /Get user/ }).click(); await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("https://api.example.test/users/123");
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
  await sidebar.getByRole("button", { name: "Stage all files", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "Stage Get user", exact: true })).toHaveCount(0);
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
  await panel.getByRole("button", { name: "Finish operation" }).click(); await expect(panel).toContainText("Recent commits");
});

test("new workspace chooses a project directory and optionally initializes Git", async ({ page }) => {
  await installGitMock(page); await page.goto("/"); await page.getByRole("button", { name: "Select workspace", exact: true }).click(); await page.getByRole("button", { name: "New workspace", exact: true }).hover(); await page.getByRole("menuitem", { name: "New empty", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New workspace", exact: true }); await dialog.getByRole("textbox", { name: "Workspace name" }).fill("Team API"); await dialog.getByRole("button", { name: "Choose project directory" }).click(); await expect(dialog.getByRole("textbox", { name: "Project directory", exact: true })).toHaveCount(0); const fieldBox = await dialog.getByLabel("Project directory", { exact: true }).boundingBox(); const pickerBox = await dialog.getByRole("button", { name: "Choose project directory" }).boundingBox(); expect(fieldBox!.height).toBe(pickerBox!.height); await dialog.getByRole("checkbox", { name: "Initialize Git" }).click(); await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByRole("button", { name: "Select workspace", exact: true })).toContainText("Team API");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("purr-native-persistence-test")!).workspaces.some((workspace: any) => workspace.directory === "/projects/chosen"))).toBe(true);
});

test("import accepts a Git URL and rejects invalid repositories without replacing the workspace", async ({ page }) => {
  await installGitMock(page, { cloneError: true }); await page.goto("/"); const dialog = await importDialog(page);
  await expect(dialog).not.toContainText("Postman Collection"); await dialog.getByRole("textbox", { name: "Path or URL", exact: true }).fill("https://example.test/team/api.git"); await expect(dialog.getByRole("tab")).toHaveCount(0); await expect(dialog.getByLabel("Project directory", { exact: true })).toContainText("/projects");
  await dialog.getByRole("button", { name: "Clone", exact: true }).click(); await expect(dialog.getByRole("alert")).toContainText("not a valid Purr workspace"); await expect(page.getByRole("button", { name: "Select workspace", exact: true })).toContainText("API project");
});

test("Git panels remain usable in a narrow window and use Purr tokens", async ({ page }) => {
  await installGitMock(page); await page.setViewportSize({ width: 980, height: 680 }); await page.goto("/"); const sidebar = await sourceControl(page);
  await sidebar.getByRole("button", { name: /Get user.*documents\/get-user.yaml/ }).click(); await expect(page.locator("#git-workspace-panel")).toContainText("Before");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("git-semantic.png") });
});

test("cloning opens a separate workspace and keeps the existing one intact", async ({ page }) => {
  await installGitMock(page); await page.goto("/"); const dialog = await importDialog(page);
  await dialog.getByRole("textbox", { name: "Path or URL", exact: true }).fill("git@example.test:team/project.git"); await dialog.getByRole("button", { name: "Clone", exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByRole("button", { name: "Select workspace", exact: true })).toContainText("Cloned API");
  expect(await page.evaluate(() => (window as any).__gitCalls.find((call: any) => call.command === "git_clone")?.args.directory)).toBe("");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("purr-native-persistence-test")!).workspaces.some((workspace: any) => workspace.id === "git-fixture"))).toBe(true);
});

test("incoming changes preserve local editors until an explicit review choice", async ({ page }) => {
  await installGitMock(page, { editorConflict: true }); await page.goto("/"); await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("https://api.example.test/users/local");
  await page.getByRole("button", { name: "Review changes", exact: true }).click(); const panel = page.locator("#git-workspace-panel"); await expect(panel.getByRole("heading", { name: "Local editor changed on disk" })).toBeVisible(); await expect(panel).toContainText("https://api.example.test/users/local");
  await panel.getByRole("tab", { name: "Base → Incoming", exact: true }).click(); await expect(panel).toContainText("https://api.example.test/users/incoming"); await panel.getByRole("button", { name: "Keep local edits", exact: true }).click();
  await page.getByRole("button", { name: "Documents", exact: true }).click(); await page.getByRole("tab", { name: /GET Get user/ }).click(); await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("https://api.example.test/users/local");
  const content = await page.evaluate(() => JSON.parse(localStorage.getItem("purr-native-persistence-test")!).workspaces.find((workspace: any) => workspace.id === "git-fixture").files["documents/get-user.yaml"].content);
  expect(content).toContain("/users/incoming"); expect(content).not.toContain("/users/local");
});

test("workspace settings exposes project relocation with a directory picker", async ({ page }) => {
  await installGitMock(page); await page.goto("/"); await page.getByRole("button", { name: "Select workspace", exact: true }).click(); await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  await page.getByRole("button", { name: "Move project…", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "Move project", exact: true });
  await dialog.getByRole("button", { name: "Choose project directory", exact: true }).click(); await dialog.getByRole("button", { name: "Move project", exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByRole("tabpanel", { name: "Workspace settings", exact: true })).toContainText("/projects/chosen");
});

test("Git overview replaces the document empty state and has no document tabs", async ({ page }) => {
  await installGitMock(page, { noTabs: true }); await page.goto("/"); const sidebar = await sourceControl(page);
  const panel = page.getByRole("region", { name: "Git workspace" });
  await expect(panel).toContainText("Recent commits"); await expect(page.getByText("Nothing is open", { exact: true })).toBeHidden();
  await expect(page.getByRole("tablist", { name: "Open documents" })).toHaveCount(0);
  await expect(sidebar.getByRole("region", { name: "Staged changes" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Source control", exact: true })).toHaveCount(1);
  await expect(sidebar.getByRole("button", { name: "/projects/api", exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("git-overview.png") });
});

test("one branch input searches and creates, with the popover matching the selector width", async ({ page }) => {
  await installGitMock(page); await page.goto("/"); const sidebar = await sourceControl(page);
  const selector = sidebar.getByRole("button", { name: "Select Git branch" }); await selector.click();
  const search = page.getByRole("textbox", { name: "Search Git branches" });
  await expect(page.getByRole("button", { name: "main Current", exact: true })).toBeVisible();
  const popover = search.locator("xpath=../..");
  const triggerBox = await selector.boundingBox(); const menuBox = await popover.boundingBox();
  expect(Math.abs(menuBox!.width - triggerBox!.width)).toBeLessThanOrEqual(1);
  await search.fill("new-feature"); await expect(page.getByRole("button", { name: "Create “new-feature” branch" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("git-branch-create.png") });
  await page.getByRole("button", { name: "Create “new-feature” branch" }).click(); await expect(selector).toContainText("new-feature");
  await selector.click(); await page.getByRole("textbox", { name: "Search Git branches" }).fill("main"); await expect(page.getByRole("button", { name: "main", exact: true })).toBeVisible();
});

test("staging reacts before native completion and queues an immediate unstage without locking the message", async ({ page }) => {
  await installGitMock(page, { stageDelayMs: 1000 }); await page.goto("/"); const sidebar = await sourceControl(page);
  await sidebar.getByRole("button", { name: "Stage all files", exact: true }).click();
  await expect(sidebar.getByRole("region", { name: "Staged changes" })).toContainText("Get user", { timeout: 300 });
  const message = sidebar.getByRole("textbox", { name: "Commit message" }); await expect(message).toBeEnabled(); await message.fill("Still typing");
  await sidebar.getByRole("button", { name: "Unstage all files", exact: true }).click();
  await expect(sidebar.getByRole("region", { name: "Staged changes" })).toHaveCount(0, { timeout: 300 });
  await expect.poll(() => page.evaluate(() => (window as any).__gitCalls.filter((call: any) => ["stage", "unstage"].includes(call.args?.query?.action?.type)).map((call: any) => call.args.query.action.type))).toEqual(["stage", "unstage"]);
  await expect.poll(() => page.evaluate(() => (window as any).__gitStatus.files[0].index)).toBe(".");
  await expect(message).toHaveValue("Still typing");
});

test("failed staging restores the confirmed index and keeps controls usable", async ({ page }) => {
  await installGitMock(page, { stageDelayMs: 250, stageError: true }); await page.goto("/"); const sidebar = await sourceControl(page);
  await sidebar.getByRole("button", { name: "Stage all files", exact: true }).click();
  await expect(sidebar.getByRole("region", { name: "Staged changes" })).toBeVisible();
  await expect(sidebar.getByRole("alert")).toContainText("Could not update the Git index");
  await expect(sidebar.getByRole("region", { name: "Staged changes" })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: "Stage all files", exact: true })).toBeEnabled();
});

test("new files show their content without an empty Before comparison", async ({ page }) => {
  await installGitMock(page, { newFile: true }); await page.goto("/"); const sidebar = await sourceControl(page);
  await sidebar.getByRole("button", { name: /Get user.*documents\/get-user.yaml/ }).click(); const panel = page.locator("#git-workspace-panel");
  await expect(panel).toContainText("New file"); await expect(panel).not.toContainText("Before"); await expect(panel).not.toContainText("After");
  await expect(panel).toContainText("https://api.example.test/users/123"); await panel.getByRole("tab", { name: "YAML", exact: true }).click();
  await expect(panel.locator(".cm-editor")).toHaveCount(1); await page.screenshot({ path: test.info().outputPath("git-new-file.png") });
});

test("row hover opens the owning document and commit controls have equal heights", async ({ page }) => {
  await installGitMock(page); await page.goto("/"); const sidebar = await sourceControl(page);
  const commitBox = await sidebar.getByRole("button", { name: "Commit", exact: true }).boundingBox(); const menuBox = await sidebar.getByRole("button", { name: "More commit actions" }).boundingBox();
  expect(commitBox!.height).toBe(menuBox!.height);
  await sidebar.getByRole("button", { name: /Get user.*documents\/get-user.yaml/ }).hover();
  await sidebar.getByRole("button", { name: "Open Get user document" }).click();
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("https://api.example.test/users/123");
  await expect(page.locator("#git-workspace-panel")).toHaveCount(0);
});

test("stash creation lives in the commit menu and the stash page is for applying", async ({ page }) => {
  await installGitMock(page); await page.goto("/"); const sidebar = await sourceControl(page);
  await sidebar.getByRole("textbox", { name: "Commit message" }).fill("Before refactor");
  await sidebar.getByRole("button", { name: "More commit actions" }).click(); await page.getByRole("button", { name: "Stash changes", exact: true }).click();
  const panel = page.locator("#git-workspace-panel"); await expect(panel).toContainText("Before refactor");
  await expect(panel.getByRole("textbox", { name: "Stash message" })).toHaveCount(0); await panel.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(panel).toContainText("No stashes.");
});

test("a pending stash can finish without a save or a false vault-recovery warning", async ({ page }) => {
  await installGitMock(page, { recovery: true }); await page.goto("/"); const sidebar = await sourceControl(page);
  await expect(page.getByRole("button", { name: "Required local secrets", exact: true })).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Review pending operation", exact: true }).click(); const panel = page.locator("#git-workspace-panel");
  await expect(panel.getByRole("heading", { name: "Review pending operation" })).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "Merge commit message" })).toHaveCount(0);
  await panel.getByRole("button", { name: "Finish operation", exact: true }).click(); await expect(panel).toContainText("Recent commits");
  await page.getByRole("button", { name: "Documents", exact: true }).click(); await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});

test("discard actions require a concrete file confirmation", async ({ page }) => {
  await installGitMock(page); await page.goto("/"); const sidebar = await sourceControl(page);
  await sidebar.getByRole("button", { name: "Discard all changes", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Discard saved changes" }); await expect(dialog).toContainText("Get user");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); await expect(sidebar).toContainText("Get user");
  await sidebar.getByRole("button", { name: "Discard all changes", exact: true }).click(); await dialog.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(sidebar.getByRole("region", { name: "Changes", exact: true })).toContainText("No changes");
});
