import { getPublicSuffix } from "tough-cookie";
import {
  createInlineHttpResponse,
  type HttpExchange,
  type HttpRequestSnapshot,
  type InlineHttpResponse,
} from "../../../domain/http";
import type {
  HttpTransportProgress,
  HttpTransportPort,
  HttpTransportResponse,
} from "../../../application/ports/http";
import type { ResponseContentPort } from "../../../application/ports/response-content";
import { base64Bytes } from "../model/request-auth";
import type { SessionCookieJar } from "../model/cookie-jar";

export type WireRequest = HttpRequestSnapshot;
export type WireResponse = HttpTransportResponse;
export type HttpTransport = HttpTransportPort;
const materializationWindowBytes = 192 * 1024;

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
  } = {},
): Promise<InlineHttpResponse> {
  const current = { ...request, headers: [...request.headers] };
  const initial = requireHttpUrl(current.url);
  const started = Date.now();
  let crossedOrigin = false;
  let crossedSite = false;
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
      { signal: options.signal, onProgress: options.onProgress },
    );
    if (options.signal?.aborted) {
      if (isReferencedResponse(response) && options.content)
        await options.content.release(response.content);
      throwIfAborted(options.signal);
    }
    const completedAtMs = Date.now();
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
        current.headers = current.headers.filter(
          ([name]) =>
            !["content-type", "content-length"].includes(name.toLowerCase()),
        );
      }
      current.url = next.toString();
      continue;
    }
    const transportMs = Math.max(0, Number(response.durationMs) || 0);
    const waitingMs = Math.max(
      0,
      Math.min(
        transportMs,
        Number(response.headersDurationMs ?? transportMs) || 0,
      ),
    );
    const downloadMs = Math.max(
      0,
      Math.min(
        transportMs - waitingMs,
        Number(response.downloadDurationMs ?? transportMs - waitingMs) || 0,
      ),
    );
    const totalMs = Math.max(transportMs, completedAtMs - started);
    const displayRequest = options.displayRequest ? {
      ...options.displayRequest,
      // Never replace the already-redacted URL with the request that actually
      // went over the wire. Redirects may make the displayed URL less exact,
      // but exposing a secret query variable is a much worse failure mode.
      url: options.displayRequest.url,
      method: current.method,
      headers: [
        ...options.displayRequest.headers.filter(([name]) => name.toLowerCase() !== "cookie"),
        ...headers.filter(([name]) => name.toLowerCase() === "cookie").map(([name, value]): [string, string] => [name, maskCookieHeader(value)]),
      ],
    } : undefined;
    const timeline = {
        startedAtMs: started,
        prepareMs: Math.max(0, totalMs - waitingMs - downloadMs),
        waitingMs,
        downloadMs,
        completedAtMs: started + totalMs,
        request: { url: current.url, method: current.method, headers, bodyBase64: current.bodyBase64 },
        displayRequest,
        followRedirects: options.followRedirects !== false,
        usesCookieJar: Boolean(options.jar),
        timeoutMs: 60_000,
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
          durationMs: totalMs,
          headersDurationMs: response.headersDurationMs,
          downloadDurationMs: response.downloadDurationMs,
          httpVersion: response.httpVersion,
          localAddress: response.localAddress,
          remoteAddress: response.remoteAddress,
        },
        content: response.content,
        timeline,
      };
      try {
        return await materializeHttpExchange(exchange, options.content, options.signal);
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
      durationMs: totalMs,
      timeline,
    });
  }
  throw new Error("Request failed.");
}
