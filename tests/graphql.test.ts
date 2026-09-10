import test from "node:test";
import assert from "node:assert/strict";
import { buildSchema, introspectionFromSchema } from "graphql";
import { normalizeSchema, parseGraphqlSchema, prepareGraphqlRequest } from "../src/features/graphql/model/graphql";
import { createGraphqlDocument, createSchemaDocument, createWorkspace, closeDocument, cloneRequestDraft, deleteDocument, isDocumentDirty, isMeaningfulDraft, openDocument, validateWorkspace } from "../src/features/workspaces/model/workspace";
import { resolveRequestEnvironment } from "../src/features/workspaces/model/environment";
import { getRequestHeaders } from "../src/features/request-workbench/model/request";

test("GraphQL builds a POST JSON envelope, resolves templates before encoding, and keeps editor drafts intact", () => {
  const document = createGraphqlDocument();
  document.request.url = "{{endpoint}}";
  document.request.graphql = { query: "mutation Update($name: String!, $limit: Int!) { update(name: $name, limit: $limit) { id } }", variables: '{"name":"{{name}}","limit":"{{limit}}"}', operationName: "Update" };
  const outgoing = prepareGraphqlRequest(resolveRequestEnvironment(document.request, { endpoint: "https://example.com/graphql", name: "Ігор", limit: "12" }));
  assert.equal(outgoing.method, "POST");
  assert.equal(outgoing.url, "https://example.com/graphql");
  assert.deepEqual(JSON.parse(outgoing.body.json), { query: document.request.graphql.query, variables: { name: "Ігор", limit: 12 }, operationName: "Update" });
  assert.equal(document.request.graphql.variables, '{"name":"{{name}}","limit":"{{limit}}"}');
  assert.equal(document.request.body.type, "none");
  assert.equal(getRequestHeaders(document.request).find((header) => header.name === "Content-Type")?.value, "application/json");
});

test("GraphQL rejects invalid variables, syntax, ambiguous operations and non-HTTP subscriptions", () => {
  const request = createGraphqlDocument().request;
  const prepare = (query: string, variables = "", operationName = "") => prepareGraphqlRequest({ ...request, graphql: { query, variables, operationName } });
  assert.throws(() => prepare(""), /Enter a GraphQL/);
  assert.throws(() => prepare("query {"), /Syntax Error/);
  for (const variables of ["null", "[]", '"value"', "true"]) assert.throws(() => prepare("{ __typename }", variables), /JSON object/);
  assert.throws(() => prepare("{ __typename }", "{"), /valid JSON/);
  assert.throws(() => prepare("query A { __typename } query B { __typename }"), /Select an operation/);
  assert.throws(() => prepare("query A { __typename }", "", "B"), /not found/);
  assert.throws(() => prepare("subscription { changed }"), /streaming transport/);
  assert.equal(JSON.parse(prepare("query A { __typename } query B { __typename }", "{}", "B").body.json).operationName, "B");
});

test("SDL and wrapped or bare introspection JSON produce the same schema; error responses are rejected", () => {
  const sdl = 'type Query { customer(id: ID!): Customer } type Customer { id: ID! name: String old: String @deprecated(reason: "Use name") }';
  const introspection = introspectionFromSchema(buildSchema(sdl));
  assert.equal(normalizeSchema(sdl), normalizeSchema(JSON.stringify({ data: introspection })));
  assert.equal(normalizeSchema(sdl), normalizeSchema(JSON.stringify(introspection)));
  assert.equal(parseGraphqlSchema(sdl).getQueryType()?.getFields().customer.args[0].name, "id");
  assert.throws(() => normalizeSchema('{"errors":[{"message":"Introspection disabled"}]}'), /Introspection disabled/);
  assert.throws(() => normalizeSchema("type Query { missing: Nope }"), /Unknown type/);
  const withDirectives = 'directive @private on FIELD_DEFINITION\ntype Query { name: String @private }\nextend type Query { other: Int }';
  assert.match(normalizeSchema(withDirectives), /name: String @private/);
  assert.match(normalizeSchema(withDirectives), /extend type Query/);
});

