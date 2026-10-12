import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/__scoped-storage-tests", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Synthetic scoped storage</title>" }));
  await page.goto("/__scoped-storage-tests");
});

test("missing known workspace key stays unavailable across Retry without affecting other workspaces", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const path = "/src/storage/browser-backend.ts"; const { BrowserPersistenceBackend } = await import(path);
    const backend = new BrowserPersistenceBackend();
    for (const id of ["alpha", "beta"]) await backend.commit(id, [{ path: "purr.yaml", content: `workspace-${id}`, expectedRevision: null }], [{ table: "drafts", id: "draft", value: `private-${id}` }]);
    const db = await new Promise<IDBDatabase>((resolve) => { const open = indexedDB.open("purr-preview-v3"); open.onsuccess = () => resolve(open.result); });
    const id = JSON.stringify(["workspace", "alpha", "runtime"]);
    await new Promise<void>((resolve) => { const tx = db.transaction("keys", "readwrite"); tx.objectStore("keys").delete(`key/${id}`); tx.oncomplete = () => resolve(); });
    const first = await backend.load(); const second = await backend.retryProtectedStorage();
    let rejected = false; try { await backend.writeLocal("alpha", [{ table: "drafts", id: "new", value: "must-not-publish" }]); } catch { rejected = true; }
    const after = await new Promise<unknown>((resolve) => { const request = db.transaction("keys").objectStore("keys").get(`key/${id}`); request.onsuccess = () => resolve(request.result); });
    db.close();
    return { first: first.workspaces, second: second.workspaces, rejected, missing: after === undefined };
  });
  for (const state of [result.first, result.second]) {
    const alpha = state.find((item: { id: string }) => item.id === "alpha")!; const beta = state.find((item: { id: string }) => item.id === "beta")!;
    expect(alpha.files["purr.yaml"].content).toBe("workspace-alpha"); expect(alpha.local).toEqual([]);
    expect(alpha.protectedState).toEqual({ status: "unavailable", code: "browser-scope-key-missing" });
    expect(beta.protectedState).toEqual({ status: "available" }); expect(beta.local[0].value).toBe("private-beta");
  }
  expect(result.rejected).toBe(true); expect(result.missing).toBe(true);
});

test("preview rejects copied envelopes and atomically rejects stale secret plus file publication", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const path = "/src/storage/browser-backend.ts"; const { BrowserPersistenceBackend, BrowserSecureStore } = await import(path);
    const backend = new BrowserPersistenceBackend(); const secure = new BrowserSecureStore();
    const ref = "purr/alpha/credentials/auth/password"; const other = "purr/beta/credentials/auth/password";
    await secure.set(ref, "A"); await secure.set(other, "B");
    const files = await backend.commit("alpha", [{ path: "purr.yaml", content: "old", expectedRevision: null }], []);
    const stale = await secure.read(ref); await secure.set(ref, "A-new");
    const operationId = crypto.randomUUID(); let failed = false;
    try { await backend.commit("alpha", [{ path: "purr.yaml", content: "must-not-publish", expectedRevision: files["purr.yaml"].revision }], [],
      { operationId, mutations: [{ ref, scope: { owner: "workspace", workspaceId: "alpha", kind: "credentials" }, expectedRevision: stale.revision, value: "A-stale" }] }); } catch { failed = true; }
    const db = await new Promise<IDBDatabase>((resolve) => { const open = indexedDB.open("purr-preview-v3"); open.onsuccess = () => resolve(open.result); });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("secrets", "readwrite"); const store = tx.objectStore("secrets"); const request = store.get(ref);
      request.onsuccess = () => store.put(request.result, other); tx.oncomplete = () => resolve();
    }); db.close();
    return { failed, value: await secure.get(ref), file: (await backend.loadWorkspace("alpha")).files["purr.yaml"].content,
      receipt: await secure.operationStatus(operationId), copied: await secure.resolve(other) };
  });
  expect(result.failed).toBe(true); expect(result.value).toBe("A-new"); expect(result.file).toBe("old");
  expect(result.receipt.status).toBe("aborted"); expect(result.copied).toEqual({ status: "corrupt", code: "browser-protected-scope-mismatch", retryable: false });
});

