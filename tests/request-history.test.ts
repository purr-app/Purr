import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestHistory } from "../src/application/request-history";
import { BrowserHistory } from "../src/storage/browser-history";
import { MemorySecureStore } from "../src/storage/secrets";
import { initialRequestDraft } from "../src/features/request-workbench/model/request";
import { cloneRequestDraft, createWorkspace } from "../src/features/workspaces/model/workspace";
import type { HistoryEntry } from "../src/application/ports/history";
import { WorkspacePersistence } from "../src/application/workspace-persistence";
import { MemoryPersistenceBackend } from "./helpers/memory-persistence";

function fixture() {
  const values = new Map<string, unknown>(); const deletedSecrets: string[] = [];
  const port = new BrowserHistory({
    read: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    write: async (changes) => { for (const change of changes) if (change.value === undefined) values.delete(change.key); else values.set(change.key, structuredClone(change.value)); },
    legacy: async () => [],
    deleteSecrets: async (prefix) => { deletedSecrets.push(prefix); },
  });
  const secure = new MemorySecureStore(); let queue: Promise<unknown> = Promise.resolve();
  const service = new RequestHistory(port, secure, (work) => { const next = queue.then(work); queue = next.catch(() => {}); return next; });
  return { service, port, values, deletedSecrets, secure };
}
const execution = (startedAt = Date.now()) => ({ documentId: "document", name: "A request", kind: "http" as const,
  editor: cloneRequestDraft(initialRequestDraft), response: null, error: "Connection refused", outcome: "error" as const, startedAt, durationMs: 20 });

test("history captures immutable editor snapshots independently of later edits and protects credentials", async () => {
  const { service, values } = fixture(); const sent = execution();
  sent.editor.auth.bearer.token = "historical-secret";
  const pending = service.append("workspace", sent);
  sent.editor.url = "https://changed.example";
  sent.editor.auth.bearer.token = "replacement-secret";
  await pending;
  const page = await service.list("workspace"); assert.equal(page.items.length, 1);
  const stored = [...values.values()].find((value) => (value as HistoryEntry)?.version === 1) as HistoryEntry;
  assert.ok(stored); assert.doesNotMatch(JSON.stringify(stored), /historical-secret|replacement-secret/);
  const opened = await service.read("workspace", page.items[0].id);
  assert.equal(opened?.editor?.url, initialRequestDraft.url);
  assert.equal(opened?.editor?.auth.bearer.token, "historical-secret");
  opened!.editor!.url = "https://another-edit.example";
  assert.equal((await service.read("workspace", page.items[0].id))?.editor?.url, initialRequestDraft.url);
});

test("history metadata pagination searches all entries, remains workspace scoped, and never returns payloads", async () => {
  const { service } = fixture(); const now = Date.now();
  for (let i = 0; i < 6; i++) await service.append("workspace", { ...execution(now - i), name: i % 2 ? "needle" : "other" });
  await service.append("different", { ...execution(), name: "needle" });
  const first = await service.list("workspace", { search: "needle", limit: 2 });
  assert.equal(first.items.length, 2); assert.ok(first.cursor);
  assert.ok(first.items.every((item) => !("editor" in item) && !("files" in item) && !("response" in item)));
  const second = await service.list("workspace", { search: "needle", limit: 2, cursor: first.cursor! });
  assert.equal(second.items.length, 1); assert.equal(second.cursor, null);
  assert.ok(!first.items.some((a) => a.id === second.items[0].id));
});

test("pin protects automatic retention but manual removal deletes pinned records and their credential namespace", async () => {
  const { service, deletedSecrets } = fixture(); const old = Date.now() - 40 * 86400000;
  await service.settings("workspace", 60);
  await service.append("workspace", execution(old));
  await service.append("workspace", { ...execution(old + 1), documentId: "deleted-draft" });
  const before = await service.list("workspace"); const pinned = before.items[0];
  await service.pin("workspace", pinned.id, true);
  await service.settings("workspace", 30);
  assert.deepEqual((await service.list("workspace")).items.map((item) => item.id), [pinned.id]);
  assert.equal((await service.settings("different")).retentionDays, 30);
  await service.remove("workspace", { id: pinned.id });
  assert.equal((await service.list("workspace")).items.length, 0);
  assert.ok(deletedSecrets.includes(`purr/workspace/history/${pinned.id}/`));
});

test("history retains file bytes when source document is absent", async () => {
  const { service } = fixture(); const sent = execution();
  const file = new File(["retained upload"], "upload.txt", { type: "text/plain" });
  sent.editor.body.binary = { file, name: file.name, size: file.size, mimeType: file.type };
  await service.append("workspace", sent);
  const item = (await service.list("workspace")).items[0];
  const opened = await service.read("workspace", item.id);
  assert.equal(await opened?.editor?.body.binary.file?.text(), "retained upload");
});

