/**
 * Versioned local editor DTO, shared by drafts, clean sessions and history.
 * Apply after secret protection and expand before secret resolution. Defaults
 * belong to this format version; changing UI defaults must not change history.
 */
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof File);
const defaultsV1: ObjectValue = {
  documentation: "",
  params: [{ id: "param-1", key: "", value: "", enabled: false }],
  pathParams: [],
  headers: [{ id: "header-1", name: "", value: "", enabled: false }],
  body: {
    type: "none", autoConvert: false, json: "", xml: "", text: "", binary: null,
    formData: [{ id: "form-data-1", key: "", value: "", enabled: false }],
    urlEncoded: [{ id: "url-encoded-1", key: "", value: "", enabled: false }],
  },
  auth: {
    type: "none", bearer: { token: "", prefix: "Bearer" }, basic: { username: "", password: "" },
    apiKey: { name: "", value: "", placement: "header" },
    oauth2: {
      grantType: "client_credentials", authorizationUrl: "", tokenUrl: "", clientId: "", clientSecret: "", scopes: "",
      redirectUri: "http://127.0.0.1:8976/oauth/callback", clientAuthentication: "body", autoRefresh: true, token: null,
    },
    inherit: { source: "auto" },
  },
  useCookieJar: true,
  workspace: { headersEnabled: true, authEnabled: true, headerOverrides: {} },
};

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => equal(value, right[index]));
  if (object(left) && object(right)) {
    const keys = Object.keys(left).filter((key) => left[key] !== undefined);
    return keys.length === Object.keys(right).length && keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && equal(left[key], right[key]));
  }
  return false;
}

function subtract(value: ObjectValue, defaults: ObjectValue): ObjectValue {
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (child === undefined || Object.prototype.hasOwnProperty.call(defaults, key) && equal(child, defaults[key])) return [];
    return [[key, object(child) && object(defaults[key]) ? subtract(child, defaults[key]) : child]];
  }));
}

function expand(value: ObjectValue, defaults: ObjectValue): ObjectValue {
  const result = structuredClone(defaults);
  for (const [key, child] of Object.entries(value)) result[key] = object(child) && object(defaults[key]) ? expand(child, defaults[key]) : child;
  return result;
}

export function compactLocalRequest(value: unknown): unknown {
  if (!object(value)) throw new Error("Invalid local request editor.");
  const source = { ...value };
  // An unused generated multipart boundary has no request semantics. Retain it
  // whenever any body editor mode has content/configuration, including inactive modes.
  if (object(source.body)) {
    const { boundary: _boundary, ...body } = source.body;
    if (typeof _boundary === "string" && /^purr-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(_boundary)
      && equal(body, defaultsV1.body)) source.body = body;
  }
  return { __purrRequest: 1, ...subtract(source, defaultsV1) };
}

export function expandLocalRequest(value: unknown, emptyBoundary = "purr-" + crypto.randomUUID()): unknown {
  if (!object(value) || !("__purrRequest" in value)) return value; // Full legacy editor DTO.
  if (value.__purrRequest !== 1) throw new Error("Unsupported local request editor format. Existing data has not been changed.");
  const { __purrRequest: _version, ...source } = value;
  const result = expand(source, defaultsV1);
  if (object(result.body) && result.body.boundary === undefined) result.body.boundary = emptyBoundary;
  return result;
}

export function compactLocalRequestDocument(value: unknown): unknown {
  if (!object(value) || value.kind !== "http" && value.kind !== "graphql") return value;
  return { ...value, request: compactLocalRequest(value.request), ...(value.savedRequest ? { savedRequest: compactLocalRequest(value.savedRequest) } : {}) };
}

export function expandLocalRequestDocument(value: unknown): unknown {
  if (!object(value) || value.kind !== "http" && value.kind !== "graphql") return value;
  const boundary = "purr-" + crypto.randomUUID();
  return { ...value, request: expandLocalRequest(value.request, boundary), ...(value.savedRequest ? { savedRequest: expandLocalRequest(value.savedRequest, boundary) } : {}) };
}
