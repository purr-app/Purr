import type { SecretTransferPort } from "../application/ports/secret-transfer";
const unavailable = () => Promise.reject(new Error("Secret transfer and recovery require the Purr desktop app."));
export const unavailableSecretTransfer: SecretTransferPort = {
  available: false,
  inventory: unavailable,
  exportSelected: unavailable,
  exportRecoveryKey: unavailable,
  exportCredentialBackup: unavailable,
  exportConfiguration: unavailable,
  selectImportFile: unavailable,
  prepareImport: unavailable,
  selectRecoveryFiles: unavailable,
  prepareRecovery: unavailable,
  revealPreviewValue: unavailable,
  commitImport: unavailable,
  cancel: unavailable,
  operationStatus: unavailable,
};
