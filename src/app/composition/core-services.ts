import { isTauri } from "@tauri-apps/api/core";

import type { ApplicationServices } from "./application-services";
import { WorkspacePersistence } from "../../application/workspace-persistence";
import { resolveCredential } from "../../storage/secrets";
import { createBrowserPlatformAdapters } from "../../platform/browser/application-services";
import { createTauriPlatformAdapters } from "../../platform/tauri/application-services";

export function createCoreServices(): ApplicationServices {
  const adapters = isTauri()
    ? createTauriPlatformAdapters()
    : createBrowserPlatformAdapters();
  const persistence = new WorkspacePersistence(
    adapters.persistenceBackend,
    adapters.secureStore,
  );
  return Object.freeze({
    ...adapters,
    persistence,
    secretTransfer: {
      ...adapters.secretTransfer,
      commitImport: (input) => persistence.runSecretTransfer(() => adapters.secretTransfer.commitImport(input)),
      operationStatus: (operationId) => persistence.runSecretTransfer(() => adapters.secretTransfer.operationStatus(operationId)),
    },
    credentialResolver: {
      resolve: (credential) =>
        resolveCredential(persistence.secure, credential),
    },
  });
}
