import { expect, test } from "@playwright/test";
import { installPersistenceMock } from "./persistence-mock";

test("failed Save preserves the previous credential and request files until explicit retry", async ({ page }) => {
  await installPersistenceMock(page);
  await page.addInitScript(() => {
    (window as any).isTauri = true;
    (window as any).__TAURI_INTERNALS__ = { invoke: async () => undefined };
  });
  await page.goto("/");
  const workspace = page.getByRole("region", { name: "Workspace", exact: true });
  await expect(workspace).toHaveAttribute("aria-busy", "false");
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.test/transactional");
  await page.getByRole("tab", { name: /^Auth/ }).click();
  await page.getByRole("tab", { name: "Basic Auth", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill("synthetic-user");
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password-A");
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await page.getByLabel("Document name", { exact: true }).fill("Original protected request");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect(workspace).toHaveAttribute("aria-busy", "false");

  await expect.poll(() => page.evaluate(() => Object.entries(JSON.parse(localStorage.getItem("purr-native-secure-test") ?? "{}"))
    .some(([ref, value]) => ref.endsWith("/saved/password") && value === "synthetic-password-A"))).toBe(true);
  const before = await page.evaluate(() => ({
    project: localStorage.getItem("purr-native-persistence-test"),
    secrets: JSON.parse(localStorage.getItem("purr-native-secure-test") ?? "{}"),
    revisions: localStorage.getItem("purr-native-secure-revisions-test"),
  }));
  const savedRef = Object.keys(before.secrets).find((ref) => ref.endsWith("/saved/password"));
  expect(savedRef).toBeTruthy();
  await page.evaluate(() => { (window as any).__purrFailSave = true; });
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password-B");
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await page.getByRole("button", { name: "GET Original protected request", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByLabel("Document name", { exact: true }).fill("Renamed protected request");
  await page.getByRole("dialog", { name: "Rename document" }).getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not save workspace");
  const failed = await page.evaluate(() => ({
    project: localStorage.getItem("purr-native-persistence-test"),
    secrets: JSON.parse(localStorage.getItem("purr-native-secure-test") ?? "{}"),
    revisions: localStorage.getItem("purr-native-secure-revisions-test"),
  }));
  expect(failed).toEqual(before);
  expect(failed.secrets[savedRef!]).toBe("synthetic-password-A");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("synthetic-password-B");

  await page.evaluate(() => { (window as any).__purrFailSave = false; });
  await page.getByRole("button", { name: "Reload and retry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Could not save workspace" })).toHaveCount(0);
  await expect.poll(() => page.evaluate((ref) => JSON.parse(localStorage.getItem("purr-native-secure-test") ?? "{}")[ref], savedRef!)).toBe("synthetic-password-B");
  await expect(workspace).toHaveAttribute("aria-busy", "false");
  await page.reload();
  await expect(page.getByRole("button", { name: "GET Renamed protected request", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /^Auth/ }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("synthetic-password-B");
});

test("an uncertain Save shows a distinct recovery action and preserves active credentials until checked", async ({ page }) => {
  await installPersistenceMock(page);
  await page.addInitScript(() => {
    (window as any).isTauri = true;
    (window as any).__TAURI_INTERNALS__ = { invoke: async () => undefined };
  });
  await page.goto("/");
  const workspace = page.getByRole("region", { name: "Workspace", exact: true });
  await expect(workspace).toHaveAttribute("aria-busy", "false");
  await page.getByRole("tab", { name: /^Auth/ }).click();
  await page.getByRole("tab", { name: "Basic Auth", exact: true }).click();
  await page.getByLabel("Password", { exact: true }).fill("synthetic-recovery-A");
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await page.getByLabel("Document name", { exact: true }).fill("Recovery fixture");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Object.entries(JSON.parse(localStorage.getItem("purr-native-secure-test") ?? "{}"))
    .some(([ref, value]) => ref.endsWith("/saved/password") && value === "synthetic-recovery-A"))).toBe(true);
  await expect(workspace).toHaveAttribute("aria-busy", "false");
  const before = await page.evaluate(() => ({
    project: localStorage.getItem("purr-native-persistence-test"),
    secrets: JSON.parse(localStorage.getItem("purr-native-secure-test") ?? "{}"),
    revisions: localStorage.getItem("purr-native-secure-revisions-test"),
  }));
  const savedRef = Object.keys(before.secrets).find((ref) => ref.endsWith("/saved/password"));
  expect(savedRef).toBeTruthy();
  await page.evaluate(() => { (window as any).__purrNeedsRecovery = true; });
  await page.getByLabel("Password", { exact: true }).fill("synthetic-recovery-B");
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Save needs recovery", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Could not save workspace", exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("Reload to check whether it committed");
  await expect(page.getByRole("button", { name: "Check and retry", exact: true })).toBeVisible();
  expect(await page.evaluate(() => ({
    project: localStorage.getItem("purr-native-persistence-test"),
    secrets: JSON.parse(localStorage.getItem("purr-native-secure-test") ?? "{}"),
    revisions: localStorage.getItem("purr-native-secure-revisions-test"),
  }))).toEqual(before);
  expect(await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("purr-native-secure-operations-test") ?? "{}"))
    .some((operation: any) => operation.status === "recovery-required"))).toBe(true);

  await page.evaluate(() => { (window as any).__purrNeedsRecovery = false; });
  await page.getByRole("button", { name: "Check and retry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Save needs recovery", exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate((ref) => JSON.parse(localStorage.getItem("purr-native-secure-test") ?? "{}")[ref], savedRef!)).toBe("synthetic-recovery-B");
  await expect(workspace).toHaveAttribute("aria-busy", "false");
  expect(await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("purr-native-secure-operations-test") ?? "{}"))
    .some((operation: any) => operation.status === "recovery-required"))).toBe(false);
});
