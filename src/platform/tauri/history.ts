import { tauriAttachments } from "./attachments";
import { invoke } from "@tauri-apps/api/core";
import type { HistoryPort } from "../../application/ports/history";
import { commitRejection, isCommitRejected, RecoveryRequiredError, type CommitState, type SecretBatch } from "../../application/ports/credentials";

const command = <T>(id: string, operation: string, args: object = {}) =>
  invoke<T>("request_history", { id, action: { operation, ...args } });

export const tauriHistory: HistoryPort = {
  attachments: tauriAttachments,
  append: async (id, entry, secrets: SecretBatch = { operationId: crypto.randomUUID(), mutations: [] }) => {
    try { await command(id, "append", { entry, secrets }); }
    catch (error) {
      if (isCommitRejected(error)) throw commitRejection(error);
      let status: CommitState;
      try { status = await invoke<CommitState>("secure_operation_status", { operationId: secrets.operationId }); }
      catch { throw new RecoveryRequiredError(secrets.operationId); }
      if (status.status === "committed") return;
      if (status.status === "recovery-required") throw new RecoveryRequiredError(secrets.operationId);
      throw error;
    }
  },
  list: (id, query) => command(id, "list", { query }),
  read: (id, entryId) => command(id, "read", { id: entryId }),
  existing: (id, ids) => command(id, "existing", { ids }),
  remove: (id, filter) => command(id, "remove", { filter }),
  pin: (id, entryId, pinned) => command(id, "pin", { id: entryId, pinned }),
  settings: (id, retentionDays) => command(id, "settings", { retentionDays }),
  prune: (id) => command(id, "prune"),
  readAttachment: async (id, attachmentId) => new Uint8Array(await command<number[]>(id, "attachment", { id: attachmentId })),
};
