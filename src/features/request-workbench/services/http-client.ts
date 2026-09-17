import { getPublicSuffix } from "tough-cookie";
import {
  createInlineHttpResponse,
  type HttpExchange,
  type InlineHttpResponse,
  type StoredHttpResponse,
} from "../../../domain/http";
import type {
  HttpTransportProgress,
  HttpTransportPort,
  HttpTransportResponse,
  HttpPipelineTimings,
  ResponseStoragePolicy,
  PreparedHttpTransportRequest,
} from "../../../application/ports/http";
import type { ResponseContentPort } from "../../../application/ports/response-content";
import { base64Bytes } from "../model/request-auth";
import type { SessionCookieJar } from "../model/cookie-jar";
import {
  inlineResponseLimitBytes,
  inlineResponseMaximumLineBytes,
} from "./response-content-reader";

export type WireRequest = PreparedHttpTransportRequest;
export type WireResponse = HttpTransportResponse;
export type HttpTransport = HttpTransportPort;
const materializationWindowBytes = inlineResponseLimitBytes;

function isReferencedResponse(
  response: HttpTransportResponse,
): response is HttpTransportResponse & { content: HttpExchange["content"] } {
  return "content" in response && response.content !== undefined;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DOMException("The request was cancelled", "AbortError");
}

export async function materializeHttpExchange(
  exchange: HttpExchange,
  content: ResponseContentPort,
  signal?: AbortSignal,
): Promise<InlineHttpResponse> {
  const base64: string[] = [];
  const text: string[] = [];
  const decoder = new TextDecoder();
  for (let offset = 0; offset < exchange.content.byteLength; offset += materializationWindowBytes) {
    throwIfAborted(signal);
    const window = await content.readRange(
      exchange.content,
      {
        offset,
        length: Math.min(materializationWindowBytes, exchange.content.byteLength - offset),
      },
      "base64",
      signal,
    );
    const bytes = Uint8Array.from(atob(window.content), (character) =>
      character.charCodeAt(0),
    );
    base64.push(window.content);
    text.push(decoder.decode(bytes, { stream: !window.complete }));
  }
  text.push(decoder.decode());
  return createInlineHttpResponse({
    ...exchange.response,
    size: exchange.content.byteLength,
    bodyBase64: base64.join(""),
    text: text.join(""),
    timeline: exchange.timeline,
    sourceExchange: exchange,
  });
}
export function requireHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid HTTP or HTTPS URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Use an HTTP or HTTPS URL without embedded credentials.");
  return url;
}
export const encodeBody = async (body: Blob | null) =>
  body ? base64Bytes(new Uint8Array(await body.arrayBuffer())) : null;
const cookieSite = (url: URL) =>
  url.protocol +
  "//" +
  (getPublicSuffix(url.hostname, { ignoreError: true }) || url.hostname);

export function mergeCookieHeader(manual: string, jar: string) {
  const names = new Set(
    manual.split(";").map((part) => part.trim().split("=")[0]),
  );
  return [
    manual,
    ...jar
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part && !names.has(part.split("=")[0])),
  ]
    .filter(Boolean)
    .join("; ");
}

export function maskCookieHeader(value: string) {
  return value.replace(/(^|;\s*)([^=;]+)=([^;]*)/g, "$1$2=********");
}

