import { test } from "node:test";
import assert from "node:assert/strict";
import { changedTextRanges, alignedTextLines, syntaxRanges } from "../src/features/git/diff-text";
import { equalGraphql, equalJson, formattedJson, schemaSections } from "../src/features/git/graphql-diff";
import { semanticSections } from "../src/features/git/semantic-diff";
import { requestDefinitionSchema } from "../src/domain/project";
import { serializeResource } from "../src/storage/yaml";
const slices = (source: string, ranges: { from: number; to: number }[]) => ranges.map(({ from, to }) => source.slice(from, to));

test("GraphQL field edit highlights the field, preserving the operation and sibling selections", () => {
  const before = "query Customer { customer { id name } }", after = "query Customer { customer { id email } }";
  const ranges = changedTextRanges(before, after, "graphql");
  assert.deepEqual(slices(before, ranges.before), ["name"]); assert.deepEqual(slices(after, ranges.after), ["email"]);
});
test("GraphQL additions and removals do not repaint common fields", () => {
  const before = "{ customer { id } }", after = "{ customer { id name } }";
  assert.deepEqual(changedTextRanges(before, after, "graphql").before, []);
  assert.deepEqual(slices(after, changedTextRanges(before, after, "graphql").after), ["name"]);
  assert.deepEqual(slices(after, changedTextRanges(after, before, "graphql").before), ["name"]);
});
test("GraphQL semantic formatting ignores whitespace, comments, and insignificant commas", () => {
  const before = "query Customer($id:ID!){customer(id:$id){id,name}}";
  const after = "# Explain the request\nquery Customer($id: ID!) {\n  customer(id: $id) {\n    id\n    name\n  }\n}";
  assert.ok(equalGraphql(before, after)); assert.deepEqual(changedTextRanges(before, after, "graphql"), { before: [], after: [] });
  assert.equal(equalGraphql("{ customer { id name } }", "{ customer { name id } }"), false);
});
test("GraphQL compares aliases, arguments, variables, operations, fragments and directives", () => {
  const cases = [
    ["query A { user { id } }", "query B { user { id } }", "B"],
    ["{ first:user { id } }", "{ second:user { id } }", "second"],
    ["{ user(id:1) { id } }", "{ user(id:2) { id } }", "2"],
    ["query A($id:ID) { user(id:$id) { id } }", "query A($id:ID!) { user(id:$id) { id } }", "!"],
    ["{ user { ...A } } fragment A on User { id }", "{ user { ...A } } fragment A on User { id name }", "name"],
    ["{ user @skip(if:true) { id } }", "{ user @include(if:true) { id } }", "include"],
  ];
  for (const [before, after, added] of cases) {
    assert.equal(equalGraphql(before, after), false);
    assert.ok(slices(after, changedTextRanges(before, after, "graphql").after).includes(added));
  }
});
test("invalid and incomplete GraphQL keep a bounded text fallback", () => {
  assert.equal(equalGraphql("query {", "query { user("), false);
  const changes = changedTextRanges('query { user(name: "', 'query { user(name: "new', "graphql");
  assert.equal(slices('query { user(name: "new', changes.after).join(""), "new");
  assert.equal(schemaSections("type User { id: ID }", "type User {"), null);
});
test("GraphQL variables JSON highlights only changed values, with neutral siblings", () => {
  const before = formattedJson('{"filter":{"name":"Nora","limit":10},"enabled":true}');
  const after = formattedJson('{"filter":{"name":"Nora","limit":20},"enabled":true}');
  const changes = changedTextRanges(before, after, "json");
  assert.equal(slices(before, changes.before).join(""), "10"); assert.equal(slices(after, changes.after).join(""), "20");
  assert.ok(equalJson('{"a":1,"b":2}', '{ "b": 2, "a": 1 }'));
  assert.equal(formattedJson('{"invalid"'), '{"invalid"');
});
test("canonical GraphQL requests ignore query and JSON formatting but detect values", () => {
  const resource = requestDefinitionSchema.parse({ id: "gql", name: "GraphQL", kind: "graphql", method: "POST", url: "https://api.test/graphql", graphql: { query: "{ user { id } }", variables: '{"id":1}' } });
  const next = { ...resource, graphql: { ...resource.graphql, query: "{\n user {\n id\n }\n}", variables: '{ "id": 1 }' } };
  assert.equal(semanticSections(serializeResource(resource), serializeResource(next))!.some((section) => section.changed), false);
  next.graphql.variables = '{"id":2}';
  const section = semanticSections(serializeResource(resource), serializeResource(next))!.find((section) => section.key === "graphql")!;
  assert.deepEqual(section.rows.filter((row) => row.changed).map((row) => row.key), ["variables"]);
});
test("schema matches fields by identity; only affected members and types change", () => {
  const before = "type Character { id: ID! name: String status: String } type Query { character: Character }";
  const after = "type Character { id: ID! name: String! created: DateTime } type Query { character: Character } scalar DateTime";
  const sections = schemaSections(before, after)!;
  assert.deepEqual(sections.filter((section) => section.changed).map((section) => section.label), ["Type: Character", "Scalar: DateTime"]);
  const rows = sections.find((section) => section.label === "Type: Character")!.rows;
  assert.deepEqual(rows.filter((row) => row.changed).map((row) => row.key), ["field:name", "field:created", "field:status"]);
  assert.equal(rows.find((row) => row.key === "field:created")!.before, undefined);
  assert.equal(rows.find((row) => row.key === "field:status")!.after, undefined);
});
test("SDL supports nested arguments, lists, descriptions, deprecations and directives", () => {
  const before = '"A character" type Character @cache(ttl:1) { "Old name" name(locale:String="en"):String @deprecated(reason:"Old") friends(filter:Filter):[Character] } input Filter { name: String } directive @cache(ttl:Int=1) on OBJECT';
  const after = '"A hero" type Character @cache(ttl:2) { "Display name" name(locale:String!="fr"):String! @deprecated(reason:"Renamed") friends(filter:Filter,limit:Int=10):[Character!]! } input Filter { name: String! } directive @cache(ttl:Int=2) repeatable on OBJECT | FIELD';
  const sections = schemaSections(before, after)!; assert.equal(sections.length, 3); assert.ok(sections.every((section) => section.changed));
  const character = sections.find((section) => section.label === "Type: Character")!;
  assert.deepEqual(character.rows.filter((row) => row.changed).map((row) => row.key), ["declaration", "description", "field:name", "field:friends"]);
  assert.ok(String(character.rows.find((row) => row.key === "field:friends")!.after).includes("[Character!]!"));
  const directive = sections.find((section) => section.label === "Directive: cache")!;
  assert.deepEqual(directive.rows.filter((row) => row.changed).map((row) => row.key), ["declaration", "argument:ttl"]);
});
test("SDL supports added/deleted interfaces, enums, unions, scalars, schema directives and extensions", () => {
  const sdl = 'schema { query: Query } interface Node { id: ID! } type Query { node: Node } extend type Query { search: Search } enum State { ACTIVE OLD @deprecated } union Search = Query | Character scalar DateTime';
  const added = schemaSections("", sdl)!; const removed = schemaSections(sdl, "")!;
  assert.equal(added.length, 6); assert.equal(removed.length, 6);
  assert.ok(added.every((section) => section.rows.every((row) => row.before === undefined && row.after !== undefined)));
  assert.ok(removed.every((section) => section.rows.every((row) => row.after === undefined && row.before !== undefined)));
  const delta = schemaSections("enum State { ACTIVE OLD } union Search = Query | Character", "enum State { ACTIVE NEW } union Search = Query | User")!;
  assert.deepEqual(delta[0].rows.filter((row) => row.changed).map((row) => row.key), ["value:NEW", "value:OLD"]);
  assert.deepEqual(delta[1].rows.filter((row) => row.changed).map((row) => row.key), ["member:User", "member:Character"]);
  assert.equal(schemaSections("{ user { id } }", ""), null);
});
test("schema formatting does not mark members changed", () => {
  assert.ok(schemaSections("type User { id:ID! name:String }", "# Comment\ntype User {\n id: ID!\n name: String\n}")!.every((section) => !section.changed));
});
test("read-only GraphQL and JSON use the editor syntax palette, including invalid content", () => {
  const source = '# Comment\nquery User($id: ID!, $limit:Int=10) { user(id:$id) @include(if:true) { alias:name text(value:"a") } }';
  const classes = new Set(syntaxRanges(source, "graphql").map((token) => token.className));
  for (const name of ["text-content-tertiary", "text-syntax-boolean", "text-syntax-property", "text-syntax-attribute", "text-syntax-number", "text-syntax-string"]) assert.ok(classes.has(name), name);
  assert.ok(syntaxRanges('type User { name: String @deprecated(reason:"old") }', "graphql").length);
  assert.ok(syntaxRanges('query { user(', "graphql").length);
});
test("line pairing aligns inserted, removed and wrapped multiline chunks without repeating trailing lines", () => {
  const rows = alignedTextLines("a\nc", "a\nb\nc");
  assert.deepEqual(rows.map((row) => [row.before?.text, row.after?.text]), [["a", "a"], [undefined, "b"], ["c", "c"]]);
  assert.deepEqual(alignedTextLines("a", "").flatMap((row) => row.before ? [row.before.text] : []), ["a"]);
  assert.deepEqual(alignedTextLines("a\n", "a\n").map((row) => row.before?.text), ["a", ""]);
});

