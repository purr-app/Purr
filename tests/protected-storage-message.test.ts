import assert from "node:assert/strict";
import { test } from "node:test";
import { protectedStorageMessage } from "../src/features/workspaces/model/protected-storage-message";

test("root key failures distinguish missing, conflicting, incomplete retirement and unverified data", () => {
  const message = (code: string) => protectedStorageMessage({ status: "recovery-required", code });
  assert.match(message("root-key-missing"), /will not create a replacement key/);
  assert.match(message("root-key-conflict"), /keys do not match/);
  assert.match(message("root-retirement-pending"), /old plaintext key file/);
  assert.match(message("root-retirement-pending"), /Editing and Send remain blocked/);
  assert.match(message("root-inventory-unavailable"), /cannot inspect all existing protected data/);
  assert.match(message("root-inventory-corrupt"), /requires recovery/);
  assert.match(message("root-inventory-key-mismatch"), /does not unlock all existing protected data/);
  assert.match(message("root-identity-mismatch"), /different installation/);
  assert.match(message("root-key-reappeared"), /after migration/);
});

test("protected storage messages do not expose unknown native details or report success prematurely", () => {
  const detail = "/private/synthetic/keychain: DO_NOT_EXPOSE_KEY_MATERIAL";
  assert.equal(protectedStorageMessage({ status: "corrupt", code: detail }), "Protected storage is corrupt.");
  assert.equal(protectedStorageMessage({ status: "recovery-required", code: "__proto__" }), "Protected storage is recovery-required.");
  assert.equal(protectedStorageMessage({ status: "available" }), "");
  assert.match(protectedStorageMessage({ status: "denied", code: "root-provider-access-denied" }), /choose Retry \/ Unlock/);
});


test("operational root failures offer bounded recovery actions without resetting protected storage", () => {
  const message = (code: string) => protectedStorageMessage({ status: "unavailable", code });
  assert.match(message("root-vault-in-use"), /Close that instance, then choose Retry \/ Unlock/);
  assert.match(message("root-key-readback-mismatch"), /could not verify the encryption key saved/);
  assert.match(message("root-metadata-write-failed"), /storage access and available space/);
  assert.match(message("root-metadata-unavailable"), /Restore access to application storage/);
  assert.match(message("root-identity-invalid"), /correctly configured Purr build/);
  assert.match(message("root-provider-corrupt"), /needs recovery/);
  assert.match(message("root-provider-unsupported"), /does not support the system key store/);
  assert.match(message("root-key-read-denied"), /will not replace it/);
  assert.match(message("root-key-unsafe-permissions"), /Restrict access to its owner/);
});