export async function executeHttp(
  request: WireRequest,
  options: {
    jar?: SessionCookieJar;
    transport?: HttpTransport;
    sensitiveHeaders?: string[];
    sensitiveQueryParams?: string[];
    displayRequest?: WireRequest;
    followRedirects?: boolean;
    content?: ResponseContentPort;
    signal?: AbortSignal;
    onProgress?: (progress: HttpTransportProgress) => void;
    responseStorage?: ResponseStoragePolicy;
  } = {},
): Promise<StoredHttpResponse> {
  const current = { ...request, headers: [...request.headers] };
  const initial = requireHttpUrl(current.url);
  const started = Date.now();
  const displayStarted = performance.now();
  let crossedOrigin = false;
  let crossedSite = false;
  let transportMs = 0;
  let waitingMs = 0;
  let downloadMs = 0;
  let processing: HttpPipelineTimings | undefined;
  const generatedHeaders: [string, string][] = [];
  for (let hop = 0; hop <= 10; hop++) {
    throwIfAborted(options.signal);
    const url = requireHttpUrl(current.url);
    let headers = current.headers;
    if (options.jar) {
      const manual = headers
        .filter(([name]) => name.toLowerCase() === "cookie")
        .map(([, value]) => value)
        .join("; ");
      const cookies = mergeCookieHeader(
        manual,
        options.jar.header(url.toString(), crossedSite ? "none" : "strict"),
      );
      headers = headers.filter(([name]) => name.toLowerCase() !== "cookie");
      if (cookies) headers.push(["Cookie", cookies]);
    }
    if (!options.transport)
      throw new Error(
        "Send requests and authorize OAuth in the Purr desktop app (npm run tauri dev).",
      );
    const response = await options.transport(
      {
        ...current,
        headers,
      },
      {
        signal: options.signal,
        onProgress: options.onProgress,
        responseStorage: options.responseStorage,
      },
    );
    if (response.injectedTraceHeaders?.length) {
      generatedHeaders.push(...response.injectedTraceHeaders);
      headers = [...headers, ...response.injectedTraceHeaders];
      current.headers = [...current.headers, ...response.injectedTraceHeaders];
    }
    if (options.signal?.aborted) {
      if (isReferencedResponse(response) && options.content)
        await options.content.release(response.content);
      throwIfAborted(options.signal);
    }
    const completedAtMs = Date.now();
    const hopTransportMs = Math.max(0, Number(response.durationMs) || 0);
    const hopWaitingMs = Math.max(
      0,
      Math.min(
        hopTransportMs,
        Number(response.headersDurationMs ?? hopTransportMs) || 0,
      ),
    );
    const hopDownloadMs = Math.max(
      0,
      Math.min(
        hopTransportMs - hopWaitingMs,
        Number(response.downloadDurationMs ?? hopTransportMs - hopWaitingMs) || 0,
      ),
    );
    transportMs += hopTransportMs;
    waitingMs += hopWaitingMs;
    downloadMs += hopDownloadMs;
    if (response.pipelineTimings) {
      const previous = processing;
      processing = {
        setupMs: (previous?.setupMs ?? 0) + response.pipelineTimings.setupMs,
        networkMs: (previous?.networkMs ?? 0) + response.pipelineTimings.networkMs,
        encryptionMs: (previous?.encryptionMs ?? 0) + response.pipelineTimings.encryptionMs,
        sqliteWriteMs: (previous?.sqliteWriteMs ?? 0) + response.pipelineTimings.sqliteWriteMs,
        storageBackpressureMs: (previous?.storageBackpressureMs ?? 0) + response.pipelineTimings.storageBackpressureMs,
        nativeTotalMs: (previous?.nativeTotalMs ?? 0) + response.pipelineTimings.nativeTotalMs,
        ipcMs: (previous?.ipcMs ?? 0) + (response.pipelineTimings.ipcMs ?? 0),
      };
    }
    options.jar?.receive(url.toString(), response.headers);
    const location = response.headers.find(
      ([name]) => name.toLowerCase() === "location",
    )?.[1];
    if (
      options.followRedirects !== false &&
      location &&
      [301, 302, 303, 307, 308].includes(response.status)
    ) {
      if (isReferencedResponse(response)) {
        if (!options.content)
          throw new Error("Response content service is unavailable.");
        await options.content.release(response.content);
      }
      if (hop === 10) throw new Error("Too many redirects (maximum 10).");
      const next = requireHttpUrl(new URL(location, url).toString());
      if (url.protocol === "https:" && next.protocol !== "https:")
        throw new Error("Blocked redirect from HTTPS to HTTP.");
      if (next.origin !== url.origin) {
        crossedOrigin = true;
        // Automatically generated context is scoped to the initial origin.
        const generatedNames = new Set(generatedHeaders.map(([name]) => name.toLowerCase()));
        current.headers = current.headers.filter(([name]) => !generatedNames.has(name.toLowerCase()));
        generatedHeaders.length = 0;
        current.tracePropagation = "off";
        current.traceHeaders = [];
        const sensitive = new Set([
          "authorization",
          "proxy-authorization",
          "cookie",
          "host",
          "x-api-key",
          "x-auth-token",
          ...(options.sensitiveHeaders ?? []).map((name) => name.toLowerCase()),
        ]);
        current.headers = current.headers.filter(
          ([name]) => !sensitive.has(name.toLowerCase()),
        );
      }
      if (cookieSite(next) !== cookieSite(initial)) crossedSite = true;
      if (crossedOrigin)
        for (const name of options.sensitiveQueryParams ?? [])
          next.searchParams.delete(name);
      if (
        (response.status === 303 && current.method !== "HEAD") ||
        ([301, 302].includes(response.status) && current.method === "POST")
      ) {
        current.method = "GET";
        current.bodyBase64 = null;
        current.bodySource = undefined;
        current.bodySummary = undefined;
        current.headers = current.headers.filter(
          ([name]) =>
            !["content-type", "content-length"].includes(name.toLowerCase()),
        );
      }
      current.url = next.toString();
      continue;
    }
    const elapsedMs = Math.max(transportMs, completedAtMs - started);
    const displayRequest = options.displayRequest ? {
      ...options.displayRequest,
      // Never replace the already-redacted URL with the request that actually
      // went over the wire. Redirects may make the displayed URL less exact,
      // but exposing a secret query variable is a much worse failure mode.
      url: options.displayRequest.url,
      method: current.method,
      bodyBase64: current.bodyBase64 === null
        ? null
        : options.displayRequest.bodyBase64,
      bodySummary: current.bodySummary
        ? options.displayRequest.bodySummary
        : undefined,
      headers: [
        ...options.displayRequest.headers.filter(([name]) => name.toLowerCase() !== "cookie"),
        ...generatedHeaders,
        ...headers.filter(([name]) => name.toLowerCase() === "cookie").map(([name, value]): [string, string] => [name, maskCookieHeader(value)]),
      ],
    } : undefined;
    const timeline = {
        startedAtMs: started,
        prepareMs: Math.max(0, elapsedMs - waitingMs - downloadMs),
        waitingMs,
        downloadMs,
        completedAtMs,
        request: {
          url: current.url,
          method: current.method,
          headers,
          bodyBase64: current.bodyBase64,
          ...(current.bodySummary ? { bodySummary: current.bodySummary } : {}),
        },
        displayRequest,
        followRedirects: options.followRedirects !== false,
        usesCookieJar: Boolean(options.jar),
        timeoutMs: 60_000,
        processing: processing ? {
          ...processing,
          displayReadyMs: performance.now() - displayStarted,
        } : undefined,
      };
    const responseUrl = current.url || initial.toString();
    if (isReferencedResponse(response)) {
      if (!options.content)
        throw new Error("Response content service is unavailable.");
      const exchange: HttpExchange = {
        protocolVersion: 2,
        request: timeline.request,
        response: {
          url: responseUrl,
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          byteLength: response.content.byteLength,
          durationMs: transportMs,
          headersDurationMs: response.headersDurationMs,
          downloadDurationMs: response.downloadDurationMs,
          httpVersion: response.httpVersion,
          localAddress: response.localAddress,
          remoteAddress: response.remoteAddress,
        },
        content: response.content,
        timeline,
      };
      // Keep the exact boundary on the bounded path as well. A 1 MiB body can
      // be a single line, and mounting that line in CodeMirror synchronously
      // blocks the WebView even though native capture has already completed.
      if (
        exchange.content.byteLength >= inlineResponseLimitBytes
        || (exchange.content.maxLineBytes ?? 0) >= inlineResponseMaximumLineBytes
      ) return exchange;
      try {
        const readStarted = performance.now();
        const materialized = await materializeHttpExchange(exchange, options.content, options.signal);
        if (materialized.timeline.processing) {
          materialized.timeline.processing.contentReadMs = performance.now() - readStarted;
          materialized.timeline.processing.displayReadyMs = performance.now() - displayStarted;
          materialized.timeline.completedAtMs = Date.now();
          materialized.timeline.prepareMs = Math.max(
            0,
            materialized.timeline.completedAtMs
              - materialized.timeline.startedAtMs
              - materialized.timeline.waitingMs
              - materialized.timeline.downloadMs,
          );
        }
        return materialized;
      } catch (cause) {
        await options.content.release(response.content).catch(() => {});
        throw cause;
      }
    }
    const bytes = Uint8Array.from(atob(response.bodyBase64), (char) =>
      char.charCodeAt(0),
    );
    return createInlineHttpResponse({
      ...response,
      url: responseUrl,
      text: new TextDecoder().decode(bytes),
      size: bytes.length,
      durationMs: transportMs,
      timeline,
    });
  }
  throw new Error("Request failed.");
}
