import { isInlineHttpResponse, responseForPersistence, restoreStoredHttpResponse, type HttpRequestSnapshot, type StoredHttpResponse } from "../domain/http";
import { secretProtectionScope, secretRef, storeCredential } from "../storage/secrets";
import type { SecureStore } from "./ports/credentials";

const masked = "********";
const privateHeader = (name: string) => /^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(name.trim());

/** Persistence receives an explicit public projection, never the live wire DTO. */
export async function protectResponseSnapshot(input: StoredHttpResponse, secure: SecureStore, workspace: string, owner: string): Promise<StoredHttpResponse> {
  const source = responseForPersistence(input);
  const response = structuredClone(source);
  const sensitivity = source.timeline.sensitivity;
  const sensitiveNames = new Set(sensitivity?.headers.map((name) => name.toLowerCase()));
  const request = (value: HttpRequestSnapshot): HttpRequestSnapshot => ({
    url: sensitivity?.url ? masked : value.url,
    method: value.method,
    headers: sensitivity?.headerNames ? [[masked, masked]] : value.headers.map(([name, value]) => [name, privateHeader(name) || sensitiveNames.has(name.toLowerCase()) ? masked : value]),
    bodyBase64: sensitivity?.body ? null : value.bodyBase64,
    ...(value.bodySummary && !sensitivity?.body ? { bodySummary: value.bodySummary } : {}),
  });
  response.timeline.request = request(source.timeline.request);
  // The display copy can contain literal fragments of a partly templated secret.
  // Persist the same whole-field classification as the exact wire copy.
  response.timeline.displayRequest = request(source.timeline.displayRequest ?? source.timeline.request);
  const metadata = isInlineHttpResponse(response) ? response : response.response;
  metadata.url = sensitivity?.url ? masked : metadata.url;
  metadata.headers = sensitivity?.headerNames ? [[masked, masked]] : metadata.headers.map(([name, value]) => [name, privateHeader(name) || sensitiveNames.has(name.toLowerCase()) || sensitivity?.url && name.toLowerCase() === "location" ? masked : value]);
  if (!isInlineHttpResponse(response)) response.request = request(source.timeline.request);
  // Provenance names may themselves be derived from a sensitive template.
  if (response.timeline.sensitivity) response.timeline.sensitivity.headers = [];
  delete response.protectedSnapshot;
  const exact = structuredClone(source);
  delete exact.protectedSnapshot;
  // Compare only classified fields; adding an identical display copy is harmless.
  const changed = JSON.stringify({ request: exact.timeline.request, metadata: isInlineHttpResponse(exact) ? { url: exact.url, headers: exact.headers } : { url: exact.response.url, headers: exact.response.headers } }) !==
    JSON.stringify({ request: response.timeline.request, metadata: { url: metadata.url, headers: metadata.headers } });
  if (!changed && !source.protectedSnapshot) return response;
  if (source.protectedSnapshot) {
    const scope = secretProtectionScope(source.protectedSnapshot.ref);
    if (source.protectedSnapshot.version !== 1 || scope.owner !== "workspace" || scope.workspaceId !== workspace || scope.kind !== "runtime") throw new Error("Invalid protected response snapshot reference.");
    response.protectedSnapshot = { version: 1, ref: source.protectedSnapshot.ref };
  } else {
    const ref = secretRef(workspace, owner, "response-snapshot", "runtime");
    try {
      await storeCredential(secure, ref, JSON.stringify(exact));
      response.protectedSnapshot = { version: 1, ref };
    } catch {
      // Unexpected Set-Cookie may arrive after an otherwise public dispatch.
      // Keep the public body while recording that exact protected details were lost.
      response.protectedSnapshot = { version: 1, ref, status: "unavailable" };
    }
  }
  return response;
}

/** Unavailable exact details retain their public view and typed state, never empty strings. */
export async function restoreResponseSnapshot(value: unknown, secure: SecureStore, workspace: string): Promise<StoredHttpResponse | null> {
  const response = restoreStoredHttpResponse(value);
  if (!response?.protectedSnapshot) return response;
  const marker = response.protectedSnapshot;
  try {
    const scope = secretProtectionScope(marker.ref);
    if (marker.version !== 1 || scope.owner !== "workspace" || scope.workspaceId !== workspace || scope.kind !== "runtime") throw new Error();
    const resolution = await secure.resolve(marker.ref);
    if (resolution.status !== "available") return { ...response, protectedSnapshot: { ...marker, status: resolution.status } };
    const exact = restoreStoredHttpResponse(JSON.parse(resolution.value));
    if (!exact || exact.timeline.startedAtMs !== response.timeline.startedAtMs) throw new Error();
    return { ...exact, protectedSnapshot: { ...marker, status: "available" } };
  } catch {
    return { ...response, protectedSnapshot: { ...marker, status: "corrupt" } };
  }
}

export function responseRecordProtection(response: StoredHttpResponse): "plaintext" | "encrypted" {
  // Unknown/old adapter provenance is never taken as permission to write plaintext.
  return response.timeline.responseProtection === "plaintext" ? "plaintext" : "encrypted";
}
