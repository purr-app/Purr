import { expect, test, type Page } from "@playwright/test";

/** Native IPC contract backed by isolated real IndexedDB; HTTP is synthetic. */
async function installPublicModeBridge(page: Page, denyFreshKeys = false) {
  await page.addInitScript(({ denyFreshKeys }) => {
    const state = window as any;
    state.isTauri = true; state.__publicRequests = []; state.__publicCommits = [];
    if (denyFreshKeys) crypto.subtle.generateKey = () => Promise.reject(new Error("SYNTHETIC_KEY_PROVIDER_UNAVAILABLE"));
    let storage: Promise<any> | undefined;
    const adapters = () => storage ??= (async () => {
      const path = "/src/storage/browser-backend.ts"; const { BrowserPersistenceBackend, BrowserSecureStore } = await import(path);
      return { backend: new BrowserPersistenceBackend(), secure: new BrowserSecureStore() };
    })();
    state.__TAURI_INTERNALS__ = { transformCallback: () => 1, invoke: async (command: string, args: any) => {
      if (command === "plugin:event|listen") return 1;
      if (command === "start_http") { state.__publicRequests.push(args.request); return { status: 200, statusText: "OK", headers: [["Content-Type", "application/json"]], durationMs: 1, bodyBase64: btoa('{"public":true}') }; }
      const { backend, secure } = await adapters();
      if (command === "load_persistence" || command === "retry_protected_storage") return backend.load();
      if (command === "load_project") return backend.loadWorkspace(args.id);
      if (command === "commit_project") {
        state.__publicCommits.push(structuredClone(args));
        const files = await backend.commit(args.id, args.files, args.local, args.secrets);
        return Object.fromEntries(args.files.map((file: any) => [file.path, files[file.path] ?? null]));
      }
      if (command === "write_global_state") return backend.writeGlobal(args.local, args.secrets);
      if (command === "set_local_active_workspace") return backend.setActiveWorkspace(args.id);
      if (command === "finish_legacy_migration") return backend.finishMigration();
      if (command === "reload_project_file") return backend.reloadResource(args.id, args.path);
      if (command === "secure_read") return secure.read(args.reference);
      if (command === "secure_resolve") return secure.resolve(args.reference);
      if (command === "secure_operation_status") return secure.operationStatus(args.operationId);
      if (command === "secure_commit") return secure.commit(args.batch);
      if (command === "request_history") {
        const action = args.action;
        if (action.operation === "append") return backend.history.append(args.id, action.entry, action.secrets);
        if (action.operation === "prune") return backend.history.prune(args.id);
        if (action.operation === "list") return backend.history.list(args.id, action.query);
        if (action.operation === "read") return backend.history.read(args.id, action.id);
        if (action.operation === "existing") return backend.history.existing(args.id, action.ids);
        if (action.operation === "settings") return backend.history.settings(args.id, action.retentionDays);
        if (action.operation === "pin") return backend.history.pin(args.id, action.id, action.pinned);
      }
    } };
  }, { denyFreshKeys });
}
async function saveRequest(page: Page, name: string) {
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await page.getByLabel("Document name", { exact: true }).fill(name);
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("region", { name: "Workspace", exact: true })).toHaveAttribute("aria-busy", "false");
}

test("fresh startup, public editing, Send and history need no encryption key", async ({ page }) => {
  await installPublicModeBridge(page, true); await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("https://synthetic.test/public");
  await saveRequest(page, "Public without keys");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__publicRequests.length)).toBe(1);
  await expect(page.getByText("200 OK", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const path = "/src/storage/browser-backend.ts"; const { BrowserPersistenceBackend } = await import(path); const backend = new BrowserPersistenceBackend();
    return (await backend.history.list("personal", {})).items.length;
  })).toBe(1);
  const keys = await page.evaluate(() => new Promise<number>((resolve) => {
    const open = indexedDB.open("purr-preview-v4"); open.onsuccess = () => { const db = open.result; const request = db.transaction("keys").objectStore("keys").count(); request.onsuccess = () => { db.close(); resolve(request.result); }; };
  })); expect(keys).toBe(0);
  await page.reload(); await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("https://synthetic.test/public");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});

test("unavailable cookie jar blocks dispatch until both cookie operations are explicitly disabled", async ({ page }) => {
  await installPublicModeBridge(page); await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("https://synthetic.test/cookies"); await saveRequest(page, "Cookie dependency");
  const original = await page.evaluate(async () => {
    const path = "/src/storage/browser-backend.ts"; const { BrowserPersistenceBackend } = await import(path); const backend = new BrowserPersistenceBackend();
    await backend.writeLocal("personal", [{ table: "cookie_jar", id: "synthetic-cookie", protection: "encrypted", value: { id: "synthetic-cookie", name: "session", value: "SYNTHETIC_COOKIE", domain: "synthetic.test", path: "/", secure: false, httpOnly: false, sameSite: "", hostOnly: true, enabled: true } }]);
    const db = await new Promise<IDBDatabase>((resolve) => { const open = indexedDB.open("purr-preview-v4"); open.onsuccess = () => resolve(open.result); });
    const row = await new Promise<any>((resolve) => { const request = db.transaction("local").objectStore("local").get("personal"); request.onsuccess = () => resolve(request.result.records.find((row: any) => row.table === "cookie_jar")); });
    await new Promise<void>((resolve) => { const tx = db.transaction("keys", "readwrite"); tx.objectStore("keys").delete(`key/${JSON.stringify(["workspace", "personal", "runtime"])}`); tx.oncomplete = () => resolve(); }); db.close();
    return Array.from(new Uint8Array(row.envelope.data));
  });
  await page.reload();
  const send = page.getByRole("button", { name: "Send", exact: true }); await expect(send).toBeEnabled(); await send.click();
  await expect(page.getByText(/Cookie storage is unavailable/).first()).toBeVisible();
  expect(await page.evaluate(() => (window as any).__publicRequests.length)).toBe(0);
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Automatically send cookies", exact: true }).click(); await send.click();
  expect(await page.evaluate(() => (window as any).__publicRequests.length)).toBe(0);
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Automatically store cookies", exact: true }).click(); await send.click();
  await expect.poll(() => page.evaluate(() => (window as any).__publicRequests.length)).toBe(1);
  await expect(page.getByText("200 OK", { exact: true })).toBeVisible();
  const after = await page.evaluate(() => new Promise<number[]>((resolve) => {
    const open = indexedDB.open("purr-preview-v4"); open.onsuccess = () => { const db = open.result; const request = db.transaction("local").objectStore("local").get("personal"); request.onsuccess = () => { const row = request.result.records.find((row: any) => row.table === "cookie_jar"); db.close(); resolve(Array.from(new Uint8Array(row.envelope.data))); }; };
  })); expect(after).toEqual(original);
});

