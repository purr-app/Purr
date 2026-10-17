import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRows, hasSemanticContent, semanticSections, semanticValue, variableRefresh } from "../src/features/git/semantic-diff";
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

test("identity is grouped into compact Info and empty defaults are omitted from new-file previews", () => {
  const sections = semanticSections("", serializeResource(request()))!;
  assert.equal(sections.some((section) => ["name", "kind", "description"].includes(section.key)), false);
  assert.deepEqual(new Set(sections.find((section) => section.key === "info")?.rows.map((row) => row.key)), new Set(["name", "kind"]));
  assert.equal(hasSemanticContent(sections.find((section) => section.key === "auth")!, "after"), false);
  assert.equal(hasSemanticContent(sections.find((section) => section.key === "body")!, "after"), false);
  assert.equal(hasSemanticContent(sections.find((section) => section.key === "url")!, "after"), true);
});

test("dynamic variables remain whole recipes with meaningful refresh summaries", () => {
  const variable = { id: "var", name: "response_id", kind: "dynamic-request", documentId: "request", expression: "$.id", language: "jsonpath", refresh: "cache", cacheTtlSeconds: 60, environment: { type: "current" }, enabled: false, sensitive: false };
  const rows = diffRows([variable], [{ ...variable, expression: "$.user.id" }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "response_id");
  assert.equal((rows[0].after as typeof variable).expression, "$.user.id");
  assert.equal(variableRefresh(variable), "Cache 60s");
  assert.equal(variableRefresh({ ...variable, refresh: "session" }), "Once per session");
});

test("mirrored query parameter changes appear once, while unmatched URL queries remain visible", () => {
  const before = requestDefinitionSchema.parse({ ...request(), url: "https://api.test/users?page=1#results", params: [{ name: "page", value: "1" }] });
  const after = { ...before, url: "https://api.test/users?page=2#results", params: [{ ...before.params[0], value: "2" }] };
  const sections = semanticSections(serializeResource(before), serializeResource(after))!;
  assert.equal(sections.find((section) => section.key === "url")?.changed, false);
  assert.deepEqual(sections.find((section) => section.key === "url")?.rows[0].after, { method: "GET", url: "https://api.test/users#results" });
  assert.ok(sections.find((section) => section.key === "params")?.changed);
  const unmatched = semanticSections(serializeResource(before), serializeResource({ ...after, params: [] }))!;
  assert.ok(unmatched.find((section) => section.key === "url")?.changed);
  assert.equal((semanticSections("", serializeResource(after))!.find((section) => section.key === "url")!.rows[0].after as { url: string }).url, after.url);
});

const header = (id: string, name: string, value: string) => ({ id, name, enabled: true, sensitive: false, value: { kind: "plain" as const, value } });
test("header identity preserves value edits, renames, and simultaneous name/value edits in one entity", () => {
  const before = header("header", "another", "another");
  for (const after of [{ ...before, value: { kind: "plain", value: "another-change" } }, { ...before, name: "anothe" }, { ...before, name: "anothe", value: { kind: "plain", value: "another-change" } }]) {
    const rows = diffRows([before], [after]);
    assert.equal(rows.length, 1); assert.equal(rows[0].before, before); assert.equal(rows[0].after, after); assert.ok(rows[0].changed); assert.equal(rows[0].moved, false);
  }
});
test("added and removed headers retain their sides and different IDs never invent a rename", () => {
  const before = header("removed", "X-API-Key", "old"), after = header("added", "newgate", "new");
  const rows = diffRows([before], [after]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [row.before, row.after]), [[undefined, after], [before, undefined]]);
  assert.equal(diffRows([before], [{ ...before, id: "new-identity" }]).length, 2);
});
test("multiple duplicate header names use stable IDs through renaming, value edits, and reordering", () => {
  const before = [header("one", "X-Repeat", "one"), header("two", "X-Repeat", "two"), header("three", "X-Other", "three")];
  const after = [{ ...before[1], name: "X-Renamed", value: { kind: "plain", value: "updated" } }, before[0], { ...before[2], value: { kind: "plain", value: "next" } }];
  const rows = diffRows(before, after);
  assert.equal(rows.length, 3); assert.equal(new Set(rows.map((row) => row.key)).size, 3);
  assert.deepEqual(rows.map((row) => (row.before as typeof before[0]).id), ["two", "one", "three"]);
  assert.ok(rows.every((row) => row.before !== undefined && row.after !== undefined));
  assert.ok(rows[0].moved); assert.ok(rows[1].moved); assert.equal(rows[2].moved, false);
});
test("reordering headers alone does not modify either value or secret reference", () => {
  const secret = { ...header("secret", "X-Key", ""), sensitive: true, value: { kind: "secret", ref: "purr/workspace/credentials/key" } };
  const before = [header("one", "X-Repeat", "one"), header("two", "X-Repeat", "two"), secret];
  const rows = diffRows(before, [secret, before[0], before[1]]);
  assert.equal(rows.length, 3); assert.ok(rows.every((row) => row.moved));
  for (const row of rows) assert.deepEqual(row.before, row.after);
});
test("header enabled state, sensitive metadata, and credential reference changes retain the same entity", () => {
  const before = { ...header("secret", "X-Key", ""), sensitive: true, value: { kind: "secret", ref: "purr/workspace/credentials/key" } };
  for (const after of [{ ...before, enabled: false }, { ...before, sensitive: false }, { ...before, value: { kind: "secret", ref: "purr/workspace/credentials/next" } }]) {
    const rows = diffRows([before], [after]);
    assert.equal(rows.length, 1); assert.equal(rows[0].before, before); assert.equal(rows[0].after, after); assert.ok(rows[0].changed);
  }
});
test("missing IDs match unique names and exact duplicate copies, but ambiguous edits remain add/remove", () => {
  const before = [{ name: "tag", value: "one", enabled: true }, { name: "tag", value: "two", enabled: false }];
  const reordered = diffRows(before, [...before].reverse());
  assert.equal(reordered.length, 2); assert.ok(reordered.every((row) => row.moved)); assert.ok(reordered.every((row) => row.before === row.after));
  const changed = diffRows(before, [before[0], { ...before[1], value: "unknown" }]);
  assert.equal(changed.length, 3); assert.equal(changed.filter((row) => row.before && row.after).length, 1);
  const renamed = diffRows([{ name: "old", value: "same" }], [{ name: "new", value: "same" }]);
  assert.equal(renamed.length, 2);
  const unique = diffRows([{ name: "mode", value: "one", enabled: true }], [{ name: "mode", value: "two", enabled: false }]);
  assert.equal(unique.length, 1); assert.ok(unique[0].changed);
});
test("an explicit ID is never confused with a different duplicate header or a positional legacy ID", () => {
  const before = [header("explicit", "Accept", "json"), header("other", "Accept", "xml")];
  const after = [header("fresh", "Accept", "json"), before[1]];
  const rows = diffRows(before, after);
  assert.equal(rows.length, 3); assert.equal(rows.filter((row) => row.before && row.after).length, 1);
  const source = (headers: string) => `purr: 1\nid: request\nkind: http\nname: Request\nmethod: GET\nurl: https://api.test\nheaders:\n${headers}`;
  const a = source("  - name: old\n    value: same\n"), b = source("  - name: renamed\n    value: same\n");
  const legacyRows = semanticSections(a, b)!.find((section) => section.key === "headers")!.rows;
  assert.equal(legacyRows.length, 2); assert.ok(legacyRows.every((row) => row.before === undefined || row.after === undefined));
  const explicitA = source("  - id: kept\n    name: old\n    value: same\n"), explicitB = source("  - id: kept\n    name: renamed\n    value: same\n");
  assert.equal(semanticSections(explicitA, explicitB)!.find((section) => section.key === "headers")!.rows.length, 1);
});
test("legacy synthetic header IDs do not turn reordering into changed values", () => {
  const source = (headers: string) => `purr: 1\nid: request\nkind: http\nname: Request\nmethod: GET\nurl: https://api.test\nheaders:\n${headers}`;
  const a = "  - name: X-Repeat\n    value: one\n  - name: X-Repeat\n    value: two\n";
  const b = "  - name: X-Repeat\n    value: two\n  - name: X-Repeat\n    value: one\n";
  const rows = semanticSections(source(a), source(b))!.find((section) => section.key === "headers")!.rows;
  assert.equal(rows.length, 2); assert.ok(rows.every((row) => row.moved)); assert.ok(rows.every((row) => JSON.stringify(row.before) === JSON.stringify(row.after)));
});
