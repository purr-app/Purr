import type { HttpRequestSnapshot } from "../../domain/http";

export type HttpTransportResponse = {
  status: number;
  statusText: string;
  headers: [string, string][];
  bodyBase64: string;
  durationMs: number;
  headersDurationMs?: number;
  downloadDurationMs?: number;
  httpVersion?: string;
  localAddress?: string;
  remoteAddress?: string;
};

export type HttpTransportPort = (
  request: HttpRequestSnapshot,
) => Promise<HttpTransportResponse>;
