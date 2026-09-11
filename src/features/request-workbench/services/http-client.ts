import { invoke, isTauri } from "@tauri-apps/api/core";
import { getPublicSuffix } from "tough-cookie";
import { base64Bytes } from "../model/request-auth";
import type { SessionCookieJar } from "../model/cookie-jar";

export type WireRequest = {
  url: string;
  method: string;
  headers: [string, string][];
  bodyBase64: string | null;
};
export type WireResponse = {
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
export type HttpTimeline = {
  startedAtMs: number;
  prepareMs: number;
  waitingMs: number;
  downloadMs: number;
  completedAtMs: number;
  request: WireRequest;
  followRedirects: boolean;
  usesCookieJar: boolean;
  timeoutMs: number;
};
export type HttpResult = WireResponse & {
  url: string;
  text: string;
  size: number;
  timeline: HttpTimeline;
};
export type HttpTransport = (request: WireRequest) => Promise<WireResponse>;
export const nativeTransport: HttpTransport = (request) => {
  if (!isTauri())
    return Promise.reject(
      new Error(
        "Send requests and authorize OAuth in the Purr desktop app (npm run tauri dev).",
      ),
    );
  return invoke<WireResponse>("send_http", { request });
};
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

export async function executeHttp(
  request: WireRequest,
  options: {
    jar?: SessionCookieJar;
    transport?: HttpTransport;
    sensitiveHeaders?: string[];
    sensitiveQueryParams?: string[];
    followRedirects?: boolean;
  } = {},
): Promise<HttpResult> {
  const current = { ...request, headers: [...request.headers] };
  const initial = requireHttpUrl(current.url);
  const started = Date.now();
  let crossedOrigin = false;
  let crossedSite = false;
  for (let hop = 0; hop <= 10; hop++) {
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
    const response = await (options.transport ?? nativeTransport)({
      ...current,
      headers,
    });
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
    const bytes = Uint8Array.from(atob(response.bodyBase64), (char) =>
      char.charCodeAt(0),
    );
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
    return {
      ...response,
      url: current.url || initial.toString(),
      text: new TextDecoder().decode(bytes),
      size: bytes.length,
      durationMs: totalMs,
      timeline: {
        startedAtMs: started,
        prepareMs: Math.max(0, totalMs - waitingMs - downloadMs),
        waitingMs,
        downloadMs,
        completedAtMs: started + totalMs,
        request: { url: current.url, method: current.method, headers, bodyBase64: current.bodyBase64 },
        followRedirects: options.followRedirects !== false,
        usesCookieJar: Boolean(options.jar),
        timeoutMs: 60_000,
      },
    };
  }
  throw new Error("Request failed.");
}
