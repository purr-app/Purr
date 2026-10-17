import { expect, test, type Page } from "@playwright/test";
import { installGitMock } from "../fixtures/git-mock";

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Source control", exact: true });
async function openGit(page: Page) { await page.getByRole("button", { name: "Source control", exact: true }).click(); return page.locator("#git-workspace-panel"); }
async function counts(page: Page) { return page.evaluate(() => {
  const calls = (window as any).__gitCalls;
  return { history: calls.filter((call: any) => call.args?.query?.type === "history").length, stashes: calls.filter((call: any) => call.args?.query?.type === "stashes").length };
}); }

for (const staged of [false, true]) test(`the whole ${staged ? "staged" : "working"} file row opens its diff, including text, edges and keyboard activation`, async ({ page }) => {
  await installGitMock(page); await page.goto("/"); const panel = await openGit(page), controls = sidebar(page);
  if (staged) await controls.getByRole("button", { name: "Stage all files", exact: true }).click();
  const file = controls.getByRole("button", { name: /Get user.*documents\/get-user.yaml/ }), row = file.locator("..");
  const points = ["left", "right", "top", "bottom", "name", "description", "status", "keyboard"] as const;
  for (const point of points) {
    await controls.getByRole("button", { name: "Commits", exact: true }).click();
    await expect(panel.getByRole("tab", { name: "Semantic", exact: true })).toHaveCount(0);
    if (point === "name" || point === "description") await file.locator("span").nth(point === "name" ? 0 : 1).click();
    else if (point === "status") await row.locator(":scope > span").click();
    else if (point === "keyboard") { await file.focus(); await page.keyboard.press("Enter"); }
    else {
      const box = await row.boundingBox(); expect(box).not.toBeNull();
      await row.click({ position: { x: point === "left" ? 1 : point === "right" ? box!.width - 1 : box!.width / 2, y: point === "top" ? 1 : point === "bottom" ? box!.height - 1 : box!.height / 2 } });
    }
    await expect(panel.getByRole("tab", { name: "Semantic", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__gitCalls.filter((call: any) => call.args?.query?.type === "diff").at(-1)?.args.query.request.scope)).toBe(staged ? "staged" : "working");
  }
});

test("file row actions do not also navigate to its diff", async ({ page }) => {
  await installGitMock(page); await page.goto("/"); const panel = await openGit(page), controls = sidebar(page);
  const file = controls.getByRole("button", { name: /Get user.*documents\/get-user.yaml/ });
  await file.hover(); await controls.getByRole("button", { name: "Stage Get user", exact: true }).click();
  await file.hover(); await controls.getByRole("button", { name: "Unstage Get user", exact: true }).click();
  await file.hover(); await controls.getByRole("button", { name: "Discard Get user changes", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Discard saved changes" }); await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(panel.getByRole("tab", { name: "Semantic", exact: true })).toHaveCount(0);
  await file.hover(); await controls.getByRole("button", { name: "Open Get user document", exact: true }).click();
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("https://api.example.test/users/123");
  expect(await page.evaluate(() => (window as any).__gitCalls.filter((call: any) => call.args?.query?.type === "diff").length)).toBe(0);
});

test("a confirmed commit appears in history before workspace reconciliation completes", async ({ page }) => {
  await installGitMock(page, { reloadDelayMs: 1800 }); await page.goto("/"); const panel = await openGit(page);
  await sidebar(page).getByRole("button", { name: "Commits", exact: true }).click(); await expect(panel).toContainText("Add user endpoint");
  await sidebar(page).getByRole("button", { name: "Stage all files", exact: true }).click();
  await sidebar(page).getByRole("textbox", { name: "Commit message" }).fill("Visible immediately");
  await sidebar(page).getByRole("button", { name: "Commit", exact: true }).click();
  await expect(panel).toContainText("Visible immediately", { timeout: 1000 });
  await expect(sidebar(page).getByRole("status")).toBeVisible();
});

test("confirmed empty stashes stay visible without list reads or loading flashes during stage and unstage", async ({ page }) => {
  await installGitMock(page, { stageDelayMs: 500 }); await page.goto("/"); const panel = await openGit(page);
  await sidebar(page).getByRole("button", { name: "Stashes", exact: true }).click(); await expect(panel.getByText("No stashes.", { exact: true })).toBeVisible();
  const before = await counts(page);
  await panel.evaluate((node) => { (window as any).__stashLoadingFlashes = []; new MutationObserver(() => { if (node.textContent?.includes("Loading stashes")) (window as any).__stashLoadingFlashes.push(node.textContent); }).observe(node, { subtree: true, childList: true, characterData: true }); });
  await sidebar(page).getByRole("button", { name: "Stage all files", exact: true }).click();
  await expect(sidebar(page).getByRole("region", { name: "Staged changes", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__gitStatus.files[0].index)).toBe("M");
  await page.evaluate(() => (window as any).__purrEmitNativeEvent("git-state-changed", { workspaceId: "git-fixture", stashesChanged: false }));
  await sidebar(page).getByRole("button", { name: "Unstage all files", exact: true }).click();
  await expect(sidebar(page).getByRole("region", { name: "Staged changes", exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__gitStatus.files[0].index)).toBe(".");
  await expect(panel.getByText("No stashes.", { exact: true })).toBeVisible();
  expect(await counts(page)).toEqual(before); expect(await page.evaluate(() => (window as any).__stashLoadingFlashes)).toEqual([]);
});

test("commits are prefetched outside Git and retained across Git and document navigation", async ({ page }) => {
  await installGitMock(page); await page.goto("/");
  await expect.poll(() => page.evaluate(() => (window as any).__gitListResponses?.some((reply: any) => reply.type === "history"))).toBe(true);
  const before = await counts(page), panel = await openGit(page);
  await sidebar(page).getByRole("button", { name: "Commits", exact: true }).click(); await expect(panel).toContainText("Add user endpoint");
  await page.getByRole("button", { name: "Documents", exact: true }).click(); await openGit(page);
  await sidebar(page).getByRole("button", { name: "Commits", exact: true }).click(); await expect(panel).toContainText("Add user endpoint");
  expect(await counts(page)).toEqual(before);
});

test("a slow background stash read survives index publications without restarting", async ({ page }) => {
  await installGitMock(page); await page.goto("/"); const panel = await openGit(page);
  await sidebar(page).getByRole("button", { name: "Stashes", exact: true }).click(); await expect(panel.getByText("No stashes.", { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__gitListDelayMs = 600; });
  await sidebar(page).getByRole("button", { name: "Refresh Git", exact: true }).click();
  await expect.poll(async () => (await counts(page)).stashes).toBe(2);
  const before = await counts(page);
  await sidebar(page).getByRole("button", { name: "Stage all files", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__gitStatus.files[0].index)).toBe("M");
  await expect.poll(() => page.evaluate(() => (window as any).__gitListResponses.filter((reply: any) => reply.type === "stashes").length)).toBe(2);
  expect(await counts(page)).toEqual(before); await expect(panel.getByText("No stashes.", { exact: true })).toBeVisible();
});

test("external stash changes revalidate in place and do not flash a loading empty state", async ({ page }) => {
  await installGitMock(page); await page.goto("/"); const panel = await openGit(page);
  await sidebar(page).getByRole("button", { name: "Stashes", exact: true }).click(); await expect(panel.getByText("No stashes.", { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__gitListDelayMs = 300; (window as any).__gitStashes.push({ id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", message: "External stash" }); (window as any).__purrEmitNativeEvent("git-state-changed", { workspaceId: "git-fixture", stashesChanged: true }); });
  await expect(panel.getByText("Loading stashes…", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Apply", exact: true })).toBeVisible(); await expect(panel).toContainText("External stash");
});

test("late history from the previous HEAD cannot replace the current branch commits", async ({ page }) => {
  await installGitMock(page, { branchStash: true, holdHistory: true }); await page.goto("/"); const panel = await openGit(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__gitReleaseHistory)).toBe("function");
  await sidebar(page).getByRole("button", { name: "Commits", exact: true }).click();
  await sidebar(page).getByRole("button", { name: "Select Git branch", exact: true }).click(); await page.getByRole("button", { name: "feature/team", exact: true }).click();
  await page.getByRole("dialog", { name: "Uncommitted changes" }).getByRole("button", { name: "Stash and continue", exact: true }).click();
  await expect(panel).toContainText("Test branch commit");
  await page.evaluate(() => { (window as any).__gitReleaseHistory(); });
  await expect.poll(() => page.evaluate(() => (window as any).__gitListResponses?.filter((reply: any) => reply.type === "history").length)).toBe(2);
  await expect(panel).not.toContainText("Add user endpoint");
});

test("a busy metadata read is retried on the next confirmed status without clearing existing stashes", async ({ page }) => {
  await installGitMock(page); await page.goto("/"); const panel = await openGit(page);
  await sidebar(page).getByRole("button", { name: "Stashes", exact: true }).click(); await expect(panel.getByText("No stashes.", { exact: true })).toBeVisible();
  const before = await counts(page);
  await page.evaluate(() => { (window as any).__gitListBusy = "stashes"; (window as any).__gitStashes.push({ id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", message: "Preserved stash" }); (window as any).__purrEmitNativeEvent("git-state-changed", { workspaceId: "git-fixture", stashesChanged: true }); });
  await expect.poll(async () => (await counts(page)).stashes).toBeGreaterThan(before.stashes);
  await sidebar(page).getByRole("button", { name: "Stage all files", exact: true }).click();
  await expect(panel).toContainText("Preserved stash"); await expect(sidebar(page).getByRole("alert")).toHaveCount(0);
});

test("the commit dropdown chevron keeps a readable size and matches the commit control height", async ({ page }) => {
  await installGitMock(page); await page.goto("/"); await openGit(page);
  const menu = sidebar(page).getByRole("button", { name: "More commit actions", exact: true }), commit = sidebar(page).getByRole("button", { name: "Commit", exact: true });
  const icon = await menu.locator("svg").boundingBox(); expect(icon!.width).toBeGreaterThanOrEqual(20); expect(icon!.height).toBeGreaterThanOrEqual(20);
  expect((await menu.boundingBox())!.height).toBe((await commit.boundingBox())!.height);
  await page.screenshot({ path: test.info().outputPath("commit-dropdown.png") });
});

test("saving query parameters writes a base YAML URL and keeps the editor URL after reopening", async ({ page }) => {
  await installGitMock(page); await page.goto("/");
  const url = page.getByRole("textbox", { name: "Request URL", exact: true }); await url.fill("https://api.example.test/users?tag=one&tag=two#results"); await url.blur();
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  const files = () => page.evaluate(() => JSON.parse(localStorage.getItem("purr-native-persistence-test")!).workspaces[0].files["documents/get-user.yaml"].content as string);
  await expect.poll(files).toContain("name: tag");
  expect(await files()).toMatch(/^url: https:\/\/api\.example\.test\/users#results$/m);
  expect((await files()).match(/name: tag/g)).toHaveLength(2);
  await page.reload(); await expect(url).toHaveValue("https://api.example.test/users?tag=one&tag=two#results");
});
