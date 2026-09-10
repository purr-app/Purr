import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureBearerResponseToken,
  createRequestAuth,
  encodeBasicAuth,
  getAuthBinding,
  inspectJwt,
  readResponseToken,
  readResponseTokenExpression,
  resolveAuth,
  type AuthContext,
} from "../src/features/request-workbench/model/request-auth";
import {
  getRequestHeaders,
  getRequestQueryParams,
  initialRequestDraft,
  updateRequestHeaders,
  updateRequestQueryParams,
} from "../src/features/request-workbench/model/request";
import { SessionCookieJar } from "../src/features/request-workbench/model/cookie-jar";
import {
  createPkce,
  fetchOAuthToken,
} from "../src/features/request-workbench/services/oauth-client";
import {
  executeHttp,
  type HttpTransport,
  type WireRequest,
  type WireResponse,
} from "../src/features/request-workbench/services/http-client";

const response = (
  data: unknown,
  status = 200,
  headers: [string, string][] = [],
): WireResponse => ({
  status,
  statusText: "OK",
  headers,
  durationMs: 1,
  bodyBase64: Buffer.from(JSON.stringify(data)).toString("base64"),
});
const request = (url = "https://api.example.com"): WireRequest => ({
  url,
  method: "GET",
  headers: [],
  bodyBase64: null,
});

test("max-age cookies display their actual expiry and disabled jar cookies remain excluded", () => {
  const jar = new SessionCookieJar();
  jar.receive("https://example.com", [
    ["Set-Cookie", "sid=one; Max-Age=60; Path=/"],
  ]);
  const cookie = jar.list()[0];
  assert.ok(cookie.expires);
  assert.ok(new Date(cookie.expires!).getTime() > Date.now());
  assert.equal(jar.header("https://example.com", "none"), "");
});

test("same-site subdomain redirects retain site cookies but drop API-key credentials", async () => {
  const jar = new SessionCookieJar();
  jar.receive("https://api.example.com", [
    [
      "Set-Cookie",
      "sid=one; Domain=example.com; Path=/; SameSite=Strict; Secure",
    ],
  ]);
  let count = 0;
  await executeHttp(
    {
      ...request("https://api.example.com?key=secret"),
      headers: [["Authorization", "Bearer secret"]],
    },
    {
      jar,
      sensitiveQueryParams: ["key"],
      transport: async (req) => {
        if (++count === 1)
          return response({}, 302, [
            ["Location", "https://other.example.com/?key=secret"],
          ]);
        assert.equal(new URL(req.url).searchParams.has("key"), false);
        assert.ok(
          req.headers.some(
            ([name, value]) => name === "Cookie" && value === "sid=one",
          ),
        );
        assert.ok(!req.headers.some(([name]) => name === "Authorization"));
        return response({});
      },
    },
  );
});

test("an already-expired provider token is rejected instead of triggering endless refresh", async () => {
  const config = {
    ...createRequestAuth().oauth2,
    clientId: "client",
    clientSecret: "secret",
    tokenUrl: "https://auth.example.com/token",
  };
  await assert.rejects(
    fetchOAuthToken(config, "initial", undefined, async () =>
      response({
        access_token: "expired",
        token_type: "Bearer",
        expires_in: 0,
      }),
    ),
    /already expired/,
  );
});

