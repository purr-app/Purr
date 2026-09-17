import type { HttpRequestSnapshot, ResponseContentRef } from "../../domain/http";

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
};

export type ResponseContentProtection = "encrypted" | "plaintext";
export type ResponseStoragePolicy = {
  protection: ResponseContentProtection;
};

// Plaintext is intentionally not selectable yet. Keeping the resolved policy
// at the transport boundary lets future workspace/folder/document inheritance
// change storage without teaching Rust about the workspace tree.
export const defaultResponseStoragePolicy: ResponseStoragePolicy = {
  protection: "encrypted",
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
  signal?: AbortSignal;
  onProgress?: (progress: HttpTransportProgress) => void;
  responseStorage?: ResponseStoragePolicy;
};

export type HttpTransportPort = (
  request: PreparedHttpTransportRequest,
  options?: HttpTransportOptions,
) => Promise<HttpTransportResponse>;
