import { expect, test, type Page } from "@playwright/test";
import { installGitMock } from "../fixtures/git-mock";
import { headerEntities, duplicateHeaderChanges, reorderedHeaders, headerStateChanges, longHeaderRename, collectionValueChanges, headerValueChange, headerRename, headerRenameAndValue, headerAddRemove, secretHeaderChanges, bodyReplacement, jsonValueChange, xmlValueChange, nestedGraphqlChanges, largeNewSchema, deletedRequest, longTextChange, alignmentChanges, graphqlChanges, graphqlFormatting, schemaChanges, newSchema, deletedSchema, dynamicChanges, environmentChanges, newBinaryRequest, newEnvironment, newGraphqlRequest, newMultipartRequest, newRequest, opaqueExtension, requestChanges, type SemanticPreview } from "../fixtures/semantic-git";
async function preview(page: Page, scene: SemanticPreview) {
  await installGitMock(page, { preview: scene, newFile: !scene.before }); await page.goto("/");
  await page.getByRole("button", { name: "Source control", exact: true }).click();
  await page.getByRole("complementary", { name: "Source control", exact: true }).getByRole("button", { name: new RegExp(scene.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  const panel = page.locator("#git-workspace-panel"); await expect(panel.getByRole("tab", { name: "Semantic", exact: true })).toHaveAttribute("aria-selected", "true");
  return panel;
}
test("requests group metadata, auth and payload without field cards or repeated column labels", async ({ page }) => {
  const panel = await preview(page, requestChanges);
  await expect(panel.locator("details[aria-label='Authentication']")).toContainText("Basic");
  await expect(panel.locator("details[aria-label='Authentication']").getByRole("row")).toHaveCount(3); // accessible header + two compact credentials
  await expect(panel.locator("details[aria-label='Body']")).toContainText('"name": "Nora"');
  await expect(panel.locator("details[aria-label='Body']")).not.toContainText("data");
  await expect(panel.locator("[aria-label='Diff legend']").getByText("− Removed", { exact: true })).toHaveCount(1);
  await expect(panel.locator("[aria-label='Diff legend']").getByText("+ Added", { exact: true })).toHaveCount(1);
  await expect(panel.locator("details td").getByText("Before", { exact: true })).toHaveCount(0);
  const endpoint = panel.locator("details[aria-label='URL']");
  await expect(endpoint).toContainText("https://api.example.test/users");
  await expect(endpoint).toContainText("{{base}}/customers");
  await expect(endpoint.locator("mark, [data-scalar-change]")).not.toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("request-comparison.png") });
});
test("new requests present identity in collapsed Info and body as one payload", async ({ page }) => {
  const panel = await preview(page, newRequest); const info = panel.locator("details[aria-label='Info']");
  await expect(info.locator("summary")).toContainText("HTTP request"); await expect(info.locator("summary")).toContainText("Create customer");
  await expect(info).not.toHaveAttribute("open", "");
  await expect(panel.locator("details[aria-label='Name']")).toHaveCount(0); await expect(panel.locator("details[aria-label='Type']")).toHaveCount(0);
  await expect(panel.getByText("Enabled", { exact: true })).toHaveCount(0); await expect(panel.getByText("true", { exact: true })).toHaveCount(0);
  const body = panel.locator("details[aria-label='Body']"); await expect(body).toContainText("JSON"); await expect(body).toContainText('"role": "admin"');
  await page.screenshot({ path: test.info().outputPath("new-request.png") });
});
test("environment values fit in compact rows with badges and a complete dynamic recipe", async ({ page }) => {
  const panel = await preview(page, newEnvironment); const variables = panel.getByRole("table", { name: "Variables", exact: true });
  await expect(variables.getByRole("row")).toHaveCount(5);
  await expect(variables).toContainText("Stored credential"); await expect(variables).toContainText("Disabled"); await expect(variables).toContainText("Get user");
  await expect(variables).not.toContainText("purr/git-fixture/"); await expect(variables).not.toContainText("false"); await expect(variables).not.toContainText("Extraction expression");
  const bounds = await variables.boundingBox(); expect(bounds!.height).toBeLessThan(330);
  await page.screenshot({ path: test.info().outputPath("new-environment.png") });
});
test("a dynamic-variable diff compares complete extraction recipes in one row", async ({ page }) => {
  const panel = await preview(page, dynamicChanges); const variables = panel.getByRole("table", { name: "Variables", exact: true });
  await expect(variables.getByRole("row")).toHaveCount(2);
  await expect(variables).toContainText('$.headers["content-length"]'); await expect(variables).toContainText("$.body.customer.id"); await expect(variables).toContainText("Cache 60s");
  await expect(variables).not.toContainText("Source request"); await expect(variables).not.toContainText("Sensitive"); await expect(variables).not.toContainText("Refresh");
  expect((await variables.boundingBox())!.height).toBeLessThan(180);
  await page.screenshot({ path: test.info().outputPath("dynamic-variable.png") });
});
test("narrow comparisons retain aligned variable values and explicit enabled-state changes", async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 680 }); const panel = await preview(page, environmentChanges);
  const variables = panel.getByRole("table", { name: "Variables", exact: true }); await expect(variables).toContainText("Enabled"); await expect(variables).toContainText("Disabled");
  await expect(variables).toContainText("https://api.example.test"); await expect(variables).toContainText("https://staging.example.test");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("environment-comparison-narrow.png") });
});
test("every dirty-branch action fits inside the modal at narrow desktop width", async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 680 }); await installGitMock(page); await page.goto("/");
  await page.getByRole("button", { name: "Source control", exact: true }).click(); await page.getByRole("button", { name: "Select Git branch" }).click(); await page.getByRole("button", { name: "feature/team", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Uncommitted changes" }), bounds = await dialog.boundingBox();
  for (const name of ["Commit…", "Stash and continue", "Continue safely", "Cancel"]) {
    const button = dialog.getByRole("button", { name, exact: true }); await expect(button).toBeVisible(); const box = await button.boundingBox();
    expect(box!.x).toBeGreaterThan(bounds!.x); expect(box!.x + box!.width).toBeLessThan(bounds!.x + bounds!.width); expect(box!.y + box!.height).toBeLessThan(bounds!.y + bounds!.height);
  }
  await page.screenshot({ path: test.info().outputPath("branch-dialog.png") });
});