test("runtime credential snapshots survive reload independently of live saved credentials and old preview remains untouched", async ({ page }) => {
  const refs = await page.evaluate(async () => {
    localStorage.setItem("purr.workspaces.v1", "synthetic-old-preview-untouched");
    const path = "/src/storage/browser-backend.ts"; const { BrowserSecureStore, BrowserPersistenceBackend } = await import(path);
    const helpers = "/src/storage/secrets.ts"; const { protectRuntime, SecretPreparationStore } = await import(helpers);
    const authPath = "/src/features/request-workbench/model/request-auth.ts"; const { createRequestAuth } = await import(authPath);
    const secure = new BrowserSecureStore(); const ref = "purr/alpha/credentials/auth/password"; await secure.set(ref, "dispatched-A");
    const auth = createRequestAuth(); auth.type = "basic"; auth.basic.password = "dispatched-A";
    auth.credentialStates = { password: { ref, status: "available", edit: { kind: "keep" } } };
    const staged = new SecretPreparationStore(secure); await protectRuntime(auth, staged, "alpha", "history/entry/request/auth");
    const batch = await staged.batch(); await secure.commit(batch); await secure.set(ref, "live-B");
    const backend = new BrowserPersistenceBackend(); const loaded = await backend.load(); await backend.finishMigration();
    return { ref, runtime: batch.mutations[0].ref, legacy: loaded.legacy ?? null };
  });
  await page.reload();
  const result = await page.evaluate(async ({ ref, runtime }) => {
    const path = "/src/storage/browser-backend.ts"; const { BrowserSecureStore } = await import(path); const secure = new BrowserSecureStore();
    return { live: await secure.get(ref), historical: await secure.get(runtime), old: localStorage.getItem("purr.workspaces.v1") };
  }, refs);
  expect(refs.runtime).toContain("purr/alpha/runtime/history/"); expect(refs.legacy).toBeNull();
  expect(result).toEqual({ live: "live-B", historical: "dispatched-A", old: "synthetic-old-preview-untouched" });
});


test("credential-only key loss isolates its workspace before startup autosave", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const path = "/src/storage/browser-backend.ts"; const { BrowserPersistenceBackend, BrowserSecureStore } = await import(path);
    const backend = new BrowserPersistenceBackend(); const secure = new BrowserSecureStore();
    for (const id of ["alpha", "beta"]) {
      await backend.commit(id, [{ path: "purr.yaml", content: `workspace-${id}`, expectedRevision: null }], []);
      await secure.set(`purr/${id}/credentials/auth/password`, `synthetic-${id}`);
    }
    const db = await new Promise<IDBDatabase>((resolve) => { const open = indexedDB.open("purr-preview-v3"); open.onsuccess = () => resolve(open.result); });
    const key = `key/${JSON.stringify(["workspace", "alpha", "credentials"])}`;
    await new Promise<void>((resolve) => { const tx = db.transaction("keys", "readwrite"); tx.objectStore("keys").delete(key); tx.oncomplete = () => resolve(); });
    const snapshot = await backend.load(); const retried = await backend.retryProtectedStorage();
    const stillMissing = await new Promise<boolean>((resolve) => { const request = db.transaction("keys").objectStore("keys").get(key); request.onsuccess = () => resolve(request.result === undefined); });
    db.close(); return { snapshot, retried, stillMissing };
  });
  for (const snapshot of [result.snapshot, result.retried]) {
    expect(snapshot.protectedState).toEqual({ status: "available" });
    expect(snapshot.workspaces.find((item: { id: string }) => item.id === "alpha")?.protectedState).toEqual({ status: "unavailable", code: "browser-scope-key-missing" });
    expect(snapshot.workspaces.find((item: { id: string }) => item.id === "beta")?.protectedState).toEqual({ status: "available" });
  }
  expect(result.stillMissing).toBe(true);
});
