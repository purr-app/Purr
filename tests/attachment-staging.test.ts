import { test } from "node:test";
import assert from "node:assert/strict";
import { AttachmentPreparation, decodeFiles, encodeFiles, getLocalAttachmentReference, type FileAttachmentRecord, type NativeFileAttachmentRecord } from "../src/storage/file-codec";
import { WorkspacePersistence } from "../src/application/workspace-persistence";
import { RequestHistory } from "../src/application/request-history";
import type { HistoryEntry, HistoryPort } from "../src/application/ports/history";
import { MemorySecureStore } from "../src/storage/secrets";
import { createHttpDocument, createWorkspace } from "../src/features/workspaces/model/workspace";
import { MemoryPersistenceBackend } from "./helpers/memory-persistence";
import { attachmentStagingFixture } from "./fixtures/attachment-staging";

const attachment = () => {
  const file = new File([new Uint8Array(256 * 1024 * 2 + 17).fill(37)], "synthetic.bin", { lastModified: 123 });
  Object.defineProperty(file, "arrayBuffer", { value: () => { throw new Error("Whole-file reads are forbidden for native persistence"); } });
  return file;
};
const records = () => new Map<string, FileAttachmentRecord | NativeFileAttachmentRecord>();

test("native preparation streams bounded binary chunks and deduplicates the same File in one workspace publication", async () => {
  const fixture = attachmentStagingFixture();
  const preparation = new AttachmentPreparation("workspace", fixture.port);
  const file = attachment(); const attachments = records();
  const encoded = await encodeFiles({ first: file, copies: [file, file] }, attachments, preparation);
  assert.equal(attachments.size, 1);
  assert.deepEqual(fixture.lengths, [256 * 1024, 256 * 1024, 17]);
  assert.equal(fixture.events.filter((event) => event === "begin").length, 1);
  assert.doesNotMatch(JSON.stringify(encoded), /base64|synthetic/);
  assert.equal(getLocalAttachmentReference(file), undefined, "the original File remains usable after a failed publication");
  assert.equal(fixture.stages.size, 1, "ready data remains staged until publication completes");
  await preparation.dispose(); assert.equal(fixture.stages.size, 0);
});

test("a lost begin or finish reply aborts its caller-known stage and a fresh preparation can retry", async () => {
  for (const failure of ["begin", "finish"] as const) {
    const fixture = attachmentStagingFixture(); const file = attachment();
    const port = { ...fixture.port, [failure]: async (...args: never[]) => {
      await (fixture.port[failure] as (...args: never[]) => Promise<unknown>)(...args);
      throw new Error("Reply lost");
    } };
    const preparation = new AttachmentPreparation("workspace", port);
    await assert.rejects(encodeFiles(file, records(), preparation), /Reply lost/);
    await preparation.dispose(); assert.equal(fixture.stages.size, 0);
    const retry = new AttachmentPreparation("workspace", fixture.port);
    await encodeFiles(file, records(), retry); await retry.dispose();
    assert.equal(fixture.stages.size, 0);
  }
});

test("lazy version 2 files reuse their workspace reference without reading bytes", async () => {
  const fixture = attachmentStagingFixture();
  const file = decodeFiles({ __purrFileRef: "existing" }, new Map([["existing", { version: 2, native: true, name: "saved.bin", type: "", size: 123, lastModified: 0 }]]), "workspace", async () => { throw new Error("Must stay lazy"); }) as File;
  const preparation = new AttachmentPreparation("workspace", fixture.port);
  assert.deepEqual(await encodeFiles(file, records(), preparation), { __purrFileRef: "existing" });
  assert.deepEqual(fixture.events, []);
  await preparation.dispose();
});

test("autosave stages inactive draft files and cleans stages after durable publication or commit failure", async () => {
  for (const failCommit of [false, true]) {
    const fixture = attachmentStagingFixture(); const secure = new MemorySecureStore();
    const backend = Object.assign(new MemoryPersistenceBackend(secure), { attachments: fixture.port });
    const originalCommit = backend.commit.bind(backend);
    backend.commit = async (...args) => {
      assert.equal(fixture.stages.size, 1);
      const local = args[2]; const record = local.find((row) => row.table === "attachments")!;
      assert.equal((record.value as NativeFileAttachmentRecord).version, 2);
      assert.doesNotMatch(JSON.stringify(local), /base64/);
      if (failCommit) throw new Error("Publication failed");
      return originalCommit(...args);
    };
    const persistence = new WorkspacePersistence(backend, secure);
    const workspace = createWorkspace("Test", "workspace"); const document = createHttpDocument();
    const file = attachment(); document.request.body.binary = { file, name: file.name, size: file.size, mimeType: file.type };
    workspace.documents = [document];
    if (failCommit) await assert.rejects(persistence.saveWorkspace(workspace), /Publication failed/);
    else await persistence.saveWorkspace(workspace);
    assert.equal(fixture.stages.size, 0);
    assert.equal(document.request.body.binary.file, file);
  }
});

