import assert from "node:assert/strict";
import { test } from "node:test";
import { SecretTransferError, validTransferPassword } from "../src/application/ports/secret-transfer";
import { unavailableSecretTransfer } from "../src/storage/unavailable-secret-transfer";

test("transfer passwords count Unicode characters and bound UTF-8 bytes without trimming", () => {
  assert.equal(validTransferPassword("a".repeat(11)), false);
  assert.equal(validTransferPassword("a".repeat(12)), true);
  assert.equal(validTransferPassword("🐈".repeat(6)), false);
  assert.equal(validTransferPassword("🐈".repeat(12)), true);
  assert.equal(validTransferPassword("🐈".repeat(256)), true);
  assert.equal(validTransferPassword("🐈".repeat(257)), false);
  assert.equal(validTransferPassword(" a password "), true);
});

test("preview adapter rejects secret transfer instead of substituting browser crypto", async () => {
  assert.equal(unavailableSecretTransfer.available, false);
  await assert.rejects(unavailableSecretTransfer.inventory("workspace"), /desktop app/);
  await assert.rejects(unavailableSecretTransfer.revealPreviewValue({ workspaceId: "workspace", previewId: "preview", reference: "ref" }), /desktop app/);
  await assert.rejects(unavailableSecretTransfer.selectRecoveryFiles("workspace"), /desktop app/);
  await assert.rejects(unavailableSecretTransfer.selectImportFile("workspace"), /desktop app/);
  await assert.rejects(unavailableSecretTransfer.prepareImport({ workspaceId: "workspace", stagedId: "staged", password: "synthetic password" }), /desktop app/);
  await assert.rejects(unavailableSecretTransfer.exportSelected({ workspaceId: "workspace", references: [], omittedRefs: [], password: "synthetic password" }), /desktop app/);
});

test("native transfer validates metadata and preserves published outcome when cancel loses race", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const actions: Record<string, unknown>[] = [];
  let finish: ((value: unknown) => void) | undefined;
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: {
      invoke: async (_command: string, args: { action: Record<string, unknown> }) => {
        actions.push(args.action);
        if (args.action.type === "inventory") return { items: [{ ref: "ref", owners: [], status: "invented-status" }], publicValueCount: 0, dependencies: [] };
        if (args.action.type === "cancel") return;
        if (args.action.type === "revealPreviewValue") return args.action.reference === "ref" ? "incoming-secret" : { value: "wrong-shape" };
        return new Promise((resolve) => { finish = resolve; });
      },
    } } });
    const { nativeSecretTransfer } = await import("../src/platform/tauri/secret-transfer");
    await assert.rejects(nativeSecretTransfer.inventory("workspace"));
    assert.equal(await nativeSecretTransfer.revealPreviewValue({ workspaceId: "workspace", previewId: "preview", reference: "ref" }), "incoming-secret");
    assert.deepEqual(actions.at(-1), { type: "revealPreviewValue", workspaceId: "workspace", previewId: "preview", reference: "ref" });
    await assert.rejects(nativeSecretTransfer.revealPreviewValue({ workspaceId: "workspace", previewId: "preview", reference: "bad" }));
    const controller = new AbortController();
    const pending = nativeSecretTransfer.exportRecoveryKey({ workspaceId: "workspace", password: "synthetic password" }, controller.signal);
    controller.abort();
    finish!({ status: "written" });
    assert.deepEqual(await pending, { status: "written" });
    assert.equal(actions.find((entry) => entry.type === "cancel")?.operationId, actions.find((entry) => entry.type === "exportRecoveryKey")?.operationId);
    const count = actions.length;
    await assert.rejects(nativeSecretTransfer.prepareImport({ workspaceId: "workspace", stagedId: "staged", password: "synthetic password" }, controller.signal));
    assert.equal(actions.length, count);
    const selectionController = new AbortController();
    const selecting = nativeSecretTransfer.selectImportFile("workspace", selectionController.signal);
    selectionController.abort();
    finish!({ id: "late-file", name: "selected.purrsecrets" });
    assert.equal(await selecting, null);
    assert.ok(actions.some((entry) => entry.type === "cancel" && entry.previewId === "late-file"));
    const selectingRecovery = nativeSecretTransfer.selectRecoveryFiles("workspace");
    finish!({ id: "recovery-files", keyName: "key.purrsecrets", backupName: "backup.purrsecrets" });
    assert.deepEqual(await selectingRecovery, { id: "recovery-files", keyName: "key.purrsecrets", backupName: "backup.purrsecrets" });
    const preparingRecovery = nativeSecretTransfer.prepareRecovery({ workspaceId: "workspace", stagedId: "recovery-files", keyPassword: "key password", backupPassword: "backup password" });
    assert.equal(actions.at(-1)?.stagedId, "recovery-files");
    assert.equal(actions.at(-1)?.type, "prepareRecovery");
    finish!({ id: "recovery-preview", workspaceId: "workspace", expiresAt: Date.now() + 300000, items: [], omissions: [], dependencies: [] });
    assert.equal((await preparingRecovery)?.id, "recovery-preview");
    const recoveryController = new AbortController();
    const recoverySelection = nativeSecretTransfer.selectRecoveryFiles("workspace", recoveryController.signal);
    recoveryController.abort();
    finish!({ id: "late-recovery", keyName: "key.purrsecrets", backupName: "backup.purrsecrets" });
    assert.equal(await recoverySelection, null);
    assert.ok(actions.some((entry) => entry.type === "cancel" && entry.previewId === "late-recovery"));
    const prepareController = new AbortController();
    const preparing = nativeSecretTransfer.prepareImport({ workspaceId: "workspace", stagedId: "staged", password: "synthetic password" }, prepareController.signal);
    prepareController.abort();
    finish!({ id: "late-preview", workspaceId: "workspace", expiresAt: Date.now() + 300000, items: [], omissions: [], dependencies: [] });
    assert.equal(await preparing, null);
    assert.ok(actions.some((entry) => entry.type === "cancel" && entry.previewId === "late-preview"));
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else delete (globalThis as { window?: unknown }).window;
  }
});


test("native transfer exposes only recognized failure codes as typed actionable errors", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: {
      invoke: async (_command: string, args: { action: { type: string } }) => {
        if (args.action.type === "selectRecoveryFiles") throw "recovery-files-invalid";
        throw new Error("recovery-backup-unlock-failed");
      },
    } } });
    const { nativeSecretTransfer } = await import("../src/platform/tauri/secret-transfer");
    await assert.rejects(nativeSecretTransfer.selectRecoveryFiles("workspace"), (error: unknown) => error instanceof SecretTransferError && error.code === "recovery-files-invalid");
    await assert.rejects(nativeSecretTransfer.prepareRecovery({ workspaceId: "workspace", stagedId: "stage", keyPassword: "synthetic-password", backupPassword: "synthetic-password" }), (error: unknown) => error instanceof SecretTransferError && error.code === "recovery-backup-unlock-failed");
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else delete (globalThis as { window?: unknown }).window;
  }
});