test("history append does not get lost behind autosave and deleting a document retains global history", async () => {
  const backend = new MemoryPersistenceBackend(); const history = fixture().port;
  const persistence = new WorkspacePersistence(Object.assign(backend, { history }), new MemorySecureStore());
  const workspace = createWorkspace("Test", "workspace");
  await persistence.save({ activeWorkspaceId: workspace.id, workspaces: [workspace] });
  const document = workspace.documents.find((document) => document.kind === "http");
  await Promise.all([persistence.history!.append("workspace", execution()), persistence.history!.append("workspace", execution()), persistence.save({ activeWorkspaceId: workspace.id, workspaces: [workspace] })]);
  workspace.documents = workspace.documents.filter((candidate) => candidate.id !== document?.id);
  await persistence.save({ activeWorkspaceId: workspace.id, workspaces: [workspace] });
  assert.equal((await persistence.history!.list("workspace")).items.length, 2);
  assert.ok(!(await backend.readLocal("workspace")).some((record) => record.table === "request_executions"));
});

test("native response history retains the opaque content reference instead of materialized preview bytes", async () => {
  const { service, values } = fixture(); const startedAt = Date.now();
  const request = { url: "https://example.com", method: "GET", headers: [], bodyBase64: null };
  const timeline = { startedAtMs: startedAt, completedAtMs: startedAt + 10, prepareMs: 1, waitingMs: 3, downloadMs: 6,
    request, followRedirects: true, usesCookieJar: true, timeoutMs: 30000 };
  const exchange = { protocolVersion: 2 as const, request, response: { url: request.url, status: 200, statusText: "OK", headers: [], byteLength: 1024 * 1024, durationMs: 9 },
    content: { id: "opaque-native-reference", byteLength: 1024 * 1024, complete: true }, timeline };
  await service.append("workspace", { ...execution(), response: { url: request.url, status: 200, statusText: "OK", headers: [], bodyBase64: "eA==", text: "preview", size: exchange.content.byteLength, durationMs: 9, timeline, sourceExchange: exchange }, outcome: "response" });
  const item = (await service.list("workspace")).items[0];
  assert.equal(item.startedAt, startedAt); assert.equal(item.durationMs, 9);
  assert.equal(item.size, 1024 * 1024);
  assert.deepEqual(await service.existing("workspace", [item.id, "missing"]), [item.id]);
  const stored = [...values.values()].find((value) => (value as HistoryEntry)?.version === 1) as HistoryEntry;
  assert.deepEqual(stored.response, exchange);
  await service.remove("workspace", { id: item.id });
  assert.deepEqual(await service.existing("workspace", [item.id]), []);
});

test("a pending execution retains native attachments through source draft deletion until history adopts them", async () => {
  const backend = new MemoryPersistenceBackend(); const { port } = fixture();
  const nativeAppend = port.append.bind(port);
  port.append = async (workspaceId, entry) => {
    // Mirror native adoption: retained history files get their own ownership,
    // while the editor snapshot sends only metadata for a native attachment.
    const local = await backend.readLocal(workspaceId);
    const files = Object.fromEntries(Object.entries(entry.files).map(([id, value]) => {
      if ((value as { native?: boolean }).native) {
        const source = local.find((record) => record.table === "attachments" && record.id === id);
        assert.ok(source, "the source file must survive until history adoption");
        return [id, source.value];
      }
      return [id, value];
    }));
    await nativeAppend(workspaceId, { ...entry, files });
  };
  const persistence = new WorkspacePersistence(Object.assign(backend, { history: port }), new MemorySecureStore());
  const workspace = createWorkspace("Test", "workspace");
  const { createHttpDocument } = await import("../src/features/workspaces/model/workspace");
  const { decodeFiles, getLocalAttachmentReference } = await import("../src/storage/file-codec");
  const draft = createHttpDocument();
  const file = new File(["native file retained"], "native.txt", { type: "text/plain" });
  draft.request.body.binary = { file, name: file.name, size: file.size, mimeType: file.type };
  workspace.documents = [draft];
  const save = () => persistence.save({ activeWorkspaceId: workspace.id, workspaces: [workspace] });
  await save();
  const attachment = (await backend.readLocal("workspace")).find((record) => record.table === "attachments")!;
  const stored = attachment.value as { base64: string; name: string; type: string; lastModified: number; size: number };
  let loads = 0;
  const nativeFile = decodeFiles({ __purrFileRef: attachment.id }, new Map([[attachment.id, { ...stored, base64: undefined, native: true, version: 1 }]]), "workspace", async () => { loads += 1; return new TextEncoder().encode("native file retained"); }) as File;
  assert.ok(getLocalAttachmentReference(nativeFile));
  draft.request.body.binary.file = nativeFile;
  const release = persistence.history!.retainAttachments("workspace");
  const otherRelease = persistence.history!.retainAttachments("workspace");
  workspace.documents = [];
  await save();
  assert.ok((await backend.readLocal("workspace")).some((record) => record.table === "attachments"));
  await persistence.history!.append("workspace", { ...execution(), editor: draft.request });
  release(); release();
  assert.equal(persistence.history!.hasPendingExecutions("workspace"), true);
  otherRelease();
  await save();
  assert.equal(persistence.history!.hasPendingExecutions("workspace"), false);
  assert.equal((await backend.readLocal("workspace")).some((record) => record.table === "attachments"), false);
  const entry = (await persistence.history!.list("workspace")).items[0];
  assert.equal(await (await persistence.history!.read("workspace", entry.id))?.editor?.body.binary?.file.text(), "native file retained");
  assert.equal(loads, 0, "native history adoption must not read upload bytes into JavaScript");
});
