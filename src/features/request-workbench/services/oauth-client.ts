import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  base64Bytes,
  encodeBasicAuth,
  resolveAuthValue,
  type AuthContext,
  type OAuthConfig,
  type OAuthToken,
} from "../model/request-auth";
import { executeHttp, requireHttpUrl, type HttpTransport } from "./http-client";

const formEncode = (value: string) =>
  new URLSearchParams({ v: value }).toString().slice(2);
const base64Url = (bytes: Uint8Array) =>
  base64Bytes(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export async function createPkce(
  verifier = base64Url(crypto.getRandomValues(new Uint8Array(32))),
) {
  const challenge = base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  return {
    verifier,
    challenge,
    state: base64Url(crypto.getRandomValues(new Uint8Array(32))),
  };
}
export function requireOAuthUrl(value: string) {
  const url = requireHttpUrl(value);
  if (
    url.protocol !== "https:" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error(
      "OAuth endpoints require HTTPS. HTTP is supported for local development.",
    );
  if (url.hash)
    throw new Error("OAuth endpoint URLs cannot contain a fragment.");
  return url;
}
export function resolvedOAuth(
  config: OAuthConfig,
  context: AuthContext = {},
): OAuthConfig {
  const read = (value: string) => resolveAuthValue(value, context);
  return {
    ...config,
    clientId: read(config.clientId),
    clientSecret: read(config.clientSecret),
    tokenUrl: read(config.tokenUrl),
    authorizationUrl: read(config.authorizationUrl),
    scopes: read(config.scopes),
    redirectUri: read(config.redirectUri),
  };
}
// Ignores token/refresh preferences so in-flight work may be accepted only for the same client and endpoints.
export const oauthIdentity = (config: OAuthConfig) =>
  JSON.stringify([
    config.grantType,
    config.authorizationUrl,
    config.tokenUrl,
    config.clientId,
    config.clientSecret,
    config.scopes,
    config.redirectUri,
    config.clientAuthentication,
  ]);

export async function fetchOAuthToken(
  config: OAuthConfig,
  grant: "initial" | "refresh",
  code?: { code: string; verifier: string },
  transport?: HttpTransport,
): Promise<OAuthToken> {
  requireOAuthUrl(config.tokenUrl);
  if (!config.clientId.trim()) throw new Error("Enter a Client ID.");
  const params = new URLSearchParams();
  if (grant === "refresh" && config.token?.refreshToken) {
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", config.token.refreshToken);
  } else if (config.grantType === "client_credentials") {
    if (!config.clientSecret) throw new Error("Enter a Client Secret.");
    params.set("grant_type", "client_credentials");
    if (config.scopes.trim())
      params.set("scope", config.scopes.trim().replace(/\s+/g, " "));
  } else {
    if (!code) throw new Error("Authorize in the browser to get a new token.");
    params.set("grant_type", "authorization_code");
    params.set("code", code.code);
    params.set("code_verifier", code.verifier);
    params.set("redirect_uri", config.redirectUri);
  }
  const headers: [string, string][] = [
    ["Content-Type", "application/x-www-form-urlencoded"],
    ["Accept", "application/json"],
  ];
  if (config.clientAuthentication === "basic" && config.clientSecret) {
    headers.push([
      "Authorization",
      "Basic " +
        encodeBasicAuth(
          formEncode(config.clientId),
          formEncode(config.clientSecret),
        ),
    ]);
  } else {
    params.set("client_id", config.clientId);
    if (config.clientSecret) params.set("client_secret", config.clientSecret);
  }
  const result = await executeHttp(
    {
      url: config.tokenUrl,
      method: "POST",
      headers,
      bodyBase64: base64Bytes(new TextEncoder().encode(params.toString())),
    },
    { transport, followRedirects: false },
  );
  // OAuth response bodies can contain secrets. Expose only a known error identifier.
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(result.text);
  } catch {
    throw new Error(
      `Token endpoint returned non-JSON (HTTP ${result.status}).`,
    );
  }
  if (!data || typeof data !== "object")
    throw new Error("Invalid token response.");
  if (result.status < 200 || result.status >= 300 || data.error) {
    const known = [
      "invalid_request",
      "invalid_client",
      "invalid_grant",
      "unauthorized_client",
      "unsupported_grant_type",
      "invalid_scope",
      "access_denied",
    ];
    throw new Error(
      `Token request failed (HTTP ${result.status}${known.includes(String(data.error)) ? ": " + data.error : ""}). Check the grant, client credentials and scopes.`,
    );
  }
  if (
    typeof data.access_token !== "string" ||
    !data.access_token ||
    /\s/.test(data.access_token)
  )
    throw new Error("The provider did not return a valid access token.");
  if (
    typeof data.token_type !== "string" ||
    data.token_type.toLowerCase() !== "bearer"
  )
    throw new Error(
      "This provider returned an unsupported token type. Purr currently supports Bearer tokens.",
    );
  const obtainedAt = Date.now();
  const expiresIn = Number(data.expires_in);
  if (
    data.expires_in !== undefined &&
    (!Number.isFinite(expiresIn) || expiresIn <= 0)
  )
    throw new Error(
      "The provider returned an invalid or already expired token lifetime.",
    );
  return {
    accessToken: data.access_token,
    tokenType: "Bearer",
    obtainedAt,
    expiresAt:
      data.expires_in !== undefined &&
      Number.isFinite(expiresIn) &&
      expiresIn >= 0
        ? obtainedAt + expiresIn * 1000
        : undefined,
    refreshToken:
      typeof data.refresh_token === "string" && data.refresh_token
        ? data.refresh_token
        : grant === "refresh"
          ? config.token?.refreshToken
          : undefined,
    scope:
      typeof data.scope === "string"
        ? data.scope
        : (config.token?.scope ?? config.scopes),
  };
}

export async function authorizeOAuth(
  config: OAuthConfig,
  sessionId: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!isTauri())
    throw new Error("Open Purr desktop to authorize using the system browser.");
  const authorization = requireOAuthUrl(config.authorizationUrl);
  requireOAuthUrl(config.tokenUrl);
  if (!config.clientId.trim()) throw new Error("Enter a Client ID.");
  const redirect = requireHttpUrl(config.redirectUri);
  if (
    redirect.hostname !== "127.0.0.1" ||
    redirect.protocol !== "http:" ||
    !redirect.port ||
    redirect.search ||
    redirect.hash
  )
    throw new Error(
      "Use a callback such as http://127.0.0.1:8976/oauth/callback and register it with your provider.",
    );
  const pkce = await createPkce();
  signal?.throwIfAborted();
  const values = {
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.trim().replace(/\s+/g, " "),
    state: pkce.state,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  };
  Object.entries(values).forEach(([key, value]) =>
    authorization.searchParams.set(key, value),
  );
  const code = await invoke<string>("authorize_oauth", {
    authorizationUrl: authorization.toString(),
    redirectUri: config.redirectUri,
    state: pkce.state,
    sessionId,
  });
  signal?.throwIfAborted();
  return fetchOAuthToken(config, "initial", { code, verifier: pkce.verifier });
}
export async function cancelOAuth(sessionId: string) {
  if (isTauri()) await invoke("cancel_oauth", { sessionId });
}
