import type { Credential, SecretRef } from "../../domain/project";

export type SecretSnapshot = { value: string | null; revision: number };
export type SecretFailureStatus = "locked" | "unavailable" | "corrupt" | "denied";
export type SecretResolution =
  | { status: "available"; value: string; revision: number }
  | { status: "missing"; revision: number }
  | { status: SecretFailureStatus; code: string; retryable: boolean };
/** Value-free availability for lists. An available empty string is distinct from missing. */
export type SecretInspection =
  | { ref: SecretRef; status: "available"; revision: number; empty: boolean }
  | { ref: SecretRef; status: "missing"; revision: number }
  | { ref: SecretRef; status: SecretFailureStatus; code: string; retryable: boolean };
export type CredentialEdit = { kind: "keep" } | { kind: "set"; value: string } | { kind: "delete" };
/** Transient editor state. Never serialize this metadata as a credential value. */
export type SecretFieldState = {
  ref: SecretRef;
  status: "unresolved" | SecretResolution["status"];
  edit?: CredentialEdit;
  code?: string;
};
export class SecretUnavailableError extends Error {
  constructor(readonly reference: SecretRef, readonly status: "missing" | SecretFailureStatus, readonly code = "credential-unavailable") {
    super(`Local credential is ${status}. Open Required local secrets to provide it or retry.`);
    this.name = "SecretUnavailableError";
  }
}
export type SecretProtectionScope =
  | { owner: "workspace"; workspaceId: string; kind: "credentials" | "runtime" }
  | { owner: "global"; kind: "credentials" | "runtime" };
export type SecretMutation = { scope: SecretProtectionScope; ref: SecretRef; expectedRevision: number; value: string | null };
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
  resolve(ref: SecretRef): Promise<SecretResolution>;
  inspect(refs: readonly SecretRef[]): Promise<SecretInspection[]>;
  commit(batch: SecretBatch): Promise<void>;
  operationStatus(operationId: string): Promise<CommitState>;
  set(ref: SecretRef, value: string): Promise<void>;
  delete(ref: SecretRef): Promise<void>;
  exists(ref: SecretRef): Promise<boolean>;
}

export interface CredentialResolver {
  resolve(credential: Credential): Promise<string>;
}
