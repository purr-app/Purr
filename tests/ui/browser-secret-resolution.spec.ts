import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/__browser-secret-tests", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Isolated storage fixture</title>" }));
  await page.goto("/__browser-secret-tests");
});

test("browser secret resolution distinguishes missing, empty and deleted values", async ({ page }) => {
  const states = await page.evaluate(async () => {
    const modulePath = "/src/storage/browser-backend.ts";
    const { BrowserSecureStore } = await import(modulePath);
    const secure = new BrowserSecureStore(); const ref = "purr/fixture/credentials/secret";
    const absent = await secure.resolve(ref);
    await secure.set(ref, ""); const empty = await secure.resolve(ref);
    await secure.delete(ref); const deleted = await secure.resolve(ref);
    return { absent, empty, deleted };
  });
  expect(states).toEqual({ absent: { status: "missing", revision: 0 }, empty: { status: "available", value: "", revision: 1 }, deleted: { status: "missing", revision: 2 } });
});

test("browser corrupted ciphertext is not reported as missing, even when marked deleted", async ({ page }) => {
  const state = await page.evaluate(async () => {
    const modulePath = "/src/storage/browser-backend.ts";
    const { BrowserSecureStore } = await import(modulePath);
    const secure = new BrowserSecureStore(); const ref = "purr/fixture/credentials/secret";
    await secure.set(ref, "synthetic-value");
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("purr-preview-v3"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("secrets", "readwrite"); const store = transaction.objectStore("secrets"); const request = store.get(ref);
      request.onsuccess = () => { store.put({ ...request.result, deleted: true, data: new Uint8Array([0]).buffer }, ref); };
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
    }); db.close();
    return secure.resolve(ref);
  });
  expect(state).toEqual({ status: "corrupt", code: "browser-protected-data-corrupt", retryable: false });
});

test("browser failed key initialization remains retryable and never leaks platform error text", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const modulePath = "/src/storage/browser-backend.ts";
    const { BrowserSecureStore } = await import(modulePath);
    const secure = new BrowserSecureStore(); const ref = "purr/fixture/credentials/secret";
    const original = indexedDB.open.bind(indexedDB);
    indexedDB.open = () => { throw new Error("DO_NOT_EXPOSE_PLATFORM_DETAIL"); };
    const unavailable = await secure.resolve(ref);
    let failed = false;
    try { await secure.commit({ operationId: "failed-key", mutations: [{ ref, scope: { owner: "workspace", workspaceId: "fixture", kind: "credentials" }, expectedRevision: 0, value: "synthetic" }] }); } catch { failed = true; }
    indexedDB.open = original;
    await secure.set(ref, "recovered");
    return { unavailable, failed, recovered: await secure.resolve(ref) };
  });
  expect(result).toEqual({ unavailable: { status: "unavailable", code: "browser-storage-unavailable", retryable: true }, failed: true, recovered: { status: "available", value: "recovered", revision: 1 } });
});

test("browser degraded load preserves canonical files and opaque local ciphertext for retry", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const modulePath = "/src/storage/browser-backend.ts";
    const { BrowserPersistenceBackend } = await import(modulePath);
    const backend = new BrowserPersistenceBackend();
    await backend.commit("fixture", [{ path: "purr.yaml", content: "purr: 2", expectedRevision: null }], [{ table: "drafts", id: "draft", value: "synthetic-private-draft" }]);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("purr-preview-v3"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    let original: unknown;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("local", "readwrite"); const store = transaction.objectStore("local"); const request = store.get("fixture");
      request.onsuccess = () => { original = request.result; store.put({ ...request.result, data: new Uint8Array([0]).buffer }, "fixture"); };
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
    });
    const degraded = await backend.load();
    const stillDegraded = await backend.retryProtectedStorage();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("local", "readwrite"); transaction.objectStore("local").put(original, "fixture");
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
    }); db.close();
    const recovered = await backend.retryProtectedStorage();
    return { degraded: degraded.workspaces[0], stillDegraded: stillDegraded.workspaces[0].protectedState, recovered: recovered.workspaces[0] };
  });
  expect(result.degraded.files["purr.yaml"].content).toBe("purr: 2");
  expect(result.degraded.local).toEqual([]);
  expect(result.degraded.protectedState).toEqual({ status: "corrupt", code: "browser-protected-data-corrupt" });
  expect(result.stillDegraded).toEqual(result.degraded.protectedState);
  expect(result.recovered.protectedState).toEqual({ status: "available" });
  expect(result.recovered.local).toEqual([{ table: "drafts", id: "draft", value: "synthetic-private-draft" }]);
});
