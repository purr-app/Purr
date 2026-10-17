import { expect, test, type Page } from "@playwright/test";
import type { GitStatus } from "../../src/application/ports/git";
import { installGitMock } from "../fixtures/git-mock";
import { deletedSchema, largeNewSchema, type SemanticPreview } from "../fixtures/semantic-git";

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Source control", exact: true });
async function openGit(page: Page, scene?: SemanticPreview) {
  await installGitMock(page, { preview: scene, newFile: scene?.before === "" }); await page.goto("/");
  await page.getByRole("button", { name: "Source control", exact: true }).click();
  if (scene) await sidebar(page).getByRole("button", { name: new RegExp(scene.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  return page.locator("#git-workspace-panel");
}
async function updateStatus(page: Page, change: Partial<GitStatus>) {
  await page.evaluate((change) => Object.assign((window as unknown as { __gitStatus: GitStatus }).__gitStatus, change), change);
  await sidebar(page).getByRole("button", { name: "Refresh Git", exact: true }).click();
}
function contrast(foreground: string, background: string) {
  const luminance = (hex: string) => hex.replace("#", "").match(/../g)!.map((part) => parseInt(part, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  return (luminance(foreground) + 0.05) / (luminance(background) + 0.05);
}

test("readable text roles retain AA contrast and a distinct disabled hierarchy", async ({ page }) => {
  const panel = await openGit(page);
  await updateStatus(page, { files: [
    { path: "documents/get-user.yaml", index: ".", worktree: "M", conflicted: false },
    { path: "purr.yaml", index: ".", worktree: "M", conflicted: false },
    { path: "schemas/catalog.graphql", index: "?", worktree: "?", conflicted: false },
  ] });
  for (const description of ["HTTP request", "Workspace settings", "GraphQL SDL"]) await expect(sidebar(page).getByText(description, { exact: true })).toBeVisible();
  const palette = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(["content-primary", "content-secondary", "content-tertiary", "content-disabled", "purr-base", "purr-surface", "purr-elevated", "purr-highlight"].map((name) => [name, style.getPropertyValue(`--${name}`).trim()]));
  });
  for (const background of ["purr-base", "purr-surface", "purr-elevated", "purr-highlight"]) {
    expect(contrast(palette["content-secondary"], palette[background])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette["content-tertiary"], palette[background])).toBeGreaterThanOrEqual(4.5);
  }
  const levels = ["content-primary", "content-secondary", "content-tertiary", "content-disabled"].map((name) => contrast(palette[name], palette["purr-elevated"]));
  expect(levels).toEqual([...levels].sort((a, b) => b - a)); expect(levels[3]).toBeGreaterThan(3);
  await expect(panel).toContainText("Purr fixture"); await expect(panel).toContainText("aaaaaaa");
  await page.screenshot({ path: test.info().outputPath("source-control-hierarchy.png") });
});

test("clean local-only repositories keep unavailable actions recognizable with state-specific explanations", async ({ page }) => {
  const panel = await openGit(page);
  await updateStatus(page, { files: [], remotes: [], upstream: null, ahead: 0, behind: 0 });
  await expect(panel).toContainText("Working tree clean"); await expect(panel).toContainText("Local repository");
  const descriptions = [
    ["Fetch", "Add a remote to fetch."], ["Sync 0 ahead 0 behind", "Set an upstream branch to sync."],
    ["Commit", "Stage changes to commit."], ["Pull", "Add a remote to pull."], ["Push", "Add a remote to push."],
  ];
  const colors: string[] = [];
  for (const [name, description] of descriptions) {
    const button = sidebar(page).getByRole("button", { name, exact: true });
    await expect(button).toBeDisabled(); await expect(button.locator("..")).toHaveAttribute("title", description);
    await expect(button).toHaveAttribute("aria-description", new RegExp(description));
    await expect.poll(() => button.evaluate((node) => getComputedStyle(node).color === getComputedStyle(node.querySelector("svg")!).color)).toBe(true);
    const styles = await button.evaluate((node) => { const style = getComputedStyle(node); return { color: style.color, opacity: style.opacity, pointerEvents: style.pointerEvents, icon: getComputedStyle(node.querySelector("svg")!).color }; });
    expect(styles.opacity).toBe("1"); expect(styles.pointerEvents).toBe("none"); expect(styles.icon).toBe(styles.color); colors.push(styles.color);
  }
  expect(new Set(colors).size).toBe(1);
  await page.screenshot({ path: test.info().outputPath("clean-local-repository.png") });
});

test("Git action explanations follow upstream, detached HEAD and recovery states", async ({ page }) => {
  await openGit(page);
  for (const name of ["Fetch", "Pull", "Push", "Sync 1 ahead 2 behind"]) await expect(sidebar(page).getByRole("button", { name, exact: true })).toBeEnabled();
  await updateStatus(page, { upstream: null, branch: null });
  const push = sidebar(page).getByRole("button", { name: "Push", exact: true });
  await expect(push).toBeDisabled(); await expect(push.locator("..")).toHaveAttribute("title", "Switch to a branch before pushing.");
  await expect(sidebar(page).getByRole("button", { name: "Sync 1 ahead 2 behind", exact: true }).locator("..")).toHaveAttribute("title", "Set an upstream branch to sync.");
  await updateStatus(page, { head: null }); await expect(push.locator("..")).toHaveAttribute("title", "Create a commit before pushing.");
  await updateStatus(page, { recovery: true });
  for (const name of ["Fetch", "Pull", "Push", "Sync 1 ahead 2 behind", "Commit"]) {
    const button = sidebar(page).getByRole("button", { name, exact: true }); await expect(button).toBeDisabled();
    await expect(button.locator("..")).toHaveAttribute("title", "Review the pending Git recovery first.");
  }
});

for (const [state, scene] of [["new", largeNewSchema], ["deleted", deletedSchema]] as const) test(`${state} SDL uses a compact keyboard-accessible entity list`, async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 680 }); const panel = await openGit(page, scene);
  const list = panel.getByLabel("Schema entities", { exact: true }), entities = list.locator("details");
  await expect(list).toBeVisible(); await expect(list.locator("details[open]")).toHaveCount(0);
  const summaries = await entities.locator("summary").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()));
  expect(summaries.length).toBeGreaterThan(0);
  for (let index = 1; index < summaries.length; index++) expect(summaries[index].y - summaries[index - 1].bottom).toBeLessThanOrEqual(1);
  expect((await list.boundingBox())!.height).toBeLessThan(state === "new" ? 500 : 150);
  const first = entities.first(), summary = first.locator("summary");
  await summary.focus(); await page.keyboard.press("Enter"); await expect(first).toHaveAttribute("open", "");
  const focus = await summary.evaluate((node) => { const style = getComputedStyle(node); return { visible: node.matches(":focus-visible"), width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset), color: style.outlineColor }; });
  expect(focus.visible).toBe(true); expect(focus.width).toBeGreaterThan(0); expect(focus.offset).toBeLessThan(0);
  expect(await summary.evaluate((node) => getComputedStyle(node).color)).not.toBe(focus.color);
  await page.keyboard.press("Enter"); await expect(first).not.toHaveAttribute("open", "");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`${state}-schema-list.png`) });
});

test("one field change in a large SDL reveals only its entity and retains collapsed unchanged entities on demand", async ({ page }) => {
  const panel = await openGit(page, { ...largeNewSchema, before: largeNewSchema.after, after: largeNewSchema.after.replace("field0: String", "field0: String!") });
  const list = panel.getByLabel("Schema entities", { exact: true });
  await expect(list.locator("details")).toHaveCount(1); await expect(list).toContainText("Entity0");
  await expect(list).toContainText("Field field0"); await expect(list).not.toContainText("field1:");
  await panel.getByRole("button", { name: "Show unchanged", exact: true }).click();
  await expect(list.locator("details")).toHaveCount(12); await expect(list.locator("details[open]")).toHaveCount(1);
  await expect(list).toContainText("field59:");
  await page.screenshot({ path: test.info().outputPath("modified-schema-list.png") });
});
