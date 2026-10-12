import type { ProtectedState } from "../../../application/ports/persistence";

const rootMessages: Record<string, string> = {
  "root-vault-in-use": "Another Purr instance is using this storage profile. Close that instance, then choose Retry / Unlock.",
  "root-key-readback-mismatch": "Purr could not verify the encryption key saved in the system key store. Migration is blocked until the key-store issue is resolved; retry after recovery.",
  "root-metadata-write-failed": "Purr could not safely save key migration progress. Check application storage access and available space, then choose Retry / Unlock.",
  "root-metadata-unavailable": "Purr cannot access the key migration record. Restore access to application storage, then choose Retry / Unlock.",
  "root-identity-invalid": "This build has an invalid protected-storage identity. Use a correctly configured Purr build to access this storage profile.",
  "root-provider-corrupt": "The system key store returned an invalid key record. Protected storage needs recovery before Purr can use that key.",
  "root-provider-unsupported": "This build does not support the system key store on this platform. Protected storage remains unavailable.",
  "root-key-read-denied": "Access to the existing key file was denied. Restore access to that file, then choose Retry / Unlock. Purr will not replace it.",
  "root-key-unsafe-permissions": "The existing key file has unsafe permissions. Restrict access to its owner before retrying migration.",
  "root-key-conflict": "The available encryption keys do not match. Protected storage needs recovery; Purr has not chosen a replacement key. Restore access to the matching key before retrying.",
  "root-key-missing": "The encryption key for existing protected data is missing. Purr will not create a replacement key. Restore access to the matching key before retrying.",
  "root-key-reappeared": "An unexpected legacy key file appeared after migration. Protected storage is blocked until the key conflict is resolved.",
  "root-metadata-invalid": "Purr cannot validate the key migration record. Protected storage needs recovery before migration can continue.",
  "root-identity-mismatch": "The stored encryption key belongs to a different installation or app identity. Protected storage is blocked until access to this installation’s matching key is restored.",
  "root-retirement-pending": "Key migration is incomplete because Purr could not remove the old plaintext key file. Editing and Send remain blocked. Retry to finish migration.",
  "root-inventory-unavailable": "Purr cannot inspect all existing protected data. Key initialization is blocked. Restore storage access, then retry.",
  "root-inventory-key-mismatch": "The encryption key does not unlock all existing protected data. Key migration is blocked until the matching key and data are recovered.",
  "root-inventory-corrupt": "Purr could not validate existing protected data. Key migration is blocked and requires recovery; retry after the underlying data issue is resolved.",
  "root-provider-locked": "The system key store is locked. Unlock it, then choose Retry / Unlock to access protected storage.",
  "root-provider-access-denied": "Access to the encryption key was denied. Allow Purr to access its key in the system key store, then choose Retry / Unlock.",
  "root-provider-unavailable": "The system key store is unavailable. Restore access to it, then choose Retry / Unlock.",
  "root-key-invalid": "The stored encryption key cannot be read safely. Protected storage needs recovery; Purr will not replace the key automatically.",
};

/** Only known safe messages reach the UI; native error details and unknown codes do not. */
export function protectedStorageMessage(state: ProtectedState): string {
  if (state.status === "available") return "";
  return Object.prototype.hasOwnProperty.call(rootMessages, state.code) ? rootMessages[state.code] : `Protected storage is ${state.status}.`;
}
