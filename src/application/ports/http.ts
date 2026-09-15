import type { HttpRequestSnapshot, ResponseContentRef } from "../../domain/http";

type HttpTransportMetadata = {
  status: number;
  statusText: string;
  headers: [string, string][];
  durationMs: number;
  headersDurationMs?: number;
  downloadDurationMs?: number;
  httpVersion?: string;
  localAddress?: string;
  remoteAddress?: string;
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
};

export type HttpTransportPort = (
  request: HttpRequestSnapshot,
  options?: HttpTransportOptions,
) => Promise<HttpTransportResponse>;