test("SDL field arguments match by name across ordering changes", () => {
  const before = 'type Query { user(id: ID!, locale: String = "en"): User @cache(ttl: 1, shared: true) }';
  const reordered = 'type Query { user(locale: String = "en", id: ID!): User @cache(shared: true, ttl: 1) }';
  assert.ok(schemaSections(before, reordered)!.every((section) => !section.changed));
  const changed = schemaSections(before, reordered.replace('locale: String = "en"', 'locale: String! = "fr"'))![0];
  assert.deepEqual(changed.rows.filter((row) => row.changed).map((row) => row.key), ["field:user"]);
  assert.ok(String(changed.rows.find((row) => row.key === "field:user")!.after).includes('locale: String! = "fr"'));
});

test("scalar comparison keeps tiny edits precise and leaves matched punctuation alone", () => {
  const changes = changedTextRanges("pam", "pa");
  assert.deepEqual(slices("pam", changes.before), ["m"]); assert.deepEqual(changes.after, []);
  assert.ok(syntaxRanges('<user id="1"><name>Nora</name></user>', "xml").some((range) => range.className === "text-syntax-tag"));
});
test("GraphQL line matching respects nested field identity through reorders and argument edits", () => {
  const before = 'query Q {\n  user {\n    id\n    name\n    friends(limit: 10) {\n      id\n      name\n    }\n    legacy\n  }\n}';
  const after = 'query Q {\n  user {\n    name\n    id\n    friends(limit: 20) {\n      name\n      id\n      email\n    }\n    created\n  }\n}';
  const rows = alignedTextLines(before, after, "graphql");
  assert.equal(rows.filter((row) => row.before).map((row) => row.before!.text).join("\n"), before);
  assert.equal(rows.filter((row) => row.after).map((row) => row.after!.text).join("\n"), after);
  const friends = rows.find((row) => row.before?.text.includes("friends(limit:"))!;
  assert.ok(friends.matched); assert.ok(friends.after?.text.includes("friends(limit: 20)"));
  assert.equal(rows.find((row) => row.after?.text.trim() === "email")!.matched, false);
  assert.equal(rows.find((row) => row.before?.text.trim() === "legacy")!.matched, false);
  for (const row of rows.filter((row) => row.matched && row.before && row.after)) {
    const a = row.before!.text.trim(), b = row.after!.text.trim();
    if (["id", "name"].includes(a)) assert.equal(b, a);
  }
});
test("JSON and XML lines match by property or element rather than unrelated row position", () => {
  const json = alignedTextLines('{\n "old": 1,\n "count": 10\n}', '{\n "new": 2,\n "count": 20\n}', "json");
  assert.equal(json.find((row) => row.before?.text.includes('"old"'))!.matched, false);
  assert.ok(json.find((row) => row.before?.text.includes('"count"'))!.matched);
  const xml = alignedTextLines('<root>\n <old>1</old>\n <count>10</count>\n</root>', '<root>\n <new>2</new>\n <count>20</count>\n</root>', "xml");
  assert.equal(xml.find((row) => row.before?.text.includes('<old>'))!.matched, false);
  assert.ok(xml.find((row) => row.before?.text.includes('<count>'))!.matched);
});

test("changed string content excludes quotes while meaningful SDL list and nullability changes remain visible", () => {
  const queryA = '{ user(name: "Nora") { id } }', queryB = '{ user(name: "Mira") { id } }';
  const queryChanges = changedTextRanges(queryA, queryB, "graphql");
  assert.deepEqual(slices(queryA, queryChanges.before), ["Nora"]); assert.deepEqual(slices(queryB, queryChanges.after), ["Mira"]);
  const jsonA = '{"name":"Nora"}', jsonB = '{"name":"Mira"}';
  const jsonChanges = changedTextRanges(jsonA, jsonB, "json");
  assert.deepEqual(slices(jsonA, jsonChanges.before), ["Nora"]); assert.deepEqual(slices(jsonB, jsonChanges.after), ["Mira"]);
  const sdlA = 'name: String', sdlB = 'name: [String!]!';
  const sdlChanges = changedTextRanges(sdlA, sdlB, "graphql");
  assert.equal(slices(sdlB, sdlChanges.after).join(""), '[!]!');
});
