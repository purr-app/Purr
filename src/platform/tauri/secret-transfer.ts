import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { SecretTransferPort } from "../../application/ports/secret-transfer";

const strings = z.array(z.string());
const item = z.object({ ref: z.string().min(1), owners: strings });
const inventory = z.object({
  items: z.array(item.extend({ status: z.enum(["available", "missing", "locked", "denied", "unavailable", "corrupt"]) })),
  publicValueCount: z.number().int().nonnegative(), dependencies: strings, unsavedExcluded: z.boolean().optional(),
});
const preview = z.object({
  id: z.string().min(1), workspaceId: z.string().min(1), expiresAt: z.number().int().nonnegative(),
  items: z.array(item.extend({ status: z.enum(["missing", "existing", "unknown"]) })), omissions: strings, dependencies: strings,
}).nullable();
const selectedPackage = z.object({ id: z.string().min(1), name: z.string().min(1) }).nullable();
const selectedRecoveryPackages = z.object({ id: z.string().min(1), keyName: z.string().min(1), backupName: z.string().min(1) }).nullable();
const written = z.object({ status: z.enum(["written", "cancelled"]) });
const committed = z.object({ operationId: z.string().min(1), status: z.enum(["committed", "aborted", "recovery-required"]) });
const outcome = committed.extend({ status: z.enum(["committed", "aborted", "recovery-required", "missing"]) });
async function call<T>(action: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await invoke("secret_transfer", { action }));
}
async function cancellable<T>(action: Record<string, unknown>, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const operationId = crypto.randomUUID();
  const cancel = () => { void invoke("secret_transfer", { action: { type: "cancel", operationId } }).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try { return await call({ ...action, operationId }, schema); }
  finally { signal?.removeEventListener("abort", cancel); }
}
async function prepare(action: Record<string, unknown>, signal?: AbortSignal) {
  const result = await cancellable(action, preview, signal);
  if (signal?.aborted && result) {
    await invoke("secret_transfer", { action: { type: "cancel", previewId: result.id } });
    return null;
  }
  return result;
}
export const nativeSecretTransfer: SecretTransferPort = {
  available: true,
  inventory: (workspaceId) => call({ type: "inventory", workspaceId }, inventory),
  exportSelected: (input, signal) => cancellable({ type: "exportSelected", ...input }, written, signal),
  exportRecoveryKey: (input, signal) => cancellable({ type: "exportRecoveryKey", ...input }, written, signal),
  exportCredentialBackup: (input, signal) => cancellable({ type: "exportCredentialBackup", ...input }, written, signal),
  exportConfiguration: (workspaceId, signal) => cancellable({ type: "exportConfiguration", workspaceId }, written, signal),
  selectImportFile: async (workspaceId, signal) => {
    const result = await cancellable({ type: "selectImportFile", workspaceId }, selectedPackage, signal);
    if (signal?.aborted && result) {
      await invoke("secret_transfer", { action: { type: "cancel", previewId: result.id } });
      return null;
    }
    return result;
  },
  prepareImport: (input, signal) => prepare({ type: "prepareImport", ...input }, signal),
  selectRecoveryFiles: async (workspaceId, signal) => {
    const result = await cancellable({ type: "selectRecoveryFiles", workspaceId }, selectedRecoveryPackages, signal);
    if (signal?.aborted && result) {
      await invoke("secret_transfer", { action: { type: "cancel", previewId: result.id } });
      return null;
    }
    return result;
  },
  prepareRecovery: (input, signal) => prepare({ type: "prepareRecovery", ...input }, signal),
  revealPreviewValue: (input) => call({ type: "revealPreviewValue", ...input }, z.string()),
  commitImport: (input) => call({ type: "commitImport", ...input }, committed),
  cancel: async (previewId) => { await invoke("secret_transfer", { action: { type: "cancel", previewId } }); },
  operationStatus: async (operationId) => outcome.parse(await invoke("secure_operation_status", { operationId })),
};