test("None adds nothing; Bearer normalizes pasted prefix, never doubles it", () => {
  const auth = createRequestAuth();
  assert.deepEqual(getAuthBinding(auth), {});
  auth.type = "bearer";
  auth.bearer.token = "Bearer test-token";
  assert.equal(getAuthBinding(auth).binding?.value, "Bearer test-token");
  auth.bearer.token = "token\ninjection";
  assert.ok(getAuthBinding(auth).error);
});
test("Basic encodes UTF-8 credentials and rejects colons in usernames", () => {
  assert.equal(
    encodeBasicAuth("Aladdin", "open sesame"),
    "QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
  );
  const auth = createRequestAuth();
  auth.type = "basic";
  auth.basic = { username: "Ігор", password: "пароль:123" };
  assert.equal(
    getAuthBinding(auth).binding?.value,
    "Basic " + Buffer.from("Ігор:пароль:123").toString("base64"),
  );
  auth.basic.username = "invalid:name";
  assert.ok(getAuthBinding(auth).error);
});
test("auth headers are locked and switching None restores manual credentials", () => {
  const auth = createRequestAuth();
  auth.type = "bearer";
  auth.bearer.token = "managed";
  let draft = {
    ...initialRequestDraft,
    auth,
    headers: [
      {
        id: "manual",
        name: "authorization",
        value: "Manual original",
        enabled: true,
      },
    ],
  };
  const headers = getRequestHeaders(draft);
  assert.equal(headers.length, 1);
  assert.equal(headers[0].readOnly, true);
  draft = updateRequestHeaders(draft, [
    ...headers,
    { id: "other", name: "X-Test", value: "new", enabled: true },
  ]);
  draft.auth = { ...auth, type: "none" };
  assert.equal(getRequestHeaders(draft)[0].value, "Manual original");
  assert.equal(getRequestHeaders(draft)[1].name, "X-Test");
});
test("API key supports header/query/cookie without persisting generated values", () => {
  const auth = createRequestAuth();
  auth.type = "api-key";
  for (const placement of ["header", "query", "cookie"] as const) {
    auth.apiKey = { placement, name: "api_key", value: "a b&c" };
    assert.equal(getAuthBinding(auth).binding?.target, placement);
  }
  assert.equal(getAuthBinding(auth).binding?.value, "a%20b%26c");
  auth.apiKey.placement = "query";
  const draft = {
    ...initialRequestDraft,
    auth,
    params: [
      { id: "manual", key: "api_key", value: "original", enabled: true },
    ],
  };
  const params = getRequestQueryParams(draft);
  assert.equal(params.length, 1);
  assert.equal(params[0].readOnly, true);
  const updated = updateRequestQueryParams(draft, [
    ...params,
    { id: "other", key: "page", value: "2", enabled: true },
  ]);
  assert.equal(updated.params[0].value, "original");
  assert.equal(updated.params[1].key, "page");
});
test("API key cookie merges manual cookies by name", () => {
  const auth = createRequestAuth();
  auth.type = "api-key";
  auth.apiKey = { name: "key", value: "new", placement: "cookie" };
  const draft = {
    ...initialRequestDraft,
    auth,
    headers: [
      {
        id: "cookie",
        name: "Cookie",
        value: "session=one; key=old",
        enabled: true,
      },
    ],
  };
  assert.equal(getRequestHeaders(draft)[0].value, "session=one; key=new");
});
test("Inherit resolves environment before workspace and observes live token changes", () => {
  const auth = createRequestAuth();
  auth.type = "inherit";
  const parent = createRequestAuth();
  parent.type = "bearer";
  parent.bearer.token = "{{ACCESS_TOKEN}}";
  const context: AuthContext = {
    workspace: { id: "ws", name: "Backend", auth: parent },
    variables: { ACCESS_TOKEN: "one" },
  };
  assert.equal(getAuthBinding(auth, context).binding?.value, "Bearer one");
  context.variables!.ACCESS_TOKEN = "two";
  assert.equal(getAuthBinding(auth, context).binding?.value, "Bearer two");
  context.environment = { id: "env", name: "Local", auth: createRequestAuth() };
  assert.equal(resolveAuth(auth, context).auth.type, "none");
  context.environment.auth = { ...createRequestAuth(), type: "inherit" };
  assert.equal(resolveAuth(auth, context).source?.id, "ws");
  parent.type = "inherit";
  assert.match(resolveAuth(auth, context).error!, /cycle/);
});
test("missing variables and inherited profiles fail visibly", () => {
  const auth = createRequestAuth();
  auth.type = "basic";
  auth.basic = { username: "user", password: "{{PASSWORD}}" };
  assert.match(getAuthBinding(auth).error!, /not defined/);
  auth.type = "inherit";
  assert.ok(getAuthBinding(auth).error);
});
test("response token chaining reads JSON Pointer without prototype traversal", () => {
  assert.equal(
    readResponseToken(
      { data: { "access/token": "abc" } },
      "/data/access~1token",
    ),
    "abc",
  );
  assert.throws(() => readResponseToken({}, "/constructor"));
  assert.throws(() =>
    readResponseToken({ access_token: 123 }, "/access_token"),
  );
});
test("response token automation matches an endpoint and reads a jq-style path", () => {
  assert.equal(
    readResponseTokenExpression({ auth: { tokens: [{ value: "abc" }] } }, ".auth.tokens[0].value"),
    "abc",
  );
  assert.equal(
    readResponseTokenExpression({ auth: { token: "abc" } }, "$response.auth.token"),
    "abc",
  );
  const auth = createRequestAuth();
  auth.type = "bearer";
  auth.bearer.source = "response";
  auth.bearer.endpointPath = "/oauth/token";
  auth.bearer.expression = ".auth.token";
  const unchanged = captureBearerResponseToken(
    auth,
    "https://api.example.com/users",
    { auth: { token: "wrong" } },
  );
  assert.equal(unchanged, auth);
  const captured = captureBearerResponseToken(
    auth,
    "https://api.example.com/oauth/token?scope=read",
    { auth: { token: "fresh" } },
  );
  assert.equal(getAuthBinding(captured).binding?.value, "Bearer fresh");

  auth.bearer.endpointDocumentId = "token-request";
  auth.bearer.receivedToken = "";
  const wrongDocument = captureBearerResponseToken(
    auth,
    "https://api.example.com/oauth/token",
    { auth: { token: "wrong" } },
    "another-request",
  );
  assert.equal(wrongDocument, auth);
  const capturedByDocument = captureBearerResponseToken(
    auth,
    "https://api.example.com/any-path",
    { auth: { token: "document-token" } },
    "token-request",
  );
  assert.equal(getAuthBinding(capturedByDocument).binding?.value, "Bearer document-token");
});
test("JWT inspection decodes Unicode and never claims signature verification", () => {
  const token = [
    Buffer.from('{"alg":"RS256"}').toString("base64url"),
    Buffer.from('{"name":"Ігор","exp":123}').toString("base64url"),
    "signature",
  ].join(".");
  const decoded = inspectJwt(token);
  assert.equal(decoded?.claims.name, "Ігор");
  assert.equal(decoded?.expiresAt, 123000);
  assert.equal(inspectJwt("opaque-token"), null);
});
test("PKCE matches the RFC 7636 S256 test vector", async () => {
  const pkce = await createPkce("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
  assert.equal(pkce.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.ok(pkce.state.length >= 43);
});
test("OAuth client credentials uses form encoding and optional Basic client authentication", async () => {
  const config = {
    ...createRequestAuth().oauth2,
    tokenUrl: "https://auth.example.com/token",
    clientId: "id:with space",
    clientSecret: "secret&value",
    scopes: "read write",
  };
  let captured!: WireRequest;
  const transport: HttpTransport = async (req) => {
    captured = req;
    return response({
      access_token: "access",
      token_type: "Bearer",
      expires_in: 60,
    });
  };
  const token = await fetchOAuthToken(config, "initial", undefined, transport);
  const body = new URLSearchParams(
    Buffer.from(captured.bodyBase64!, "base64").toString(),
  );
  assert.equal(body.get("grant_type"), "client_credentials");
  assert.equal(body.get("client_secret"), "secret&value");
  assert.equal(token.expiresAt! - token.obtainedAt, 60000);
  await fetchOAuthToken(
    { ...config, clientAuthentication: "basic" },
    "initial",
    undefined,
    transport,
  );
  assert.ok(captured.headers.some(([name]) => name === "Authorization"));
  assert.equal(
    new URLSearchParams(
      Buffer.from(captured.bodyBase64!, "base64").toString(),
    ).has("client_secret"),
    false,
  );
});
test("OAuth refresh token rotation preserves refresh token when omitted", async () => {
  const config = {
    ...createRequestAuth().oauth2,
    grantType: "authorization_code" as const,
    tokenUrl: "https://auth.example.com/token",
    clientId: "client",
    token: {
      accessToken: "old",
      tokenType: "Bearer" as const,
      obtainedAt: 0,
      refreshToken: "refresh-one",
    },
  };
  const rotated = await fetchOAuthToken(
    config,
    "refresh",
    undefined,
    async (req) => {
      const body = new URLSearchParams(
        Buffer.from(req.bodyBase64!, "base64").toString(),
      );
      assert.equal(body.get("refresh_token"), "refresh-one");
      assert.equal(body.get("grant_type"), "refresh_token");
      return response({
        access_token: "new",
        token_type: "bearer",
        refresh_token: "refresh-two",
      });
    },
  );
  assert.equal(rotated.refreshToken, "refresh-two");
  const again = await fetchOAuthToken(
    { ...config, token: rotated },
    "refresh",
    undefined,
    async () => response({ access_token: "newer", token_type: "Bearer" }),
  );
  assert.equal(again.refreshToken, "refresh-two");
});
test("OAuth code exchange sends verifier and callback; never follows token endpoint redirects", async () => {
  const config = {
    ...createRequestAuth().oauth2,
    grantType: "authorization_code" as const,
    clientId: "client",
    tokenUrl: "http://127.0.0.1:8000/token",
  };
  await fetchOAuthToken(
    config,
    "initial",
    { code: "code", verifier: "verifier" },
    async (req) => {
      const body = new URLSearchParams(
        Buffer.from(req.bodyBase64!, "base64").toString(),
      );
      assert.equal(body.get("code_verifier"), "verifier");
      assert.equal(body.get("redirect_uri"), config.redirectUri);
      return response({ access_token: "token", token_type: "Bearer" });
    },
  );
  let calls = 0;
  await assert.rejects(
    fetchOAuthToken(
      config,
      "initial",
      { code: "code", verifier: "v" },
      async () => {
        calls++;
        return response({}, 302, [
          ["Location", "https://elsewhere.example/token"],
        ]);
      },
    ),
  );
  assert.equal(calls, 1);
});
test("OAuth rejects insecure endpoints, unsupported token types and avoids leaking error bodies", async () => {
  const config = {
    ...createRequestAuth().oauth2,
    clientId: "client",
    clientSecret: "secret",
    tokenUrl: "http://auth.example.com/token",
  };
  await assert.rejects(fetchOAuthToken(config, "initial"), /HTTPS/);
  config.tokenUrl = "https://auth.example.com/token";
  await assert.rejects(
    fetchOAuthToken(config, "initial", undefined, async () =>
      response(
        { error: "invalid_client", error_description: "secret-token-in-error" },
        401,
      ),
    ),
    (error) => !String(error).includes("secret-token-in-error"),
  );
  await assert.rejects(
    fetchOAuthToken(config, "initial", undefined, async () =>
      response({ access_token: "token", token_type: "DPoP" }),
    ),
    /unsupported token type/,
  );
});
test("cookie jar enforces domain, path, Secure, HttpOnly, SameSite and expiration", () => {
  const jar = new SessionCookieJar();
  jar.receive("https://api.example.com/login", [
    ["Set-Cookie", "sid=one; Secure; HttpOnly; Path=/; SameSite=Strict"],
    ["Set-Cookie", "scoped=two; Path=/private"],
    ["Set-Cookie", "dead=x; Max-Age=0"],
    ["Set-Cookie", "foreign=x; Domain=elsewhere.com"],
    ["Set-Cookie", "bad=x; SameSite=None"],
  ]);
  assert.equal(jar.header("https://api.example.com/"), "sid=one");
  assert.equal(jar.header("http://api.example.com/"), "");
  assert.equal(jar.header("https://elsewhere.com/"), "");
  assert.equal(jar.header("https://api.example.com/", "none"), "");
  assert.ok(
    jar.header("https://api.example.com/private/child").includes("scoped=two"),
  );
  assert.equal(jar.list().find((c) => c.name === "sid")?.httpOnly, true);
});
test("cookies can be edited, disabled, replaced by server and deleted", async () => {
  const jar = new SessionCookieJar();
  jar.receive("https://example.com", [["Set-Cookie", "sid=one; Path=/"]]);
  const cookie = jar.list()[0];
  jar.toggle(cookie.id);
  assert.equal(jar.header("https://example.com"), "");
  jar.receive("https://example.com", [["Set-Cookie", "sid=two; Path=/"]]);
  assert.equal(jar.header("https://example.com"), "");
  await jar.save({ ...cookie, value: "edited", enabled: true }, cookie.id);
  assert.equal(jar.header("https://example.com"), "sid=edited");
  await jar.remove(cookie.id);
  assert.equal(jar.list().length, 0);
});
test("redirects capture Set-Cookie and strip credentials on origin changes", async () => {
  const jar = new SessionCookieJar();
  const seen: WireRequest[] = [];
  await executeHttp(
    {
      ...request("https://example.com/login"),
      headers: [
        ["Authorization", "Bearer secret"],
        ["X-API-Key", "key"],
      ],
    },
    {
      jar,
      sensitiveHeaders: ["X-API-Key"],
      transport: async (req) => {
        seen.push(req);
        if (seen.length === 1)
          return response({}, 302, [
            ["Location", "/home"],
            ["Set-Cookie", "sid=one; Path=/"],
          ]);
        if (seen.length === 2)
          return response({}, 302, [
            ["Location", "https://other.example.org/"],
          ]);
        return response({ ok: true });
      },
    },
  );
  assert.ok(
    seen[1].headers.some(
      ([name, value]) => name === "Cookie" && value === "sid=one",
    ),
  );
  assert.deepEqual(seen[2].headers, []);
});
test("manual cookies override jar duplicates; HTTPS downgrade redirects are blocked", async () => {
  const jar = new SessionCookieJar();
  jar.receive("https://example.com", [["Set-Cookie", "sid=jar; Path=/"]]);
  await executeHttp(
    { ...request("https://example.com"), headers: [["Cookie", "sid=manual"]] },
    {
      jar,
      transport: async (req) => {
        assert.equal(
          req.headers.find(([name]) => name === "Cookie")?.[1],
          "sid=manual",
        );
        return response({});
      },
    },
  );
  await assert.rejects(
    executeHttp(request("https://example.com"), {
      transport: async () =>
        response({}, 302, [["Location", "http://example.com/"]]),
    }),
    /HTTPS to HTTP/,
  );
});
