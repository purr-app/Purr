import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRows, semanticSections, semanticValue } from "../src/features/git/semantic-diff";
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
