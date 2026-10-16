import type { HttpTransportPort } from "../../../application/ports/http";

// Capture ownership when the operation is created; a later workspace switch
// cannot redirect OAuth, dependency, or response content into the new workspace.
export function workspaceHttpTransport(transport: HttpTransportPort, workspaceId: string, protection: "plaintext" | "encrypted" = "plaintext"): HttpTransportPort {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(workspaceId)) throw new Error("Invalid response workspace identifier");
  return (request, options) => transport(request, { ...options, workspaceId, responseStorage: options?.responseStorage ?? { protection } });
}
