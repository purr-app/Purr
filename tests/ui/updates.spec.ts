import { readFileSync } from "node:fs";
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
const nextVersion = version.replace(/\d+$/, (patch) => String(Number(patch) + 1));
import { expect, test } from "@playwright/test";

test("source build exposes its version in More without an updater", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: `Version v${version}` })).toBeVisible();
  await expect(page.locator("footer")).toHaveCount(0);
  await expect(page.getByText("About Purr", { exact: true })).toHaveCount(0);
  await page.getByRole("menuitem", { name: `Version v${version}` }).click();
  await expect(page.getByRole("heading", { name: "Automatic updates unavailable" })).toBeVisible();
});
test("release notes open once after the installed version changes", async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("purr.release-notes.seen-version", "0.1.0"); sessionStorage.setItem("seeded", "yes"); } });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What’s new" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("tab", { name: "Release notes", exact: true })).toHaveCount(0);
});
test("startup notice can be deferred; menu reveals updates and explicit Restart installs", async ({ page }) => {
  await page.goto("/tests/fixtures/updater/index.html");
  await expect(page.getByRole("heading", { name: `Purr v${nextVersion}` })).toBeVisible();
  await expect(page.getByText("Faster response viewer.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Later", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Purr v${nextVersion}` })).toHaveCount(0);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: /Version v/ }).click();
  await expect(page.getByRole("button", { name: "Download", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.getByRole("progressbar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toHaveAttribute("data-installed", "true");
  await expect(page.locator("body")).not.toHaveAttribute("data-restarted", "true");
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-installed", "true");
  await expect(page.locator("body")).toHaveAttribute("data-restarted", "true");
});
test("failed startup checks show a dismissible error with retry", async ({ page }) => {
  await page.goto("/tests/fixtures/updater/index.html?mode=offline");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Check your connection");
  await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible();
  await alert.getByRole("button", { name: "Dismiss Update failed" }).click();
  await expect(alert).toHaveCount(0);
});

test("a distribution owns its version and notes independently of core", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("purr.release-notes.seen-version", "0.0.1"));
  await page.goto("/tests/fixtures/updater/index.html?mode=commercial");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /Version v/ })).toContainText("v0.1.0");
  await page.keyboard.press("Escape");
  const panel = page.getByRole("tabpanel", { name: "Release notes" });
  await expect(panel).toContainText("Purr v0.1.0");
  await expect(panel.getByRole("heading", { name: "First beta" })).toBeVisible();
  await expect(panel.locator("time")).toHaveAttribute("datetime", "2026-09-20");
  await expect(panel).not.toContainText("Release notes are not bundled");
  await expect(panel).not.toContainText("For developers");
});
