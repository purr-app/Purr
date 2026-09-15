import type { Credential, SecretRef } from "../../domain/project";

export interface SecureStore {
  get(ref: SecretRef): Promise<string | null>;
  set(ref: SecretRef, value: string): Promise<void>;
  delete(ref: SecretRef): Promise<void>;
  exists(ref: SecretRef): Promise<boolean>;
}

export interface CredentialResolver {
  resolve(credential: Credential): Promise<string>;
}
