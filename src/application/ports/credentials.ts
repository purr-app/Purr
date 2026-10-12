import type { Credential, SecretRef } from "../../domain/project";

export type SecretSnapshot = { value: string | null; revision: number };
export type SecretMutation = { ref: SecretRef; expectedRevision: number; value: string | null };
/** Transient plaintext input to a native transaction; never a project/local payload. */
export type SecretBatch = { operationId: string; mutations: SecretMutation[] };
export type CommitState = { operationId: string; status: "committed" | "aborted" | "recovery-required" | "missing" };
export class CommitRejectedError extends Error {
  constructor(message: string, readonly recoveryRequired = false) {
    super(message);
    this.name = "CommitRejectedError";
  }
}
export function isCommitRejected(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error);
  return error instanceof CommitRejectedError || message.startsWith("operation-conflict:") || message.startsWith("commit-rejected:");
}
export function commitRejection(error: unknown): CommitRejectedError {
  if (error instanceof CommitRejectedError) return error;
  const message = String(error instanceof Error ? error.message : error).replace(/^(operation-conflict|commit-rejected):\s*/, "");
  return new CommitRejectedError(message, message.startsWith("Commit recovery-required;"));
}

export class RecoveryRequiredError extends Error {
  constructor(readonly operationId: string) {
    super("The save outcome needs recovery before retrying. Reload to check whether it committed; no automatic reset was performed.");
    this.name = "RecoveryRequiredError";
  }
}

export interface SecureStore {
  get(ref: SecretRef): Promise<string | null>;
  read(ref: SecretRef): Promise<SecretSnapshot>;
  commit(batch: SecretBatch): Promise<void>;
  operationStatus(operationId: string): Promise<CommitState>;
  set(ref: SecretRef, value: string): Promise<void>;
  delete(ref: SecretRef): Promise<void>;
  exists(ref: SecretRef): Promise<boolean>;
}

export interface CredentialResolver {
  resolve(credential: Credential): Promise<string>;
}
