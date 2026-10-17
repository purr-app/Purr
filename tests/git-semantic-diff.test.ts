import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRows, semanticRowFields, semanticSections, semanticValue } from "../src/features/git/semantic-diff";
import { serializeResource } from "../src/storage/yaml";
import { requestDefinitionSchema } from "../src/domain/project";
const request = () => requestDefinitionSchema.parse({ id: "get-user", kind: "http", name: "Get user", method: "GET", url: "https://example.test/users" });

test("semantic requests show URL, duplicate headers, enabled state and body content separately", () => {
  const before = request(); before.headers = [{ id: "one", name: "Accept", enabled: true, sensitive: false, value: { kind: "plain", value: "application/json" } }, { id: "two", name: "Accept", enabled: false, sensitive: false, value: { kind: "plain", value: "text/plain" } }];
  const after = structuredClone(before); after.url += "/123"; after.headers[1].enabled = true; after.headers.reverse(); after.body = { type: "json", data: '{\n  "active": true\n}' };
  const sections = semanticSections(serializeResource(before), serializeResource(after))!;
  assert.ok(sections.find((section) => section.key === "url")?.changed);
  const headers = sections.find((section) => section.key === "headers")!; assert.equal(headers.rows.length, 2); assert.ok(headers.rows.every((row) => row.moved)); assert.ok(headers.rows.every((row) => row.label === "Accept"));
  assert.equal(sections.find((section) => section.key === "body")?.rows.find((row) => row.key === "data")?.after, '{\n  "active": true\n}');
});
test("duplicate query pairs remain separate and insertions do not mark all rows reordered", () => {
  const rows = diffRows([{ name: "tag", value: "a", enabled: true }, { name: "tag", value: "b", enabled: false }], [{ name: "new", value: "n" }, { name: "tag", value: "a", enabled: true }, { name: "tag", value: "b", enabled: false }]);
  assert.equal(rows.length, 3); assert.equal(rows.filter((row) => row.label === "tag").length, 2); assert.equal(rows.filter((row) => row.moved).length, 0);
});
test("formatting and omitted defaults do not create semantic changes", () => {
  const source = "purr: 2\nid: get-user\nkind: http\nname: Get user\nmethod: GET\nurl: https://example.test/users\n";
  const sections = semanticSections(source, serializeResource(request()))!; assert.ok(sections.length); assert.ok(sections.every((section) => !section.changed));
  assert.equal(semanticValue("unrelated: yaml"), null); assert.equal(semanticValue("purr: 2\na: &x [*x]"), null);
});
test("credential references and opaque extension values are preserved without hydration", () => {
  const before = request(); before.auth = { type: "bearer", prefix: "Bearer", token: { kind: "secret", ref: "purr/workspace/credentials/old" } };
  const after = structuredClone(before); if (after.auth.type === "bearer") after.auth.token = { kind: "secret", ref: "purr/workspace/credentials/new" };
  assert.ok(semanticSections(serializeResource(before), serializeResource(after))?.find((section) => section.key === "auth")?.changed);
  const extension = "purr: 2\nkind: extension\nid: custom\nname: Custom\nextensionType: fixture.custom\nconfigVersion: 1\nconfig:\n  enabled: false\n  values: []\n";
  assert.deepEqual(semanticValue(extension)?.config, { enabled: false, values: [] });
});

test("method and URL share one semantic section", () => {
  const before = request(); const after = { ...before, method: "POST", url: before.url + "/42" };
  const sections = semanticSections(serializeResource(before), serializeResource(after))!;
  assert.equal(sections.some((section) => section.key === "method"), false);
  const url = sections.find((section) => section.key === "url")!;
  assert.deepEqual(url.rows[0].before, { method: "GET", url: before.url });
  assert.deepEqual(url.rows[0].after, { method: "POST", url: after.url });
});

test("variables compare values under explicit names and expose extraction settings as fields", () => {
  const before = { id: "var", name: "response_id", kind: "dynamic-request", documentId: "request", expression: "$.id", language: "jsonpath", refresh: "cache", cacheTtlSeconds: 60, environment: { type: "current" }, enabled: false, sensitive: false };
  const after = { ...before, expression: "$.user.id" };
  const row = { key: "var", label: before.name, before, after, changed: true, moved: false };
  const fields = semanticRowFields(row, "variables");
  assert.equal(fields.find((field) => field.key === "expression")?.after, "$.user.id");
  assert.equal(fields.find((field) => field.key === "documentId")?.label, "Source request");
  assert.equal(fields.find((field) => field.key === "language")?.after, "JSONPath");
  assert.equal(fields.find((field) => field.key === "cacheTtlSeconds")?.after, 60);
  assert.equal(fields.find((field) => field.key === "environment")?.after, "Current environment");
  const variable = { id: "base", name: "BASE", kind: "static", value: "https://before.test", enabled: true, sensitive: false };
  const values = semanticRowFields({ ...row, before: variable, after: { ...variable, value: "https://after.test" } }, "variables");
  assert.equal(values.find((field) => field.key === "value")?.before, "https://before.test");
  assert.equal(values.some((field) => field.key === "id"), false);
});
