import assert from "node:assert/strict";
import { test } from "node:test";
import { SecretUnavailableError, type SecretResolution, type SecureStore } from "../src/application/ports/credentials";
import { resolveSecretField } from "../src/application/resolve-request-secrets";
import { createHttpDocument, type Variable } from "../src/features/workspaces/model/workspace";
import { executeRequest, prepareWireRequest } from "../src/features/request-workbench/services/execute-request";
import type { AuthRuntime } from "../src/features/request-workbench/hooks/use-auth-runtime";
import type { RequestDraft } from "../src/features/request-workbench/model/request";
import { SessionCookieJar } from "../src/features/request-workbench/model/cookie-jar";
import { resolveOAuthOperation } from "../src/features/request-workbench/services/oauth-client";
import { resolveDynamicVariables } from "../src/features/workspaces/services/dynamic-variable-resolver";
import { resolveEnvironmentValue } from "../src/shared/lib/resolve-variables";

function store(results: Record<string, SecretResolution>) {
  const reads: string[] = [];
  const secure = { resolve: async (ref: string) => { reads.push(ref); return results[ref] ?? { status: "missing", revision: 0 }; } } as SecureStore;
  return { secure, reads };
}
function request() { const draft = createHttpDocument().request; draft.url = "https://example.test/resource"; draft.auth.type = "none"; return draft; }
const unknown = (ref: string) => ({ ref, status: "unresolved" as const, edit: { kind: "keep" as const } });

test("Send blocks a missing Basic password before producing Basic username-colon", async () => {
  const draft = request(); draft.auth.type = "basic"; draft.auth.basic.username = "alice";
  draft.auth.credentialStates = { password: unknown("password") };
  const { secure, reads } = store({});
  await assert.rejects(prepareWireRequest(draft, { secretStore: secure }), (error) => error instanceof SecretUnavailableError && error.status === "missing");
  assert.deepEqual(reads, ["password"]);
  const available = store({ password: { status: "available", value: "", revision: 1 } });
  const result = await prepareWireRequest(draft, { secretStore: available.secure });
  assert.ok(result.request.headers.some(([name, value]) => name === "Authorization" && value === `Basic ${btoa("alice:")}`));
});

test("redacted code uses unavailable auth/header placeholders without reading the vault", async () => {
  const draft = request(); draft.auth.type = "bearer"; draft.auth.credentialStates = { bearer: unknown("bearer") };
  draft.headers = [{ id: "custom", name: "X-Custom", value: "", enabled: true, secret: true, secretState: unknown("header") }];
  const { secure, reads } = store({});
  const redacted = await prepareWireRequest(draft, { secretStore: secure }, { purpose: "redacted-code" });
  assert.deepEqual(reads, []);
  assert.ok(redacted.request.headers.some(([name, value]) => name === "X-Custom" && value === "********"));
  await assert.rejects(prepareWireRequest(draft, { secretStore: secure }, { purpose: "resolved-code" }), SecretUnavailableError);
});

test("unreferenced variables, disabled headers and inactive authentication are not resolved", async () => {
  const draft = request(); draft.auth.credentialStates = { password: unknown("inactive") };
  draft.headers = [{ id: "off", name: "X-Off", value: "{{unknown}}", secret: true, secretState: unknown("disabled"), enabled: false }];
  const { secure, reads } = store({});
  await prepareWireRequest(draft, { secretStore: secure, variables: { unrelated: "" }, variableStates: { unrelated: unknown("unrelated") } });
  assert.deepEqual(reads, []);
});

test("a transitive sensitive variable marks body and header provenance without classifying ordinary names", async () => {
  const draft = request(); draft.method = "POST"; draft.body.type = "json"; draft.body.json = '{"value":"{{alias}}"}';
  draft.headers = [{ id: "public-name", name: "X-API-Key", value: "public literal", enabled: true }, { id: "dependent", name: "X-User-Value", value: "{{alias}}", enabled: true }];
  const { secure, reads } = store({ secret: { status: "available", value: "actual-secret", revision: 2 } });
  const result = await prepareWireRequest(draft, { requestDocumentId: "doc", secretStore: secure, variables: { alias: "prefix-{{ credential }}", credential: "" }, variableStates: { credential: unknown("secret") } });
  assert.deepEqual(reads, ["secret"]);
  assert.equal(result.sensitiveBody, true);
  assert.deepEqual(result.sensitiveHeaders, ["X-User-Value"]);
  assert.ok(result.provenance.some((usage) => usage.ownerId === "doc" && usage.field === "body" && usage.secretRefs.includes("secret") && usage.variableNames.includes("credential")));
  assert.ok(!JSON.stringify(result.displayRequest).includes("actual-secret"));
});

test("valid OAuth access token does not require unrelated missing client secret or config variables", async () => {
  const draft = request(); draft.auth.type = "oauth2";
  draft.auth.oauth2.token = { accessToken: "", tokenType: "Bearer", obtainedAt: 0, expiresAt: Date.now() + 60_000 };
  draft.auth.oauth2.tokenUrl = "{{missing_endpoint}}";
  draft.auth.credentialStates = { "oauth-access-token": unknown("access"), "client-secret": unknown("client") };
  const { secure, reads } = store({ access: { status: "available", value: "token", revision: 1 } });
  const result = await prepareWireRequest(draft, { secretStore: secure });
  assert.deepEqual(reads, ["access"]);
  assert.ok(result.request.headers.some(([, value]) => value === "Bearer token"));
});

