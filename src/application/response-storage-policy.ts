import {
  defaultResponseStoragePolicy,
  type ResponseContentProtection,
  type ResponseStoragePolicy,
} from "./ports/http";

export type ResponseStoragePreference = "inherit" | ResponseContentProtection;

export type ResponseStoragePolicyHierarchy = {
  workspace?: ResponseStoragePreference;
  /** Ordered from the workspace root to the document's nearest folder. */
  folders?: readonly ResponseStoragePreference[];
  document?: ResponseStoragePreference;
};

/**
 * Resolves local at-rest response policy. These preferences must remain local
 * settings: opening a shared project file must never disable encryption.
 */
export function resolveResponseStoragePolicy(
  hierarchy: ResponseStoragePolicyHierarchy,
): ResponseStoragePolicy {
  const candidates = [
    hierarchy.workspace,
    ...(hierarchy.folders ?? []),
    hierarchy.document,
  ];
  let protection = defaultResponseStoragePolicy.protection;
  for (const candidate of candidates) {
    if (candidate && candidate !== "inherit") protection = candidate;
  }
  return { protection };
}
