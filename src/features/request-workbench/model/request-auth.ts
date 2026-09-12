import { resolveEnvironmentValue } from "../../../shared/lib/resolve-variables";

export const authTypeOptions = [
  { value: "none", label: "None" },
  { value: "bearer", label: "Bearer Token" },
  { value: "basic", label: "Basic Auth" },
  { value: "api-key", label: "API Key" },
  { value: "oauth2", label: "OAuth 2.0" },
  { value: "inherit", label: "Inherit" },
] as const;
export type AuthType = (typeof authTypeOptions)[number]["value"];
export type OAuthToken = {
  accessToken: string;
  tokenType: "Bearer";
  refreshToken?: string;
  obtainedAt: number;
  expiresAt?: number;
  scope?: string;
};
export type OAuthConfig = {
  grantType: "client_credentials" | "authorization_code";
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri: string;
  clientAuthentication: "body" | "basic";
  autoRefresh: boolean;
  token: OAuthToken | null;
};
export type RequestAuth = {
  credentialStorage?: { bearer?: "plain" | "secret" };
  secretRefs?: Record<string, string>;
  type: AuthType;
  bearer: {
    token: string;
    prefix: string;
  };
  basic: { username: string; password: string };
  apiKey: {
    name: string;
    value: string;
    placement: "header" | "query" | "cookie";
  };
  oauth2: OAuthConfig;
  inherit: { source: "auto" | "workspace" | "environment" };
};
export type AuthProfile = { id: string; name: string; auth: RequestAuth };
export type AuthContext = {
  workspace?: AuthProfile;
  environment?: AuthProfile;
  variables?: Record<string, string>;
  sensitiveVariableNames?: readonly string[];
  requestDocumentId?: string;
};
export type AuthBinding = {
  target: "header" | "query" | "cookie";
  name: string;
  value: string;
};

export function createRequestAuth(): RequestAuth {
  return {
    type: "none",
    bearer: {
      token: "",
      prefix: "Bearer",
    },
    basic: { username: "", password: "" },
    apiKey: { name: "", value: "", placement: "header" },
    oauth2: {
      grantType: "client_credentials",
      authorizationUrl: "",
      tokenUrl: "",
      clientId: "",
      clientSecret: "",
      scopes: "",
      redirectUri: "http://127.0.0.1:8976/oauth/callback",
      clientAuthentication: "body",
      autoRefresh: true,
      token: null,
    },
    inherit: { source: "auto" },
  };
}

export function normalizeRequestAuth(auth: RequestAuth): RequestAuth {
  const defaults = createRequestAuth();
  return {
    ...defaults,
    ...auth,
    bearer: { ...defaults.bearer, ...auth?.bearer },
    basic: { ...defaults.basic, ...auth?.basic },
    apiKey: { ...defaults.apiKey, ...auth?.apiKey },
    oauth2: { ...defaults.oauth2, ...auth?.oauth2 },
    inherit: { ...defaults.inherit, ...auth?.inherit },
  };
}

export function resolveAuth(
  auth: RequestAuth,
  context: AuthContext = {},
): { auth: RequestAuth; source?: AuthProfile; error?: string } {
  let current = auth;
  let source: AuthProfile | undefined;
  const visited = new Set<RequestAuth>();
  while (current.type === "inherit") {
    if (visited.has(current))
      return {
        auth: current,
        error: "Authentication inheritance contains a cycle.",
      };
    visited.add(current);
    source =
      current.inherit.source === "workspace"
        ? context.workspace
        : current.inherit.source === "environment"
          ? context.environment
          : source === context.environment
            ? context.workspace
            : (context.environment ?? context.workspace);
    if (!source)
      return {
        auth: current,
        error:
          "No authentication is configured for this workspace or environment.",
      };
    current = source.auth;
  }
  return { auth: current, source };
}

export function resolveAuthValue(
  value: string,
  context: AuthContext = {},
): string {
  return resolveEnvironmentValue(value, context.variables ?? {});
}

export function base64Bytes(bytes: Uint8Array): string {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}
export const encodeBasicAuth = (username: string, password: string) =>
  base64Bytes(new TextEncoder().encode(username + ":" + password));

export function getBearerToken(auth: RequestAuth, context: AuthContext = {}) {
  return resolveAuthValue(auth.bearer.token, context)
    .trim()
    .replace(/^Bearer\s+/i, "");
}

