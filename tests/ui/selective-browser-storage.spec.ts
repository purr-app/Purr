import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/__selective-storage-tests", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Synthetic selective storage</title>" }));
  await page.goto("/__selective-storage-tests");
});

test("public publication and empty-batch receipts need no key, and preserve the prior preview", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const previous = await new Promise<IDBDatabase>((resolve) => {
      const open = indexedDB.open("purr-preview-v3", 1); open.onupgradeneeded = () => open.result.createObjectStore("sentinel"); open.onsuccess = () => resolve(open.result);
    });
    await new Promise<void>((resolve) => { const tx = previous.transaction("sentinel", "readwrite"); tx.objectStore("sentinel").put("unchanged", "old"); tx.oncomplete = () => resolve(); });
    const path = "/src/storage/browser-backend.ts"; const { BrowserPersistenceBackend, BrowserSecureStore } = await import(path);
    const backend = new BrowserPersistenceBackend();
    const original = crypto.subtle.generateKey.bind(crypto.subtle); crypto.subtle.generateKey = () => Promise.reject(new Error("SYNTHETIC_PROVIDER_UNAVAILABLE"));
    const batch = { operationId: crypto.randomUUID(), mutations: [] };
    await backend.commit("public", [{ path: "purr.yaml", content: "public-project", expectedRevision: null }], [{ table: "drafts", id: "one", protection: "plaintext", value: "public-draft" }], batch);
    const receipt = await new BrowserSecureStore().operationStatus(batch.operationId);
    const snapshot = await backend.load(); crypto.subtle.generateKey = original;
    const db = await new Promise<IDBDatabase>((resolve) => { const open = indexedDB.open("purr-preview-v4"); open.onsuccess = () => resolve(open.result); });
    const keyCount = await new Promise<number>((resolve) => { const request = db.transaction("keys").objectStore("keys").count(); request.onsuccess = () => resolve(request.result); }); db.close();
    const old = await new Promise<unknown>((resolve) => { const request = previous.transaction("sentinel").objectStore("sentinel").get("old"); request.onsuccess = () => resolve(request.result); }); previous.close();
    return { receipt, snapshot, keyCount, old };
  });
  expect(result.snapshot.workspaces[0].runtimeProtectedState.status).toBe("unavailable");
  expect(result.receipt.status).toBe("committed"); expect(result.keyCount).toBe(0); expect(result.old).toBe("unchanged");
  expect(result.snapshot.workspaces[0].local).toContainEqual({ table: "drafts", id: "one", protection: "plaintext", value: "public-draft" });
});

test("public saves preserve unavailable protected records byte for byte and refuse replacing them", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const path = "/src/storage/browser-backend.ts"; const { BrowserPersistenceBackend } = await import(path); const backend = new BrowserPersistenceBackend();
    await backend.commit("mixed", [{ path: "purr.yaml", content: "old", expectedRevision: null }], [
      { table: "drafts", id: "public", protection: "plaintext", value: "public-A" },
      { table: "drafts", id: "private", protection: "encrypted", value: "SYNTHETIC_PRIVATE_MARKER" },
    ]);
    const db = await new Promise<IDBDatabase>((resolve) => { const open = indexedDB.open("purr-preview-v4"); open.onsuccess = () => resolve(open.result); });
    const local = () => new Promise<any>((resolve) => { const request = db.transaction("local").objectStore("local").get("mixed"); request.onsuccess = () => resolve(request.result); });
    const before = await local(); const originalBytes = Array.from(new Uint8Array(before.records[1].envelope.data));
    const key = `key/${JSON.stringify(["workspace", "mixed", "runtime"])}`;
    await new Promise<void>((resolve) => { const tx = db.transaction("keys", "readwrite"); tx.objectStore("keys").delete(key); tx.oncomplete = () => resolve(); });
    const degraded = await backend.loadWorkspace("mixed");
    await backend.writeLocal("mixed", [{ table: "drafts", id: "public", protection: "plaintext", value: "public-B" }]);
    let replacementRejected = false; let deletionRejected = false;
    try { await backend.writeLocal("mixed", [{ table: "drafts", id: "private", protection: "plaintext", value: "must-not-overwrite" }]); } catch { replacementRejected = true; }
    try { await backend.writeLocal("mixed", [{ table: "drafts", id: "private", value: null }]); } catch { deletionRejected = true; }
    const after = await local(); db.close();
    return { degraded, after, originalBytes, bytes: Array.from(new Uint8Array(after.records[1].envelope.data)), replacementRejected, deletionRejected, publicLeak: JSON.stringify(after).includes("SYNTHETIC_PRIVATE_MARKER") };
  });
  expect(result.degraded.local).toEqual([{ table: "drafts", id: "public", protection: "plaintext", value: "public-A" }]);
  expect(result.degraded.unavailableLocal).toEqual([{ table: "drafts", id: "private", state: { status: "unavailable", code: "browser-scope-key-missing" } }]);
  expect(result.bytes).toEqual(result.originalBytes); expect(result.after.records[0].value).toBe("public-B");
  expect(result.replacementRejected).toBe(true); expect(result.deletionRejected).toBe(true); expect(result.publicLeak).toBe(false);
});

