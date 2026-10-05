import { invoke } from "@tauri-apps/api/core";
import type { HistoryPort } from "../../application/ports/history";

const command = <T>(id: string, operation: string, args: object = {}) =>
  invoke<T>("request_history", { id, action: { operation, ...args } });

export const tauriHistory: HistoryPort = {
  append: (id, entry) => command(id, "append", { entry }),
  list: (id, query) => command(id, "list", { query }),
  read: (id, entryId) => command(id, "read", { id: entryId }),
  existing: (id, ids) => command(id, "existing", { ids }),
  remove: (id, filter) => command(id, "remove", { filter }),
  pin: (id, entryId, pinned) => command(id, "pin", { id: entryId, pinned }),
  settings: (id, retentionDays) => command(id, "settings", { retentionDays }),
  prune: (id) => command(id, "prune"),
  readAttachment: async (id, attachmentId) => new Uint8Array(await command<number[]>(id, "attachment", { id: attachmentId })),
};