test("history stages attachments without base64 and holds stages through append", async () => {
  const fixture = attachmentStagingFixture(); const secure = new MemorySecureStore();
  let stored: HistoryEntry | undefined;
  const port = { attachments: fixture.port, append: async (_workspace: string, entry: HistoryEntry) => {
    assert.equal(fixture.stages.size, 1); stored = entry;
  } } as HistoryPort;
  const history = new RequestHistory(port, secure, (work) => work());
  const editor = createHttpDocument().request; const file = attachment();
  editor.body.binary = { file, name: file.name, size: file.size, mimeType: file.type };
  await history.append("workspace", { documentId: "request", name: "Request", kind: "http", editor, response: null, error: "", outcome: "cancelled", startedAt: 1, durationMs: 1 });
  assert.ok(stored); assert.equal(Object.keys(stored.files).length, 1);
  assert.doesNotMatch(JSON.stringify(stored), /base64/);
  assert.equal(fixture.stages.size, 0);
});


test("Tauri attachment adapter sends raw ArrayBuffers with scoped headers, never JSON byte arrays", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const calls: { command: string; args: unknown; options: unknown }[] = [];
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: {
      invoke: async (command: string, args: unknown, options: unknown) => { calls.push({ command, args, options }); },
    } } });
    const { tauriAttachments } = await import("../src/platform/tauri/attachments");
    const bytes = new Uint8Array([0, 255, 37]).buffer;
    await tauriAttachments.begin("workspace", "stage", { name: "file.bin", type: "application/octet-stream", size: 3, lastModified: 1 });
    await tauriAttachments.append("workspace", "stage", 0, bytes);
    await tauriAttachments.finish("workspace", "stage");
    await tauriAttachments.abort("workspace", "stage");
    assert.deepEqual(calls.map((call) => call.command), ["attachment_begin", "attachment_append", "attachment_finish", "attachment_abort"]);
    assert.equal(calls[1].args, bytes);
    assert.deepEqual(calls[1].options, { headers: { "x-purr-workspace": "workspace", "x-purr-stage": "stage", "x-purr-index": "0" } });
    assert.deepEqual(calls[0].args, { workspaceId: "workspace", stageId: "stage", name: "file.bin", mediaType: "application/octet-stream", size: 3, lastModified: 1 });
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
});


test("autosave reuses confirmed File identity only while its attachment owner still exists", async () => {
  const fixture = attachmentStagingFixture(); const secure = new MemorySecureStore();
  const backend = Object.assign(new MemoryPersistenceBackend(secure), { attachments: fixture.port });
  const persistence = new WorkspacePersistence(backend, secure);
  const workspace = createWorkspace("Test", "workspace"); const document = createHttpDocument();
  const file = attachment(); const binary = { file, name: file.name, size: file.size, mimeType: file.type };
  document.request.body.binary = binary; workspace.documents = [document];
  await persistence.saveWorkspace(workspace);
  await persistence.saveWorkspace(workspace);
  assert.equal(fixture.events.filter((event) => event === "begin").length, 1);
  document.request.body.binary = null;
  await persistence.saveWorkspace(workspace);
  document.request.body.binary = binary;
  await persistence.saveWorkspace(workspace);
  assert.equal(fixture.events.filter((event) => event === "begin").length, 2, "a released attachment is staged again before reuse");
});


test("external reconciliation preserves exact draft Files without staging or reading whole bytes", async () => {
  const fixture = attachmentStagingFixture(); const secure = new MemorySecureStore();
  const backend = Object.assign(new MemoryPersistenceBackend(secure), { attachments: fixture.port });
  const persistence = new WorkspacePersistence(backend, secure);
  const workspace = createWorkspace("Test", "workspace"); const document = createHttpDocument();
  workspace.documents = [document];
  await persistence.saveWorkspace(workspace);
  const file = attachment();
  document.request.body.binary = { file, name: file.name, size: file.size, mimeType: file.type };
  const manifest = backend.snapshot.workspaces[0].files["purr.yaml"];
  manifest.content += "\n# external edit\n"; manifest.revision = "external-revision";
  const reconciled = await persistence.reconcileExternalChanges({ activeWorkspaceId: workspace.id, workspaces: [workspace], globalVariables: [] });
  const restored = reconciled.workspaces[0].documents.find((item) => item.id === document.id)!;
  assert.ok("request" in restored);
  assert.equal(restored.request.body.binary?.file, file);
  assert.deepEqual(fixture.events, [], "reconciliation must not create unpublished attachment stages");
  await persistence.saveWorkspace(reconciled.workspaces[0]);
  assert.equal(fixture.events.filter((event) => event === "begin").length, 1, "normal autosave stages the original File after reconciliation");
});
