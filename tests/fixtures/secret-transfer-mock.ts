import type { Page } from "@playwright/test";
import { installPersistenceMock } from "../ui/persistence-mock";

/** Protocol fixture only: archive crypto/filesystem tests live in Rust. */
export async function installSecretTransferMock(page: Page, options: { invalidImport?: boolean; delayedExport?: boolean; lostCommitReply?: boolean; expiredPreview?: boolean } = {}) {
  await installPersistenceMock(page);
  await page.addInitScript((options) => {
    const state = window as any;
    state.isTauri = true;
    state.__transferCalls = [];
    let cancelPending: (() => void) | undefined;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command !== "secret_transfer") return;
      const action = args.action;
      state.__transferCalls.push(action);
      if (action.type === "inventory") return {
        publicValueCount: 2, dependencies: ["GLOBAL_HOST"], items: [
          { ref: "saved-token", owners: ["Bearer token"], status: "available" },
          { ref: "saved-missing", owners: ["Missing password"], status: "missing" },
        ],
      };
      if (action.type === "cancel") { cancelPending?.(); return; }
      if (action.type.startsWith("export")) {
        if (options.delayedExport) return new Promise((resolve) => { cancelPending = () => resolve({ status: "cancelled" }); });
        return { status: "written" };
      }
      if (action.type === "selectImportFile") return { id: "synthetic-selected-file", name: "selected-secrets.purrsecrets" };
      if (action.type === "selectRecoveryFiles") return { id: "synthetic-recovery-files", keyName: "recovery-key.purrsecrets", backupName: "credential-backup.purrsecrets" };
      if (action.type === "prepareImport" || action.type === "prepareRecovery") {
        if (options.invalidImport) throw new Error("synthetic invalid package");
        return {
          id: "synthetic-preview", workspaceId: action.workspaceId, expiresAt: Date.now() + (options.expiredPreview ? -1 : 300000),
          items: [
            { ref: "new-token", owners: ["New token"], status: "missing" },
            { ref: "existing-token", owners: ["Existing token"], status: "existing" },
            { ref: "unknown-token", owners: ["Unknown token"], status: "unknown" },
          ], omissions: ["omitted-secret"], dependencies: ["ENV_SUFFIX"],
        };
      }
      if (action.type === "revealPreviewValue") {
        if (options.expiredPreview) throw new Error("Secret preview expired or unavailable");
        return `synthetic incoming ${action.reference}`;
      }
      if (action.type === "commitImport") {
        if (options.lostCommitReply) {
          const operations = JSON.parse(localStorage.getItem("purr-native-secure-operations-test") ?? "{}");
          operations[action.operationId] = { status: "committed" };
          localStorage.setItem("purr-native-secure-operations-test", JSON.stringify(operations));
          throw new Error("synthetic lost IPC reply");
        }
        return { operationId: action.operationId, status: "committed" };
      }
    } };
  }, options);
}