test("unknown record variants cannot be read or overwritten as public data", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const path = "/src/storage/browser-backend.ts"; const { BrowserPersistenceBackend } = await import(path); const backend = new BrowserPersistenceBackend();
    await backend.commit("malformed", [], [{ table: "drafts", id: "one", protection: "plaintext", value: "public" }]);
    const db = await new Promise<IDBDatabase>((resolve) => { const open = indexedDB.open("purr-preview-v4"); open.onsuccess = () => resolve(open.result); });
    await new Promise<void>((resolve) => { const tx = db.transaction("local", "readwrite"); const store = tx.objectStore("local"); const request = store.get("malformed"); request.onsuccess = () => { request.result.records[0].version = 999; store.put(request.result, "malformed"); }; tx.oncomplete = () => resolve(); }); db.close();
    const loaded = await backend.loadWorkspace("malformed"); let rejected = false;
    try { await backend.writeLocal("malformed", [{ table: "drafts", id: "one", protection: "plaintext", value: "replacement" }]); } catch { rejected = true; }
    return { loaded, rejected };
  });
  expect(result.loaded.local).toEqual([]); expect(result.loaded.protectedState.status).toBe("corrupt"); expect(result.rejected).toBe(true);
});

test("mixed history keeps protected summaries private and public entries usable without the runtime key", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const path = "/src/storage/browser-backend.ts"; const { BrowserPersistenceBackend } = await import(path); const backend = new BrowserPersistenceBackend();
    const entry = (id: string, protection: "plaintext" | "encrypted") => ({ version: 1, protection, id, documentId: id, name: protection === "encrypted" ? "SYNTHETIC_PRIVATE_NAME" : "public-name", kind: "http", method: "GET", url: `https://example.com/${id}`, startedAt: Date.now(), durationMs: 1, outcome: "response", status: 200, size: 0, pinned: false, editor: {}, response: null, error: "", files: {} });
    await backend.history.append("history-fixture", entry("private", "encrypted")); await backend.history.append("history-fixture", entry("public", "plaintext"));
    const healthy = await backend.history.list("history-fixture", {});
    const db = await new Promise<IDBDatabase>((resolve) => { const open = indexedDB.open("purr-preview-v4"); open.onsuccess = () => resolve(open.result); });
    const records = await new Promise<any[]>((resolve) => { const request = db.transaction("app").objectStore("app").getAll(); request.onsuccess = () => resolve(request.result); });
    const leaked = JSON.stringify(records).includes("SYNTHETIC_PRIVATE_NAME");
    const key = `key/${JSON.stringify(["workspace", "history-fixture", "runtime"])}`;
    await new Promise<void>((resolve) => { const tx = db.transaction("keys", "readwrite"); tx.objectStore("keys").delete(key); tx.oncomplete = () => resolve(); }); db.close();
    const degraded = await backend.history.list("history-fixture", {}); const publicEntry = await backend.history.read("history-fixture", "public");
    const local = await backend.loadWorkspace("history-fixture");
    return { healthy, degraded, publicEntry, leaked, local };
  });
  expect(result.healthy.items.find((item: { id: string }) => item.id === "private").name).toBe("SYNTHETIC_PRIVATE_NAME");
  expect(result.degraded.items.find((item: { id: string }) => item.id === "private").name).toBe("Encrypted response");
  expect(result.publicEntry.name).toBe("public-name"); expect(result.leaked).toBe(false);
  expect(result.local.local.map((item: { id: string }) => item.id)).toEqual(["public"]);
  expect(result.local.unavailableLocal[0].id).toBe("private");
});

