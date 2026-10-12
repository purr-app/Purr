import assert from "node:assert/strict";
import test from "node:test";
import { stringify } from "yaml";
import { deserializeManifestFile, deserializeResourceFile, serializeManifest, serializeResource, pinnedSchemaPath } from "../src/storage/yaml";

const request = (extra: Record<string, unknown> = {}, purr = 1) => stringify({ purr, kind: "http", id: "request-one", name: "Request", method: "GET", url: "https://example.test", ...extra });
const manifest = (defaults: Record<string, unknown> = {}, purr = 1) => stringify({ purr, workspace: { id: "workspace-one", name: "Workspace" }, defaults });

test("v1 decode normalizes without replacing legacy literals or creating refs", () => {
  const source = request({ auth: { type: "bearer", token: { kind: "plain", value: "literal-{{token}}" } } });
  const decoded = deserializeResourceFile(source);
  assert.equal(decoded.sourceVersion, 1);
  assert.equal(decoded.migrationRequired, true);
  assert.deepEqual(decoded.legacySource, { version: 1 });
  assert.equal(decoded.developmentRewrite, false);
  assert.ok(decoded.value.kind === "http" && decoded.value.auth.type === "bearer");
  assert.deepEqual(decoded.value.auth.token, { kind: "plain", value: "literal-{{token}}" });
  assert.throws(() => serializeResource(decoded.value), /protected credential/);
  assert.equal(deserializeResourceFile(serializeResource(decoded.value, undefined, 1)).sourceVersion, 1);
  assert.equal(source.includes("literal-{{token}}"), true);
});

test("v1 credential pure references retain full expression while ordinary headers remain public", () => {
  const expression = " \n{{ token }}\t ";
  const decoded = deserializeResourceFile(request({ auth: { type: "bearer", token: { kind: "plain", value: expression } },
    headers: [{ name: "X-Ordinary", value: expression }, { name: "X-Protected", value: expression, secret: true }] }));
  assert.ok(decoded.value.kind === "http" && decoded.value.auth.type === "bearer");
  assert.deepEqual(decoded.value.auth.token, { kind: "template", value: expression });
  assert.deepEqual(decoded.value.headers.map((header) => [header.sensitive, header.value]), [
    [false, { kind: "plain", value: expression }], [true, { kind: "template", value: expression }],
  ]);
  const upgraded = deserializeResourceFile(serializeResource(decoded.value));
  assert.equal(upgraded.sourceVersion, 2); assert.equal(upgraded.migrationRequired, false);
  assert.equal(upgraded.legacySource, undefined);
  assert.deepEqual(upgraded.value, decoded.value);
});

test("legacy row identity retains explicit IDs, duplicates, ordering and disabled rows without value hashes", () => {
  const rows = [{ name: "X-Repeat", value: "one", enabled: false }, { name: "X-Repeat", value: "two" }, { id: "provided", name: "X-Repeat", value: "three" }];
  const first = deserializeResourceFile(request({ headers: rows })).value;
  const second = deserializeResourceFile(request({ headers: rows.map((row) => ({ ...row, value: "different" })) })).value;
  assert.ok(first.kind === "http" && second.kind === "http");
  assert.deepEqual(first.headers.map((row) => row.id), ["legacy-header-0", "legacy-header-1", "provided"]);
  assert.deepEqual(second.headers.map((row) => row.id), first.headers.map((row) => row.id));
  first.headers.reverse();
  const reopened = deserializeResourceFile(serializeResource(first)).value;
  assert.ok(reopened.kind === "http");
  assert.deepEqual(reopened.headers, first.headers);
  assert.equal(reopened.headers[2].enabled, false);
});

test("v2 reader rejects plaintext protected auth and sensitive headers, including disabled rows", () => {
  assert.throws(() => deserializeResourceFile(request({ auth: { type: "basic", username: "public", password: { kind: "plain", value: "protected" } } }, 2)), /Invalid Purr resource/);
  assert.throws(() => deserializeResourceFile(request({ headers: [{ id: "header", name: "X", sensitive: true, enabled: false, value: { kind: "plain", value: "protected" } }] }, 2)), /Invalid Purr resource/);
  assert.throws(() => deserializeResourceFile(request({ headers: [{ id: "header", name: "X", value: { kind: "secret", ref: "purr/workspace-one/request/header" } }] }, 2)), /Invalid Purr resource/);
});

test("v2 rejects missing header IDs, duplicate IDs, malformed templates and future versions", () => {
  assert.throws(() => deserializeResourceFile(request({ headers: [{ name: "X", value: "legacy" }] }, 2)), /Invalid/);
  const header = { id: "duplicate", name: "X", value: { kind: "plain", value: "public" } };
  assert.throws(() => deserializeResourceFile(request({ headers: [header, header] }, 2)), /Invalid/);
  assert.throws(() => deserializeResourceFile(request({ auth: { type: "bearer", token: { kind: "template", value: "prefix{{token}}" } } }, 2)), /Invalid/);
  assert.throws(() => deserializeResourceFile(request({}, 3)), /unsupported/);
  assert.throws(() => deserializeManifestFile(manifest({}, 3)), /unsupported/);
});