test("malformed local payload keeps canonical workspace navigable and never autosaves replacement defaults", async ({ page }) => {
  await installPublicModeBridge(page); await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("https://synthetic.test/canonical"); await saveRequest(page, "Corrupt local fixture");
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const open = indexedDB.open("purr-preview-v4"); open.onsuccess = () => resolve(open.result); });
    await new Promise<void>((resolve) => { const tx = db.transaction("local", "readwrite"); const store = tx.objectStore("local"); const request = store.get("personal"); request.onsuccess = () => { const row = request.result.records.find((row: any) => row.table === "workspace_local_state" && row.id === "state"); row.value = { version: 999, ui: ["unknown-future-shape"] }; store.put(request.result, "personal"); }; tx.oncomplete = () => resolve(); }); db.close();
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "GET Corrupt local fixture", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "GET Corrupt local fixture", exact: true }).click();
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("https://synthetic.test/canonical");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: /^Auth/ }).click(); await page.getByRole("tab", { name: /^Headers/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__publicCommits.filter((commit: any) => commit.id === "personal").length)).toBe(0);
  const row = await page.evaluate(() => new Promise<any>((resolve) => {
    const open = indexedDB.open("purr-preview-v4"); open.onsuccess = () => { const db = open.result; const request = db.transaction("local").objectStore("local").get("personal"); request.onsuccess = () => { db.close(); resolve(request.result.records.find((row: any) => row.table === "workspace_local_state" && row.id === "state").value); }; };
  })); expect(row).toEqual({ version: 999, ui: ["unknown-future-shape"] });
});

test("an unavailable document stays read-only while a public sibling can still autosave", async ({ page }) => {
  await installPublicModeBridge(page); await page.goto("/");
  await page.getByLabel("Request URL", { exact: true }).fill("https://synthetic.test/unavailable"); await saveRequest(page, "Unavailable document");
  const unavailableId = await page.evaluate(async () => {
    const path = "/src/storage/browser-backend.ts"; const { BrowserPersistenceBackend } = await import(path);
    return (await new BrowserPersistenceBackend().loadWorkspace("personal")).local.find((row: any) => row.table === "document_session_state")!.id;
  });
  await page.getByRole("button", { name: "New HTTP request", exact: true }).click();
  await page.getByLabel("Request URL", { exact: true }).fill("https://synthetic.test/sibling"); await saveRequest(page, "Public sibling");
  const original = await page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve) => { const open = indexedDB.open("purr-preview-v4"); open.onsuccess = () => resolve(open.result); });
    let original = "";
    await new Promise<void>((resolve) => { const tx = db.transaction("local", "readwrite"); const store = tx.objectStore("local"); const request = store.get("personal"); request.onsuccess = () => { const row = request.result.records.find((row: any) => row.table === "document_session_state" && row.id === id); row.version = 999; original = JSON.stringify(row); store.put(request.result, "personal"); }; tx.oncomplete = () => resolve(); }); db.close(); return original;
  }, unavailableId);
  await page.reload();
  await page.getByRole("button", { name: "GET Unavailable document", exact: true }).click();
  await expect(page.getByLabel("Request URL", { exact: true })).toHaveValue("https://synthetic.test/unavailable");
  await expect(page.getByLabel("Request URL", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "GET Public sibling", exact: true }).click();
  await expect(page.getByLabel("Request URL", { exact: true })).toBeEnabled();
  await page.getByLabel("Request URL", { exact: true }).fill("https://synthetic.test/sibling-edited");
  await expect.poll(() => page.evaluate(async () => {
    const path = "/src/storage/browser-backend.ts"; const { BrowserPersistenceBackend } = await import(path);
    return JSON.stringify((await new BrowserPersistenceBackend().loadWorkspace("personal")).local.filter((row: any) => row.table === "drafts"));
  })).toContain("sibling-edited");
  const after = await page.evaluate((id) => new Promise<string>((resolve) => {
    const open = indexedDB.open("purr-preview-v4"); open.onsuccess = () => { const db = open.result; const request = db.transaction("local").objectStore("local").get("personal"); request.onsuccess = () => { db.close(); resolve(JSON.stringify(request.result.records.find((row: any) => row.table === "document_session_state" && row.id === id))); }; };
  }), unavailableId); expect(after).toBe(original);
});
