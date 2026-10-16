import { expect, test } from "@playwright/test";
import { installPersistenceMock } from "./persistence-mock";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { build } from "vite";
import { extname, resolve, sep } from "node:path";

let productionRoot: string;
test.beforeAll(async () => {
  productionRoot = await mkdtemp(resolve(tmpdir(), "purr-csp-ui-"));
  await build({ configFile: resolve("vite.config.ts"), logLevel: "silent", build: { outDir: productionRoot, emptyOutDir: true } });
});
test.afterAll(async () => { if (productionRoot) await rm(productionRoot, { recursive: true, force: true }); });

// Serve the real production bundle under its production policy. The ordinary
// test server remains available to all other tests and does not get a weaker CSP.
test("production CSP loads the app and blocks response scripts, navigation and IPC", async ({ page }) => {
  await installPersistenceMock(page);
  const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
  const root = productionRoot;
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy|Refused to/.test(message.text())) violations.push(message.text());
  });
  await page.route("http://localhost:1421/**", async (route) => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const file = resolve(root, pathname === "/" ? "index.html" : `.${pathname}`);
    if (!file.startsWith(`${root}${sep}`)) return route.abort();
    try {
      const body = await readFile(file);
      const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png" };
      await route.fulfill({ status: 200, body, contentType: types[extname(file)] || "application/octet-stream", headers: { "Content-Security-Policy": config.app.security.csp } });
    } catch {
      await route.fulfill({ status: 404, body: "Not found" });
    }
  });
  await page.addInitScript(() => {
    (window as any).isTauri = true;
    (window as any).__unsafePreviewRan = false;
    (window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command !== "start_http") throw new Error("Unexpected native command");
      const path = new URL(args.request.url).pathname;
      if (path === "/pixel.png") return { status: 200, statusText: "OK", durationMs: 1, headers: [["content-type", "image/png"]], bodyBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };
      if (path === "/audio") return { status: 200, statusText: "OK", durationMs: 1, headers: [["content-type", "audio/mpeg"]], bodyBase64: btoa("ID3") };
      if (path === "/video") return { status: 200, statusText: "OK", durationMs: 1, headers: [["content-type", "video/mp4"]], bodyBase64: btoa("media") };
      return { status: 200, statusText: "OK", durationMs: 1, headers: [["content-type", "text/html"]], bodyBase64: btoa('<html><body><h1>Safe preview</h1><script>parent.__unsafePreviewRan=true;parent.__TAURI_INTERNALS__.invoke("secure_get")</script><form action="https://example.com/leak"><button>Submit unsafe form</button></form><a target="_top" href="https://example.com/leak">Unsafe navigation</a></body></html>') };
    } };
  });
  await page.goto("/");
  const url = page.getByLabel("Request URL", { exact: true });
  await expect(url).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(violations).toEqual([]);
  const workerFile = (await readdir(resolve(root, "assets"))).find((name) => name.startsWith("graphql-schema.worker-") && name.endsWith(".js"));
  expect(workerFile).toBeTruthy();
  const workerResult = await page.evaluate((file) => new Promise<string>((resolveResult, reject) => {
    const worker = new Worker(`/assets/${file}`, { type: "module" });
    worker.onmessage = (event) => { worker.terminate(); resolveResult(event.data.kind); };
    worker.onerror = () => { worker.terminate(); reject(new Error("Schema worker failed under CSP")); };
    worker.postMessage({ requestId: 1, source: "type Query { hello: String }" });
  }), workerFile!);
  expect(workerResult).toBe("schema-normalized");
  await url.fill("https://example.com/page");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const applicationUrl = page.url();
  const response = page.getByRole("region", { name: "HTTP response" });
  await response.getByRole("button", { name: "Raw", exact: true }).click();
  await expect(response.locator(".cm-editor")).toBeVisible();
  await response.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = page.frameLocator('iframe[title="HTML response preview"]');
  await expect(preview.getByRole("heading", { name: "Safe preview" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__unsafePreviewRan)).toBe(false);
  await expect(page.locator('iframe[title="HTML response preview"]')).toHaveAttribute("sandbox", "");
  await preview.getByRole("button", { name: "Submit unsafe form" }).evaluate((element) => (element as HTMLButtonElement).click());
  await expect(preview.getByRole("heading", { name: "Safe preview" })).toBeVisible();
  await preview.getByRole("link", { name: "Unsafe navigation" }).evaluate((element) => (element as HTMLAnchorElement).click());
  await expect(page).toHaveURL(applicationUrl);
  expect(await page.evaluate(() => (window as any).__unsafePreviewRan)).toBe(false);
  const expectedSecurityViolations = violations.length;
  for (const path of ["pixel.png", "audio", "video"]) {
    await url.fill(`https://example.com/${path}`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    if (path === "pixel.png") {
      const image = response.getByRole("img", { name: "Response preview" });
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(1);
    } else {
      await expect(response.getByLabel(`${path === "audio" ? "Audio" : "Video"} response preview`)).toBeVisible();
    }
  }
  expect(violations.slice(expectedSecurityViolations)).toEqual([]);
});

test("development policy keeps Vite HMR and the editor available", async ({ page }) => {
  const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy|Refused to/.test(message.text())) violations.push(message.text());
  });
  await page.route("http://localhost:1421/**", async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": config.app.security.devCsp } });
  });
  await page.goto("/");
  await expect(page.getByLabel("Request URL", { exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(violations).toEqual([]);
});
