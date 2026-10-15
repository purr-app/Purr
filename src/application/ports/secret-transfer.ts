import type { CommitState, SecretResolution } from "./credentials";

/** Inventory and previews contain metadata only; values require explicit per-row reveal. */
export type SecretTransferInventory = {
  items: { ref: string; owners: string[]; status: SecretResolution["status"] }[];
  publicValueCount: number;
  dependencies: string[];
  unsavedExcluded?: boolean;
};
export type SecretTransferPreview = {
  id: string;
  workspaceId: string;
  expiresAt: number;
  items: { ref: string; owners: string[]; status: "missing" | "existing" | "unknown" }[];
  omissions: string[];
  dependencies: string[];
};
export type SecretTransferWriteResult = { status: "written" | "cancelled" };
export type SelectedRecoveryPackages = { id: string; keyName: string; backupName: string };
export type SelectedSecretPackage = { id: string; name: string };
export type SecretTransferCommitResult = { operationId: string; status: "committed" | "aborted" | "recovery-required" };
export interface SecretTransferPort {
  readonly available: boolean;
  inventory(workspaceId: string): Promise<SecretTransferInventory>;
  exportSelected(input: { workspaceId: string; references: string[]; omittedRefs: string[]; password: string }, signal?: AbortSignal): Promise<SecretTransferWriteResult>;
  exportRecoveryKey(input: { workspaceId: string; password: string }, signal?: AbortSignal): Promise<SecretTransferWriteResult>;
  exportCredentialBackup(input: { workspaceId: string; password: string }, signal?: AbortSignal): Promise<SecretTransferWriteResult>;
  exportConfiguration(workspaceId: string, signal?: AbortSignal): Promise<SecretTransferWriteResult>;
  selectImportFile(workspaceId: string, signal?: AbortSignal): Promise<SelectedSecretPackage | null>;
  prepareImport(input: { workspaceId: string; stagedId: string; password: string }, signal?: AbortSignal): Promise<SecretTransferPreview | null>;
  selectRecoveryFiles(workspaceId: string, signal?: AbortSignal): Promise<SelectedRecoveryPackages | null>;
  prepareRecovery(input: { workspaceId: string; stagedId: string; keyPassword: string; backupPassword: string }, signal?: AbortSignal): Promise<SecretTransferPreview | null>;
  revealPreviewValue(input: { workspaceId: string; previewId: string; reference: string }): Promise<string>;
  commitImport(input: { workspaceId: string; previewId: string; operationId: string; references: string[] }): Promise<SecretTransferCommitResult>;
  cancel(previewId: string): Promise<void>;
  operationStatus(operationId: string): Promise<CommitState>;
}

export function validTransferPassword(password: string): boolean {
  return Array.from(password).length >= 12 && new TextEncoder().encode(password).byteLength <= 1024;
}
