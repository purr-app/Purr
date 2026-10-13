import type { HttpRequestSnapshot, ResponseContentRef } from "../../domain/http";
import type { RequestSettings } from "../../domain/request-settings";

export type RequestFileRef = {
  id: string;
  name: string;
  size: number;
  mediaType: string;
};

export type PreparedRequestBody =
  | { kind: "file"; reference: RequestFileRef }
  | {
      kind: "multipart";
      parts: readonly (
        | { kind: "text"; name: string; value: string; mediaType: string }
        | { kind: "file"; name: string; reference: RequestFileRef }
      )[];
    };

export type PreparedHttpTransportRequest = Omit<
  HttpRequestSnapshot,
  "bodyBase64"
> & {
  bodyBase64: string | null;
  bodySource?: PreparedRequestBody;
  tracePropagation?: string;
  traceHeaders?: [string, string][];
  transportSettings?: Pick<RequestSettings, "timeoutMs" | "validateTlsCertificates" | "httpVersion">;
};

export type ResponseContentProtection = "encrypted" | "plaintext";
export type ResponseStoragePolicy = {
  protection: ResponseContentProtection;
};

// Fresh local workspaces default Off. Known token operations override this policy.
export const defaultResponseStoragePolicy: ResponseStoragePolicy = {
  protection: "plaintext",
};

export type HttpPipelineTimings = {
  setupMs: number;
  networkMs: number;
  encryptionMs: number;
  sqliteWriteMs: number;
  storageBackpressureMs: number;
  nativeTotalMs: number;
  ipcMs?: number;
};

type HttpTransportMetadata = {
  injectedTraceHeaders?: [string, string][];
  status: number;
  statusText: string;
  headers: [string, string][];
  durationMs: number;
  headersDurationMs?: number;
  downloadDurationMs?: number;
  httpVersion?: string;
  localAddress?: string;
  remoteAddress?: string;
  pipelineTimings?: HttpPipelineTimings;
};

// Inline completion remains valid for browser/test adapters during migration.
// Desktop completion returns only the opaque native content reference.
export type HttpTransportResponse = HttpTransportMetadata & (
  | { bodyBase64: string; content?: never }
  | { content: ResponseContentRef; bodyBase64?: never }
);

export type HttpTransportProgress = {
  receivedBytes: number;
  totalBytes?: number;
};

export type HttpTransportOptions = {
  // Native response storage requires an owner; the workspace binds this context.
  workspaceId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: HttpTransportProgress) => void;
  responseStorage?: ResponseStoragePolicy;
};

export type HttpTransportPort = (
  request: PreparedHttpTransportRequest,
  options?: HttpTransportOptions,
) => Promise<HttpTransportResponse>;