export function getAuthBindingForRequest(
  auth: RequestAuth,
  requestUrl: string,
  context: AuthContext = {},
) {
  void requestUrl;
  return getAuthBinding(auth, context);
}

const httpToken = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
export function getAuthBinding(
  auth: RequestAuth,
  context: AuthContext = {},
): { binding?: AuthBinding; error?: string } {
  const resolved = resolveAuth(auth, context);
  if (resolved.error) return { error: resolved.error };
  const current = resolved.auth;
  const read = (value: string) => resolveAuthValue(value, context);
  let binding: AuthBinding | undefined;
  try {
    switch (current.type) {
      case "none":
        return {};
      case "bearer": {
        const token = getBearerToken(current, context);
        if (!token) return { error: "Enter a bearer token." };
        if (/\s/.test(token))
          return { error: "A bearer token cannot contain whitespace." };
        const prefix = read(current.bearer.prefix).trim();
        if (prefix && !httpToken.test(prefix))
          return { error: "Enter a valid token prefix." };
        binding = {
          target: "header",
          name: "Authorization",
          value: [prefix, token].filter(Boolean).join(" "),
        };
        break;
      }
      case "basic": {
        const username = read(current.basic.username);
        if (!username && !current.basic.password)
          return { error: "Enter a username and password." };
        if (username.includes(":"))
          return { error: "A Basic Auth username cannot contain a colon." };
        binding = {
          target: "header",
          name: "Authorization",
          value:
            "Basic " + encodeBasicAuth(username, read(current.basic.password)),
        };
        break;
      }
      case "api-key": {
        const name = read(current.apiKey.name).trim();
        const value = read(current.apiKey.value);
        if (!name || !value)
          return { error: "Enter an API key name and value." };
        if (current.apiKey.placement !== "query" && !httpToken.test(name))
          return { error: "Enter a valid header or cookie name." };
        if (
          current.apiKey.placement === "header" &&
          [
            "host",
            "content-length",
            "cookie",
            "content-type",
            "connection",
            "transfer-encoding",
          ].includes(name.toLowerCase())
        )
          return {
            error:
              "Choose an authentication header such as X-API-Key or Authorization. For cookies, select Add to Cookie.",
          };
        binding = {
          target: current.apiKey.placement,
          name,
          value:
            current.apiKey.placement === "cookie"
              ? encodeURIComponent(value)
              : value,
        };
        break;
      }
      case "oauth2": {
        if (!current.oauth2.token)
          return { error: "Get an access token to authorize this request." };
        binding = {
          target: "header",
          name: "Authorization",
          value: "Bearer " + current.oauth2.token.accessToken,
        };
        break;
      }
    }
    if (binding && /[\r\n\0]/.test(binding.name + binding.value))
      return {
        error: "Authentication cannot contain line breaks or null characters.",
      };
    return {
      binding,
      ...(current.type === "oauth2" &&
      current.oauth2.token?.expiresAt !== undefined &&
      current.oauth2.token.expiresAt <= Date.now()
        ? { error: "Access token expired. Refresh the token before sending." }
        : {}),
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Could not resolve authentication.",
    };
  }
}

export function inspectJwt(
  token: string,
): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  expiresAt?: number;
} | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const decode = (part: string) =>
      JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(
            atob(part.replace(/-/g, "+").replace(/_/g, "/")),
            (c) => c.charCodeAt(0),
          ),
        ),
      );
    const header = decode(parts[0]);
    const claims = decode(parts[1]);
    if (
      !header ||
      !claims ||
      typeof header !== "object" ||
      typeof claims !== "object" ||
      Array.isArray(header) ||
      Array.isArray(claims)
    )
      return null;
    return {
      header,
      claims,
      expiresAt: typeof claims.exp === "number" ? claims.exp * 1000 : undefined,
    };
  } catch {
    return null;
  }
}

export function tokenExpiryLabel(
  expiresAt: number | undefined,
  now = Date.now(),
) {
  if (expiresAt === undefined) return "Expiry not provided";
  if (expiresAt <= now) return "Expired";
  const seconds = Math.ceil((expiresAt - now) / 1000);
  return seconds < 60
    ? `Expires in ${seconds}s`
    : `Expires in ${Math.ceil(seconds / 60)}m`;
}
