import { expect, test } from "@playwright/test";
import { buildSchema, introspectionFromSchema } from "graphql";
import { installPersistenceMock } from "./persistence-mock";

test("workspace On reaches introspection transport and captured SDL stays encrypted after Off", async ({ page }) => {
  await installPersistenceMock(page);
  await page.addInitScript((introspection) => {
    (window as any).isTauri = true;
    (window as any).__schemaPolicies = [];
    (window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command !== "start_http") return;
      (window as any).__schemaPolicies.push(args.request.responseStorage);
      return { status: 200, statusText: "OK", durationMs: 1, headers: [["content-type", "application/json"]], bodyBase64: btoa(JSON.stringify({ data: introspection })) };
    } };
  }, introspectionFromSchema(buildSchema("type Query { syntheticPrivateField: String }")));
  await page.goto("/");
  await page.getByRole("button", { name: "Select workspace" }).click();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  await page.getByRole("tab", { name: "Secrets and encryption", exact: true }).click();
  await page.getByRole("switch", { name: "Encrypt responses for this workspace", exact: true }).click();
  await page.getByRole("button", { name: "Create document", exact: true }).click();
  await page.getByRole("menuitem", { name: "GraphQL schema", exact: true }).click();
  await page.getByLabel("GraphQL schema endpoint", { exact: true }).fill("https://fixture.invalid/graphql");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.getByRole("region", { name: "Type Query", exact: true })).toContainText("syntheticPrivateField");
  expect(await page.evaluate(() => (window as any).__schemaPolicies)).toEqual([{ protection: "encrypted" }]);
  await expect(page.getByRole("button", { name: "Pin schema SDL to project", exact: true })).toHaveAttribute("aria-pressed", "false");
  const persisted = () => page.evaluate(() => {
    const snapshot = JSON.parse(localStorage.getItem("purr-native-persistence-test") ?? "{}");
    const workspace = snapshot.workspaces?.[0];
    return { protection: workspace?.local.find((record: any) => record.table === "schema_cache")?.protection, publicFiles: JSON.stringify(workspace?.files) };
  });
  await expect.poll(async () => (await persisted()).protection).toBe("encrypted");
  expect((await persisted()).publicFiles).not.toContain("syntheticPrivateField");
  await page.getByRole("button", { name: "Select workspace" }).click();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  await page.getByRole("tab", { name: "Secrets and encryption", exact: true }).click();
  await page.getByRole("switch", { name: "Encrypt responses for this workspace", exact: true }).click();
  await expect(page.getByRole("region", { name: "Workspace", exact: true })).toHaveAttribute("aria-busy", "false");
  await page.reload();
  expect((await persisted()).protection).toBe("encrypted");
  expect((await persisted()).publicFiles).not.toContain("syntheticPrivateField");
});