test("binary body previews describe the attachment instead of its storage DTO", async ({ page }) => {
  const panel = await preview(page, newBinaryRequest); const body = panel.locator("details[aria-label='Body']");
  await expect(body).toContainText("Binary"); await expect(body).toContainText("report.pdf"); await expect(body).toContainText("application/pdf");
  await expect(body).not.toContainText("fixture-asset"); await expect(body).not.toContainText("mediaType");
});
test("multipart bodies retain duplicate fields, disabled state and attachment metadata", async ({ page }) => {
  const panel = await preview(page, newMultipartRequest); const fields = panel.getByRole("table", { name: "Body fields", exact: true });
  await expect(fields.getByRole("rowheader", { name: "tag", exact: true })).toHaveCount(2);
  await expect(fields).toContainText("one"); await expect(fields).toContainText("two"); await expect(fields).toContainText("Disabled"); await expect(fields).toContainText("report.pdf");
});
test("opaque extension config retains vendor IDs and does not infer a credential reference", async ({ page }) => {
  const panel = await preview(page, opaqueExtension);
  await expect(panel).toContainText('"id": "vendor-id"'); await expect(panel).toContainText('"kind": "secret"'); await expect(panel).toContainText("vendor/reference");
  await expect(panel).not.toContainText("Stored credential");
});

test("GraphQL operation metadata stays compact and empty optional variables are omitted", async ({ page }) => {
  const panel = await preview(page, newGraphqlRequest); const graphql = panel.locator("details[aria-label='GraphQL']");
  await expect(graphql.getByRole("table", { name: "GraphQL settings" })).toContainText("Customer");
  await expect(graphql).toContainText("query Customer { customer { id } }");
  await expect(graphql).not.toContainText("Variables JSON");
});