test("OAuth refresh ignores authorization-only fields and blocks a missing refresh ref", async () => {
  const auth = request().auth; auth.type = "oauth2"; auth.oauth2.grantType = "authorization_code";
  auth.oauth2.token = { accessToken: "unused", tokenType: "Bearer", obtainedAt: 0, refreshToken: "" };
  auth.oauth2.clientId = "client"; auth.oauth2.tokenUrl = "https://example.test/token";
  auth.oauth2.authorizationUrl = "{{unrelated}}"; auth.oauth2.redirectUri = "{{also_unrelated}}"; auth.oauth2.scopes = "{{unrelated_scope}}";
  auth.credentialStates = { "oauth-refresh-token": unknown("refresh") };
  const missing = store({});
  await assert.rejects(resolveOAuthOperation(auth, { secretStore: missing.secure }, "refresh"), SecretUnavailableError);
  const available = store({ refresh: { status: "available", value: "refresh-value", revision: 1 } });
  const config = await resolveOAuthOperation(auth, { secretStore: available.secure }, "refresh");
  assert.equal(config.token?.refreshToken, "refresh-value");
  assert.deepEqual(available.reads, ["refresh"]);
});

test("keep, set empty and delete are distinct and unavailable status stays typed", async () => {
  const locked = store({ ref: { status: "locked", code: "locked-keychain", retryable: true } });
  await assert.rejects(resolveSecretField("", unknown("ref"), locked.secure), (error) => error instanceof SecretUnavailableError && error.status === "locked");
  assert.equal(await resolveSecretField("previous", { ...unknown("ref"), edit: { kind: "set", value: "" } }, locked.secure), "");
  await assert.rejects(resolveSecretField("previous", { ...unknown("ref"), edit: { kind: "delete" } }, locked.secure), (error) => error instanceof SecretUnavailableError && error.status === "missing");
  assert.deepEqual(locked.reads, ["ref"]);
});

test("cached dynamic secret resolves its cache ref without running unavailable source credentials", async () => {
  const root = { id: "root", name: "Root", kind: "http" as const, request: request() }; root.request.url += "?value={{cached}}";
  const source = { id: "source", name: "Source", kind: "http" as const, request: request() }; source.request.auth.type = "basic"; source.request.auth.credentialStates = { password: unknown("source-password") };
  const variable: Variable = { id: "cache-var", name: "cached", kind: "dynamic-request", enabled: true, sensitive: true, documentId: "source", expression: ".", language: "jq", refresh: "cache", environment: { type: "current" } };
  const { secure, reads } = store({ cached: { status: "available", value: "cached-value", revision: 1 } });
  let executions = 0;
  const result = await resolveDynamicVariables({ root, environmentId: null, documents: [root, source], variablesForEnvironment: async () => [variable], secretStore: secure,
    persistentCache: { "cache-var:none": { status: "success", value: "", secretState: unknown("cached"), resolvedAt: new Date().toISOString(), durationMs: 0, environmentId: null, fingerprint: JSON.stringify(variable) } }, sessionCache: new Map(), execute: async () => { executions++; throw new Error("source must not run"); } });
  assert.equal(result.values.cached, "cached-value"); assert.equal(executions, 0); assert.deepEqual(reads, ["cached"]);
});

test("resolver uses the shared parser's trimmed names and preserves surrounding text", () => {
  assert.equal(resolveEnvironmentValue(" x {{  name  }} y ", { name: "value" }), " x value y ");
  assert.throws(() => resolveEnvironmentValue("{{loop}}", { loop: "{{ loop }}" }), /circular/);
});

test("redacted raw JSON secret substitutions remain valid JSON without requiring their value", async () => {
  const draft = request(); draft.method = "POST"; draft.body.type = "json"; draft.body.json = '{"value":{{ secret }}}';
  const { secure, reads } = store({});
  const result = await prepareWireRequest(draft, { secretStore: secure, variables: { secret: "" }, variableStates: { secret: unknown("secret") } }, { purpose: "redacted-code" });
  assert.deepEqual(JSON.parse(atob(result.request.bodyBase64!)), { value: "********" });
  assert.deepEqual(reads, []);
});

test("GraphQL composition ignores inactive HTTP body dependencies", async () => {
  const draft = request(); draft.body.type = "json"; draft.body.json = '{{inactive_missing}}';
  draft.graphql = { query: "query { viewer { id } }", variables: "{}", operationName: "" };
  await prepareWireRequest(draft, {});
});

test("dispatch captures hydrated credential A independently of a concurrent vault change to B", async () => {
  const draft = request(); draft.auth.type = "basic"; draft.auth.basic.username = "alice";
  draft.auth.credentialStates = { password: unknown("password") };
  const results: Record<string, SecretResolution> = { password: { status: "available", value: "password-A", revision: 1 } };
  const { secure, reads } = store(results);
  let captured: RequestDraft | undefined;
  await executeRequest(draft, { secretStore: secure }, new SessionCookieJar(), {} as AuthRuntime, async (wire) => {
    assert.ok(wire.headers.some(([, value]) => value === `Basic ${btoa("alice:password-A")}`));
    results.password = { status: "available", value: "password-B", revision: 2 };
    return { status: 200, statusText: "OK", headers: [], durationMs: 1, bodyBase64: "" };
  }, undefined, { onPrepared: (editor) => { captured = editor; } });
  assert.equal(captured?.auth.basic.password, "password-A");
  assert.equal(captured?.auth.credentialStates?.password.status, "available");
  assert.equal(captured?.auth.credentialStates?.password.edit?.kind, "keep");
  assert.equal(draft.auth.basic.password, "");
  assert.deepEqual(reads, ["password"]);
});