test("workspace header IDs/scopes and auth pure references migrate coherently", () => {
  const decoded = deserializeManifestFile(manifest({ headers: [{ id: "workspace-header", scope: "all", name: "X", value: "public" }],
    auth: [{ id: "auth", name: "Auth", scope: "http", config: { type: "api-key", name: "key", placement: "query", value: { kind: "plain", value: "{{key}}" } } }] }));
  assert.equal(decoded.value.headers[0].id, "workspace-header");
  assert.equal(decoded.value.headers[0].scope, "all");
  assert.deepEqual(deserializeManifestFile(serializeManifest(decoded.value)).value, decoded.value);
  assert.equal(deserializeManifestFile(serializeManifest(decoded.value, 1)).sourceVersion, 1);
});

test("v1 known secret schema headers retain classification and sidecar paths while ordinary names do not infer protection", () => {
  const source = stringify({ purr: 1, kind: "schema", id: "schema", name: "Schema", source: { type: "introspection" }, pinned: "schemas/schema.graphql",
    introspectionHeaders: [{ id: "known", name: "Custom", value: { kind: "secret", ref: "purr/workspace-one/schemas/schema/known" } },
      { id: "ordinary", name: "Authorization", value: { kind: "plain", value: "user-public" } }] });
  const decoded = deserializeResourceFile(source, () => "type Query { public: String }");
  assert.ok(decoded.value.kind === "schema");
  assert.equal(decoded.value.introspectionHeaders[0].sensitive, true);
  assert.equal(decoded.value.introspectionHeaders[1].sensitive, false);
  const upgraded = serializeResource(decoded.value, "schemas/schema.graphql");
  assert.equal(pinnedSchemaPath(upgraded), "schemas/schema.graphql");
  assert.deepEqual(deserializeResourceFile(upgraded, () => decoded.value.kind === "schema" ? decoded.value.pinnedSdl! : "").value, decoded.value);
});

test("provider-owned config is not traversed by credential normalization or v2 protection validation", () => {
  const config = { nested: { kind: "plain", value: "vendor-data", enabled: true, empty: [], secret: false }, credentials: { password: "opaque" } };
  for (const extra of [{ kind: "integration", provider: "private.provider", credentials: { apiKey: { kind: "plain", value: "{{apiKey}}" } } },
    { kind: "extension", extensionType: "private.document" }]) {
    const source = stringify({ purr: 1, id: "private", name: "Private", configVersion: 1, config, ...extra });
    const decoded = deserializeResourceFile(source);
    assert.ok(decoded.value.kind === "integration" || decoded.value.kind === "extension");
    assert.deepEqual(decoded.value.config, config);
    const reopened = deserializeResourceFile(serializeResource(decoded.value));
    assert.deepEqual(reopened.value, decoded.value);
  }
});

test("legacy development conversion retains source version and migration metadata", () => {
  const source = stringify({ purr: 1, kind: "environment", id: "environment", name: "Env", variables: [{ id: "variable", name: "name", source: { type: "value", value: "public" } }] });
  const decoded = deserializeResourceFile(source);
  assert.equal(decoded.developmentRewrite, true);
  assert.equal(decoded.migrationRequired, true);
  assert.equal(decoded.sourceVersion, 1);
  assert.equal(deserializeResourceFile(serializeResource(decoded.value)).developmentRewrite, false);
});

test("v1 compatibility serializer cannot silently downgrade v2 protected request headers", () => {
  const decoded = deserializeResourceFile(request({ headers: [{ id: "header", name: "X", sensitive: true, value: { kind: "secret", ref: "purr/workspace-one/request/header" } }] }, 2));
  assert.throws(() => serializeResource(decoded.value, undefined, 1), /legacy format/);
});

test("Cookie protocol roles require protection without guessing other header names", () => {
  const decoded = deserializeResourceFile(request({ headers: [
    { name: "Cookie", value: "session=synthetic", sensitive: false },
    { name: "set-cookie", value: "{{cookie}}" },
    { name: "Authorization", value: "user-public" },
  ] })).value;
  assert.ok(decoded.kind === "http");
  assert.deepEqual(decoded.headers.map((row) => row.sensitive), [true, true, false]);
  assert.equal(decoded.headers[1].value.kind, "template");
  assert.throws(() => deserializeResourceFile(request({ headers: [{ id: "cookie", name: "Cookie", value: { kind: "plain", value: "session=synthetic" } }] }, 2)), /Invalid/);
});

test("a v2 marker cannot authorize legacy development shapes", () => {
  const source = stringify({ purr: 2, kind: "environment", id: "environment", name: "Env", variables: [{ id: "variable", name: "name", source: { type: "value", value: "public" } }] });
  assert.throws(() => deserializeResourceFile(source), /Invalid/);
});