test("GraphQL query and variables highlight changed tokens with shared syntax colors", async ({ page }) => {
  const panel = await preview(page, graphqlChanges), graphql = panel.locator("details[aria-label='GraphQL']");
  const query = graphql.getByRole("group", { name: "GraphQL comparison" });
  await expect(query.locator('[data-line-change="removed"]')).toContainText(["name"]);
  await expect(query.locator("mark")).toHaveCount(0);
  await expect(query.locator('[data-line-change="added"]')).toContainText(["email"]);
  await expect(query.locator('[data-side="before"] .text-syntax-boolean').first()).toHaveText("query");
  await expect(query.locator('[data-side="after"] .text-syntax-property')).not.toHaveCount(0);
  await expect(query.getByText("# Customer details", { exact: true })).toHaveCount(2);
  const json = graphql.getByRole("group", { name: "JSON comparison" });
  await expect(json.locator('[data-diff="removed"]')).toHaveText(["10"]); await expect(json.locator('[data-diff="added"]')).toHaveText(["20"]);
  await expect(panel.locator(".cm-editor")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("graphql-request.png") });
});
test("formatting-only GraphQL is neutral while exact YAML remains inspectable", async ({ page }) => {
  const panel = await preview(page, graphqlFormatting);
  await expect(panel).toContainText("No semantic changes");
  await panel.getByRole("button", { name: "Show unchanged" }).click();
  await panel.locator("details[aria-label='GraphQL'] summary").click();
  await expect(panel.locator("[data-diff]")).toHaveCount(0);
  await panel.getByRole("tab", { name: "YAML", exact: true }).click();
  await expect(panel.locator(".cm-changedText")).not.toHaveCount(0);
});
test("schema semantic view groups only changed GraphQL entities and members", async ({ page }) => {
  const panel = await preview(page, schemaChanges);
  const character = panel.locator("details[aria-label='Type: Character']");
  await expect(character).toContainText("Field name"); await expect(character).toContainText("Field created"); await expect(character).toContainText("Field status");
  await expect(character).not.toContainText("Field id"); await expect(panel.locator("details[aria-label='Type: Query']")).toHaveCount(0);
  await expect(character.locator('[data-diff="added"]').first()).toHaveText("!");
  await expect(panel.locator("details[aria-label='Scalar: DateTime']")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("graphql-schema.png") });
  await panel.getByRole("button", { name: "Show unchanged" }).click();
  await expect(panel.locator("details[aria-label='Type: Query']")).toBeVisible(); await expect(character).toContainText("Field id");
  await panel.getByRole("tab", { name: "Text", exact: true }).click();
  await expect(panel.locator(".cm-merge-a .cm-line").filter({ hasText: "type Character" })).toBeVisible();
  await expect(panel.locator(".cm-merge-b .cm-changedText")).not.toHaveCount(0);
  const keyword = panel.locator(".cm-merge-b .cm-line").filter({ hasText: "type Character" }).locator("span").first();
  expect(await keyword.evaluate((node) => getComputedStyle(node).color)).not.toBe(await keyword.evaluate((node) => getComputedStyle(node.parentElement!).color));
});
for (const [state, scene] of [["added", newSchema], ["removed", deletedSchema]] as const) test(`${state} GraphQL schema has semantic and highlighted exact content`, async ({ page }) => {
  const panel = await preview(page, scene);
  await expect(panel).toContainText(state === "added" ? "New file" : "Deleted file");
  await expect(panel.locator("details[aria-label='Type: Character']")).toBeVisible();
  await panel.getByRole("tab", { name: "Text", exact: true }).click();
  const content = panel.getByLabel("File content");
  await expect(content).toHaveClass(new RegExp(`purr-git-preview-${state}`));
  const line = content.locator(".cm-line").filter({ hasText: "type Character" });
  expect(await line.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  await expect(content.locator(".cm-lineNumbers")).toBeVisible();
});
test("invalid SDL uses highlighted text without breaking the diff panel", async ({ page }) => {
  await installGitMock(page, { preview: { ...schemaChanges, after: "type Character {\n name: String\n" } }); await page.goto("/");
  await page.getByRole("button", { name: "Source control", exact: true }).click();
  await page.getByRole("complementary", { name: "Source control" }).getByRole("button", { name: new RegExp("characters\\.graphql") }).click();
  const panel = page.locator("#git-workspace-panel");
  await expect(panel.getByRole("tab", { name: "Semantic", exact: true })).toBeDisabled();
  await expect(panel.getByRole("tab", { name: "Text", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(panel.locator(".cm-merge-b")).toContainText("name: String");
});
test("semantic tables center all rows including multiline recipes, flags and credentials", async ({ page }) => {
  const panel = await preview(page, alignmentChanges); const table = panel.getByRole("table", { name: "Variables", exact: true });
  await expect(table).toContainText("Stored credential"); await expect(table).toContainText("Disabled");
  const measurements = await table.locator("tbody tr").evaluateAll((rows) => rows.map((row) => [...row.children].map((cell) => {
    const box = cell.getBoundingClientRect(); const content = cell.firstElementChild?.getBoundingClientRect();
    return { align: getComputedStyle(cell).verticalAlign, delta: content ? Math.abs(content.y + content.height / 2 - box.y - box.height / 2) : 0 };
  })));
  expect(measurements.length).toBe(5);
  for (const row of measurements) for (const cell of row) { expect(cell.align).toBe("middle"); expect(cell.delta).toBeLessThan(3); }
  await expect(table).not.toContainText("purr/git-fixture");
  await page.screenshot({ path: test.info().outputPath("table-alignment.png") });
});
test("sidebar keeps commit before review and overview is top aligned with the Purr icon", async ({ page }) => {
  await installGitMock(page); await page.goto("/"); await page.getByRole("button", { name: "Source control", exact: true }).click();
  const sidebar = page.getByRole("complementary", { name: "Source control", exact: true });
  expect((await sidebar.getByRole("region", { name: "Changes", exact: true }).boundingBox())!.y).toBeGreaterThan((await sidebar.getByRole("textbox", { name: "Commit message" }).boundingBox())!.y);
  await expect(sidebar.getByText("HTTP request", { exact: true })).toBeVisible();
  await expect(sidebar).not.toContainText("Stage changes to commit.");
  await expect(sidebar.getByRole("button", { name: "Commit", exact: true }).locator("..")).toHaveAttribute("title", "Stage changes to commit.");
  const panel = page.locator("#git-workspace-panel"), icon = panel.getByRole("img", { name: "Purr", exact: true });
  await expect(icon).toBeVisible(); expect((await icon.boundingBox())!.y - (await panel.boundingBox())!.y).toBeLessThan(60);
  await expect(panel.getByRole("button", { name: "Fetch", exact: true })).toHaveCount(0);
  await expect(panel).toContainText("Tracking origin/main"); await expect(panel).toContainText("1 changed file");
  await page.screenshot({ path: test.info().outputPath("overview.png") });
});

test("exact YAML highlights inserted URL text and preserves collapsed unchanged sections", async ({ page }) => {
  const panel = await preview(page, longTextChange);
  await panel.getByRole("tab", { name: "YAML", exact: true }).click();
  const insertion = panel.locator(".cm-merge-b .cm-changedText");
  await expect(insertion).toContainText("/42");
  const markColor = await insertion.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(markColor).not.toBe("rgba(0, 0, 0, 0)");
  await expect(panel.locator(".cm-merge-a .cm-changedText")).toHaveCount(0);
  await expect(panel.locator(".cm-collapsedLines")).not.toHaveCount(0);
  await panel.locator(".cm-merge-b .cm-collapsedLines").last().click();
  await expect(panel.locator(".cm-merge-b")).toContainText("Documentation line 40: retained context");
  await page.screenshot({ path: test.info().outputPath("yaml-inline.png") });
});
test("local-only overview and initial Git state stay useful without duplicate Git actions", async ({ page }) => {
  await installGitMock(page); await page.goto("/");
  await page.evaluate(() => { Object.assign((window as any).__gitStatus, { remotes: [], upstream: null, ahead: 0, behind: 0 }); });
  await page.getByRole("button", { name: "Source control", exact: true }).click();
  const panel = page.locator("#git-workspace-panel");
  await expect(panel).toContainText("Local repository"); await expect(panel).toContainText("Your commits stay on this device.");
  await expect(panel).toContainText("Recent commits");
  await expect(panel.getByRole("button", { name: /Fetch|Push|Pull/ })).toHaveCount(0);
  await page.evaluate(() => { (window as any).__gitStatus.initialized = false; });
  await page.getByRole("button", { name: "Refresh Git", exact: true }).click();
  await expect(panel).toContainText("Keep your project in Git");
  await expect(page.getByRole("button", { name: "Initialize Git", exact: true })).toHaveCount(1);
  await expect(panel.getByRole("img", { name: "Purr", exact: true })).toBeVisible();
});

test("a single header value edit marks only the changed character", async ({ page }) => {
  const panel = await preview(page, headerValueChange), headers = panel.getByRole("table", { name: "Headers", exact: true });
  await expect(headers.getByRole("rowheader")).toHaveText(["X-Mode"]);
  await expect(headers.locator('[data-diff="removed"]')).toHaveText(["m"]);
  await expect(headers.locator('[data-diff="added"]')).toHaveCount(0);
  await expect(headers.locator('td').last()).toHaveText("pa");
  await page.screenshot({ path: test.info().outputPath("header-value.png") });
});
for (const [title, scene, changed] of [["header rename", headerRename, false], ["header name and value changes", headerRenameAndValue, true]] as const) test(`${title} stays in one logical table row`, async ({ page }) => {
  const panel = await preview(page, scene), headers = panel.getByRole("table", { name: "Headers", exact: true });
  await expect(headers.locator("tbody tr")).toHaveCount(1);
  await expect(headers.getByRole("columnheader")).toHaveText(["Header", "Before", "After"]);
  await expect(headers.getByRole("rowheader")).toHaveText(["X-Mode→X-Request-Mode"]);
  await expect(headers.locator("tbody td").first()).toHaveText("pam");
  if (!changed) await expect(headers.locator("tbody td mark, tbody td [data-scalar-change]")).toHaveCount(0);
  else await expect(headers.locator("tbody td").last()).toHaveText("Token");
  await expect(headers.getByText("Header name", { exact: true })).toHaveCount(0);
  await expect(headers.getByText("Value", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("header-rename.png") });
});
test("added and removed headers use row indicators with normal value text", async ({ page }) => {
  const panel = await preview(page, headerAddRemove), headers = panel.getByRole("table", { name: "Headers", exact: true });
  await expect(headers.getByLabel("Added field", { exact: true })).toHaveCount(1); await expect(headers.getByLabel("Removed field", { exact: true })).toHaveCount(1);
  await expect(headers).toContainText("X-New"); await expect(headers).toContainText("X-Mode");
  await expect(headers.locator("mark, [data-scalar-change]")).toHaveCount(0);
});
test("changed credential references indicate change without exposing values or coloring identical references", async ({ page }) => {
  const panel = await preview(page, secretHeaderChanges), headers = panel.getByRole("table", { name: "Headers", exact: true });
  await expect(headers.getByText("Stored credential", { exact: true })).toHaveCount(2);
  await expect(headers.locator("[data-secret-change]")).toHaveCount(2);
  await expect(headers).not.toContainText("purr/git-fixture");
  await panel.getByRole("button", { name: "Show unchanged", exact: true }).click();
  const same = headers.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "X-Same-Key", exact: true }) });
  await expect(same.getByText("Stored credential", { exact: true })).toHaveCount(2);
  await expect(same.locator("[data-secret-change], mark")).toHaveCount(0);
});
test("JSON to XML replacement keeps both syntax palettes and avoids fragmented inline marks", async ({ page }) => {
  const panel = await preview(page, bodyReplacement), body = panel.locator("details[aria-label='Body']");
  const content = body.locator("[data-content-replacement]");
  await expect(content).toHaveCount(1); await expect(content.getByLabel("Removed content", { exact: true })).toBeVisible(); await expect(content.getByLabel("Added content", { exact: true })).toBeVisible();
  await expect(content.locator("mark, [data-line-change]")).toHaveCount(0);
  await expect(content.locator('[data-side="before"] .text-syntax-property')).toContainText(['"name"', '"limit"', '"active"']);
  await expect(content.locator('[data-side="after"] .text-syntax-tag')).not.toHaveCount(0);
  await expect(body).toContainText('"Nora"'); await expect(body).toContainText("<name>Nora</name>");
  await page.screenshot({ path: test.info().outputPath("body-replacement.png") });
});
for (const [language, scene] of [["JSON", jsonValueChange], ["XML", xmlValueChange]] as const) test(`${language} value modification keeps punctuation and unchanged values neutral`, async ({ page }) => {
  const panel = await preview(page, scene), body = panel.locator("details[aria-label='Body']");
  await expect(body.locator('[data-diff="removed"]')).toHaveText([language === "JSON" ? "10" : "1"]);
  await expect(body.locator('[data-diff="added"]')).toHaveText([language === "JSON" ? "20" : "2"]);
  await expect(body.locator("[data-content-replacement], [data-line-change]")).toHaveCount(0);
  await expect(body).toContainText("Nora");
});
test("nested GraphQL edits and reordered fields keep aligned rows and distinguish additions from inline edits", async ({ page }) => {
  const panel = await preview(page, nestedGraphqlChanges), query = panel.getByRole("group", { name: "GraphQL comparison" });
  await expect(query.locator('[data-line-change="added"]').filter({ hasText: "email" })).toHaveCount(1);
  await expect(query.locator('[data-line-change="added"]').filter({ hasText: "created" })).toHaveCount(1);
  await expect(query.locator('[data-line-change="removed"]').filter({ hasText: "legacy" })).toHaveCount(1);
  await expect(query.locator('[data-line-change] mark')).toHaveCount(0);
  await expect(query.locator('[data-diff="removed"]')).toHaveText(["true", "10", "true"]);
  await expect(query.locator('[data-diff="added"]')).toHaveText(["false", "20", "false"]);
  const rows = await query.locator(':scope > div').evaluateAll((rows) => rows.map((row) => [...row.children].map((cell) => cell.getBoundingClientRect().height)));
  for (const [before, after] of rows) expect(before).toBe(after);
  await page.screenshot({ path: test.info().outputPath("nested-graphql.png") });
});
test("a large new schema is summarized with lazy collapsed entities", async ({ page }) => {
  const panel = await preview(page, largeNewSchema);
  await expect(panel).toContainText("12 schema entities");
  await expect(panel.locator('details[aria-label^="Type:"]')).toHaveCount(12);
  await expect(panel.locator('details[open]')).toHaveCount(0);
  await expect(panel.locator('[role="group"][aria-label="GraphQL comparison"]')).toHaveCount(0);
  await expect(panel.locator("mark")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("new-schema-summary.png") });
  const entity = panel.locator('details[aria-label="Type: Entity0"]'); await expect(entity.locator("summary")).toContainText("60 members");
  await entity.locator("summary").click(); await expect(entity).toContainText("field59"); await expect(entity.locator("mark")).toHaveCount(0);
});
for (const [state, scene] of [["New", newRequest], ["Deleted", deletedRequest]] as const) test(`${state} YAML content retains normal syntax with a file indicator`, async ({ page }) => {
  const panel = await preview(page, scene); await expect(panel).toContainText(`${state} file`);
  await panel.getByRole("tab", { name: "YAML", exact: true }).click();
  await expect(panel.locator(".cm-changedText, .cm-changedLine, mark")).toHaveCount(0);
  const line = panel.getByLabel("File content").locator(".cm-line").filter({ hasText: "name: Create customer" });
  await expect(line).toBeVisible(); expect(await line.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
});
test("disabled commit is neutral and explanations are available through its tooltip", async ({ page }) => {
  await installGitMock(page); await page.goto("/"); await page.getByRole("button", { name: "Source control", exact: true }).click();
  const sidebar = page.getByRole("complementary", { name: "Source control", exact: true }), commit = sidebar.getByRole("button", { name: "Commit", exact: true });
  await expect(commit).toBeDisabled();
  const disabledColor = await commit.evaluate((node) => getComputedStyle(node).backgroundColor);
  await expect(commit.locator("..")).toHaveAttribute("title", "Stage changes to commit.");
  await expect(sidebar.locator("form p")).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Stage all files", exact: true }).click();
  await expect(commit.locator("..")).toHaveAttribute("title", "Enter a commit message.");
  await sidebar.getByRole("textbox", { name: "Commit message", exact: true }).fill("Update headers");
  await expect(commit).toBeEnabled(); await expect(commit.locator("..")).toHaveAttribute("title", "Commit 1 staged file only.");
  await expect.poll(() => commit.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(disabledColor);
  await page.screenshot({ path: test.info().outputPath("sidebar-staged.png") });
});

test("modified SDL list and nullability punctuation is meaningful and remains highlighted", async ({ page }) => {
  const panel = await preview(page, { ...schemaChanges, after: schemaChanges.after.replace("name: String!", "name: [String!]!") });
  const field = panel.locator("details[aria-label='Type: Character']").getByRole("group", { name: "GraphQL comparison" }).first();
  await expect(field.locator('[data-diff="added"]')).toHaveText(["[", "!", "]", "!"]);
  await expect(field).toContainText("name: String"); await expect(field).toContainText("name: [String!]!");
});

test("renamed, added and removed headers share a compact entity layout", async ({ page }) => {
  const panel = await preview(page, headerEntities), headers = panel.getByRole("table", { name: "Headers", exact: true });
  const rows = headers.locator("tbody tr"); await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).getByRole("rowheader")).toHaveText("another→anothe");
  await expect(rows.nth(0).locator("td")).toHaveText(["another", "another-change"]);
  await expect(rows.nth(1).getByRole("rowheader")).toHaveText("+newgate"); await expect(rows.nth(1).locator("td")).toHaveText(["—", "new"]);
  await expect(rows.nth(2).getByRole("rowheader")).toHaveText("−X-API-Key"); await expect(rows.nth(2).locator("td")).toHaveText(["Stored credentialSecret", "—"]);
  await expect(rows.nth(1).locator("mark, [data-scalar-change]")).toHaveCount(0); await expect(rows.nth(2).locator("mark, [data-scalar-change]")).toHaveCount(0);
  await expect(headers).not.toContainText("purr/git-fixture");
  await page.screenshot({ path: test.info().outputPath("header-entities.png") });
});
test("multiple modified headers with duplicate names keep values paired by ID", async ({ page }) => {
  const panel = await preview(page, duplicateHeaderChanges), headers = panel.getByRole("table", { name: "Headers", exact: true });
  await expect(headers.locator("tbody tr")).toHaveCount(2);
  await expect(headers.getByRole("rowheader", { name: "X-Repeat", exact: true })).toHaveCount(2);
  await expect(headers.locator("tbody tr").nth(0).locator("td")).toHaveText(["one", "one-update"]);
  await expect(headers.locator("tbody tr").nth(1).locator("td")).toHaveText(["two", "two-update"]);
});
test("header reordering preserves identical values and avoids modified-value highlights", async ({ page }) => {
  const panel = await preview(page, reorderedHeaders), headers = panel.getByRole("table", { name: "Headers", exact: true });
  await expect(headers.locator("tbody tr")).toHaveCount(2); await expect(headers.getByText("Reordered", { exact: true })).toHaveCount(2);
  await expect(headers.locator("tbody tr").nth(0).locator("td")).toHaveText(["two", "two"]);
  await expect(headers.locator("tbody tr").nth(1).locator("td")).toHaveText(["one", "one"]);
  await expect(headers.locator("mark, [data-scalar-change], [data-secret-change]")).toHaveCount(0);
  await expect(headers.getByLabel("Added field", { exact: true })).toHaveCount(0); await expect(headers.getByLabel("Removed field", { exact: true })).toHaveCount(0);
});
test("header enabled and sensitive state changes remain visible within their entity rows", async ({ page }) => {
  const panel = await preview(page, headerStateChanges), headers = panel.getByRole("table", { name: "Headers", exact: true });
  await expect(headers.locator("tbody tr")).toHaveCount(2);
  await expect(headers.locator("tbody tr").nth(0).locator("td")).toHaveText(["sameEnabled", "sameDisabled"]);
  await expect(headers.locator("tbody tr").nth(1).locator("td")).toHaveText(["{{api_token}}Public", "{{api_token}}Secret"]);
  await expect(headers.locator("mark, [data-scalar-change]")).toHaveCount(0);
});
test("long header renames wrap within a single centered row in a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 680 }); const panel = await preview(page, longHeaderRename), headers = panel.getByRole("table", { name: "Headers", exact: true });
  await expect(headers.locator("tbody tr")).toHaveCount(1);
  const cells = await headers.locator("tbody tr").first().locator("th, td").evaluateAll((cells) => cells.map((cell) => ({ overflow: cell.scrollWidth > cell.clientWidth, align: getComputedStyle(cell).verticalAlign })));
  for (const cell of cells) { expect(cell.overflow).toBe(false); expect(cell.align).toBe("middle"); }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("long-header-rename.png") });
});
test("query parameters and URL encoded fields reuse the same entity rows without merging duplicate fields", async ({ page }) => {
  const panel = await preview(page, collectionValueChanges), params = panel.getByRole("table", { name: "Query parameters", exact: true }), fields = panel.getByRole("table", { name: "Body fields", exact: true });
  await expect(params.locator("tbody tr")).toHaveCount(1); await expect(params.getByRole("rowheader")).toHaveText(["search"]); await expect(params.locator("tbody td")).toHaveText(["old", "new"]);
  await expect(fields.locator("tbody tr")).toHaveCount(3); await expect(fields.getByRole("rowheader", { name: /tag/ })).toHaveCount(2);
  await expect(fields.locator("tbody tr").nth(1).locator("td")).toHaveText(["secondDisabled", "secondDisabled"]);
  await expect(fields.locator("tbody tr").nth(2).locator("td")).toHaveText(["first", "first"]);
});