test("GraphQL snapshots, schemas and last-created type survive validation while old HTTP workspaces still load", () => {
  let workspace = createWorkspace();
  const document = createGraphqlDocument();
  assert.equal(isMeaningfulDraft(document), false);
  document.request.graphql.query = "{ __typename }";
  document.saved = true; document.savedRequest = cloneRequestDraft(document.request);
  const schema = createSchemaDocument(document);
  schema.sdl = "type Query { name: String }";
  workspace = openDocument({ ...workspace, documents: [...workspace.documents, document, schema] }, document.id);
  workspace = openDocument(workspace, schema.id);
  assert.equal(workspace.ui.lastRequestKind, "graphql");
  document.request.graphql.query = "{ other }";
  assert.equal(isDocumentDirty(document), true);
  workspace = closeDocument(workspace, document.id);
  const restored = validateWorkspace(JSON.parse(JSON.stringify(workspace)));
  const request = restored.documents.find((item) => item.id === document.id)!;
  assert.equal(request.kind !== "schema" && request.request.graphql?.query, "{ __typename }");
  assert.equal(restored.ui.activeDocumentId, schema.id);
  assert.equal(restored.documents.find((item) => item.kind === "schema")?.sdl, schema.sdl);
  const legacySchema = JSON.parse(JSON.stringify(schema));
  delete legacySchema.endpoint;
  legacySchema.source = "introspection";
  legacySchema.sourceLabel = "https://example.com/graphql";
  workspace.documents = [document, legacySchema];
  const migratedSchema = validateWorkspace(JSON.parse(JSON.stringify(workspace))).documents.find((item) => item.kind === "schema");
  assert.equal(migratedSchema?.kind === "schema" ? migratedSchema.endpoint : "wrong-kind", "https://example.com/graphql");
  const legacy = createWorkspace(); delete (legacy.ui as Partial<typeof legacy.ui>).lastRequestKind;
  assert.equal(validateWorkspace(legacy).ui.lastRequestKind, "http");
});

test("schema documents stay ephemeral until loaded and deletion unlinks or reassigns their requests", () => {
  const source = createGraphqlDocument();
  source.request.url = "https://example.com/graphql";
  const sibling = createGraphqlDocument();
  const schema = createSchemaDocument(source);
  sibling.request.graphql.schemaId = schema.id;
  schema.sdl = "type Query { ping: String }";
  let workspace = createWorkspace();
  workspace.documents = [source, sibling, schema];
  workspace.ui.openDocumentIds = [source.id, sibling.id, schema.id];
  workspace.ui.activeDocumentId = schema.id;
  assert.equal(createSchemaDocument(source).saved, false);

  workspace = deleteDocument(workspace, source.id);
  const reassigned = workspace.documents.find((item) => item.kind === "schema");
  assert.equal(reassigned?.sourceRequestId, sibling.id);
  assert.equal(reassigned?.endpoint, "https://example.com/graphql");
  workspace = deleteDocument(workspace, schema.id);
  const remaining = workspace.documents.find((item) => item.id === sibling.id);
  assert.equal(remaining?.kind === "graphql" ? remaining.request.graphql.schemaId : "wrong-kind", undefined);

  const blankSource = createGraphqlDocument();
  const ephemeralSchema = createSchemaDocument(blankSource);
  workspace.documents = [blankSource, ephemeralSchema];
  workspace.ui.openDocumentIds = [blankSource.id, ephemeralSchema.id];
  workspace = closeDocument(workspace, blankSource.id);
  assert.equal(workspace.documents.some((item) => item.id === blankSource.id), false);
  const unlinked = workspace.documents.find((item) => item.id === ephemeralSchema.id && item.kind === "schema");
  assert.equal(unlinked?.sourceRequestId, "");
  assert.equal(unlinked?.endpoint, "");
  const standalone = createSchemaDocument();
  assert.equal(isMeaningfulDraft(standalone), false);
  standalone.endpoint = "{{graphql_url}}";
  assert.equal(isMeaningfulDraft(standalone), true);
});