test("preparing a new snapshot cannot treat a missing established runtime key as an empty secret", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const path = "/src/storage/browser-backend.ts"; const { BrowserPersistenceBackend, BrowserSecureStore } = await import(path);
    const backend = new BrowserPersistenceBackend(); const secure = new BrowserSecureStore();
    await backend.commit("prepare", [], [{ table: "drafts", id: "protected", value: "synthetic" }]);
    const db = await new Promise<IDBDatabase>((resolve) => { const open = indexedDB.open("purr-preview-v4"); open.onsuccess = () => resolve(open.result); });
    const key = `key/${JSON.stringify(["workspace", "prepare", "runtime"])}`;
    await new Promise<void>((resolve) => { const tx = db.transaction("keys", "readwrite"); tx.objectStore("keys").delete(key); tx.oncomplete = () => resolve(); });
    let rejected = false; try { await secure.read("purr/prepare/runtime/history/new/response-snapshot"); } catch { rejected = true; }
    const stillMissing = await new Promise<boolean>((resolve) => { const request = db.transaction("keys").objectStore("keys").get(key); request.onsuccess = () => resolve(request.result === undefined); }); db.close();
    return { rejected, stillMissing };
  });
  expect(result).toEqual({ rejected: true, stillMissing: true });
});

test("runtime capability stays independent of damaged rows and missing credential keys", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const path = "/src/storage/browser-backend.ts"; const { BrowserPersistenceBackend, BrowserSecureStore } = await import(path);
    const backend = new BrowserPersistenceBackend(); const secure = new BrowserSecureStore();
    await backend.commit("capabilities", [], [{ table: "drafts", id: "bad", value: "private" }]);
    await secure.set("purr/capabilities/credentials/password", "synthetic");
    const db = await new Promise<IDBDatabase>((resolve) => { const open = indexedDB.open("purr-preview-v4"); open.onsuccess = () => resolve(open.result); });
    await new Promise<void>((resolve) => { const tx = db.transaction(["keys", "local"], "readwrite"); tx.objectStore("keys").delete(`key/${JSON.stringify(["workspace", "capabilities", "credentials"])}`); const store = tx.objectStore("local"); const request = store.get("capabilities"); request.onsuccess = () => { request.result.records[0].envelope.data = new Uint8Array([0]).buffer; store.put(request.result, "capabilities"); }; tx.oncomplete = () => resolve(); });
    const corrupt = await backend.loadWorkspace("capabilities");
    await new Promise<void>((resolve) => { const tx = db.transaction("keys", "readwrite"); tx.objectStore("keys").delete(`key/${JSON.stringify(["workspace", "capabilities", "runtime"])}`); tx.oncomplete = () => resolve(); }); db.close();
    const missing = await backend.loadWorkspace("capabilities"); return { corrupt, missing };
  });
  expect(result.corrupt.protectedState.status).toBe("corrupt"); expect(result.corrupt.runtimeProtectedState).toEqual({ status: "available" });
  expect(result.missing.runtimeProtectedState).toEqual({ status: "unavailable", code: "browser-scope-key-missing" });
});
