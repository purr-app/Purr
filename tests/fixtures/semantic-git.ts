import { environmentDefinitionSchema, extensionDocumentDefinitionSchema, requestDefinitionSchema, workspaceDefinitionSchema } from "../../src/domain/project";
import { serializeManifest, serializeResource } from "../../src/storage/yaml";
export type SemanticPreview = { path: string; before: string; after: string };
const request = requestDefinitionSchema.parse({ id: "get-user", kind: "http", name: "Create customer", method: "GET", url: "https://api.example.test/users", headers: [{ id: "accept", name: "Accept", value: { kind: "plain", value: "application/json" } }] });
const updated = requestDefinitionSchema.parse({ ...request, method: "POST", url: "{{base}}/customers", params: [{ name: "team", value: "design" }], auth: { type: "basic", username: "alice", password: { kind: "secret", ref: "purr/git-fixture/credentials/customer/password" } }, body: { type: "json", data: '{\n  "name": "Nora",\n  "role": "admin"\n}' } });
export const requestChanges: SemanticPreview = { path: "documents/get-user.yaml", before: serializeResource(request), after: serializeResource(updated) };
export const newRequest: SemanticPreview = { ...requestChanges, before: "" };
const dynamic = { id: "content-length", name: "content_length_var", kind: "dynamic-request" as const, documentId: "get-user", expression: '$.headers["content-length"]', language: "jsonpath" as const, refresh: "every-time" as const, environment: { type: "current" as const }, enabled: true, sensitive: false };
const environment = environmentDefinitionSchema.parse({ id: "test", name: "Test", kind: "environment", variables: [
  { id: "base", name: "base", kind: "static", value: "https://api.example.test", enabled: true, sensitive: false },
  { id: "region", name: "region", kind: "static", value: "eu-west-1", enabled: false, sensitive: false },
  { id: "secret", name: "api_token", kind: "static", secretRef: "purr/git-fixture/credentials/environments/test/token", enabled: true, sensitive: true },
  dynamic,
] });
export const newEnvironment: SemanticPreview = { path: "environments/test.yaml", before: "", after: serializeResource(environment) };
const manifest = workspaceDefinitionSchema.parse({ id: "git-fixture", name: "API project", variables: [dynamic] });
export const dynamicChanges: SemanticPreview = { path: "purr.yaml", before: serializeManifest(manifest), after: serializeManifest({ ...manifest, variables: [{ ...dynamic, expression: "$.body.customer.id", refresh: "cache", cacheTtlSeconds: 60 }] }) };
export const environmentChanges: SemanticPreview = { path: "environments/test.yaml", before: serializeResource(environment), after: serializeResource({ ...environment, variables: environment.variables.map((variable) => variable.id === "base" ? { ...variable, value: "https://staging.example.test" } : variable.id === "region" ? { ...variable, enabled: true } : variable) }) };

export const newBinaryRequest: SemanticPreview = { path: "documents/get-user.yaml", before: "", after: serializeResource(requestDefinitionSchema.parse({ ...request, body: { type: "binary", file: { id: "fixture-asset", name: "report.pdf", mediaType: "application/pdf" } } })) };
export const newMultipartRequest: SemanticPreview = { path: "documents/get-user.yaml", before: "", after: serializeResource(requestDefinitionSchema.parse({ ...request, body: { type: "form-data", fields: [ { name: "tag", value: "one", enabled: true }, { name: "tag", value: "two", enabled: false }, { name: "attachment", value: "", enabled: true, file: { id: "fixture-asset", name: "report.pdf", mediaType: "application/pdf" }, contentType: "application/pdf" } ] } })) };
export const opaqueExtension: SemanticPreview = { path: "documents/vendor.yaml", before: "", after: serializeResource(extensionDocumentDefinitionSchema.parse({ id: "vendor", kind: "extension", name: "Vendor document", extensionType: "fixture.vendor", configVersion: 1, config: { kind: "secret", ref: "vendor/reference", id: "vendor-id" } })) };

export const newGraphqlRequest: SemanticPreview = { path: "documents/get-user.yaml", before: "", after: serializeResource(requestDefinitionSchema.parse({ ...request, kind: "graphql", graphql: { query: "query Customer { customer { id } }", operation: "Customer", variables: "" } })) };

const graphqlRequest = requestDefinitionSchema.parse({ ...request, kind: "graphql", method: "POST", url: "https://api.example.test/graphql", graphql: {
  query: '# Customer details\nquery Customer($id: ID!, $limit: Int = 10) {\n  customer(id: $id) {\n    id\n    name\n    friends(limit: $limit) { id }\n  }\n}', operation: "Customer", variables: '{"id":"42","filter":{"limit":10,"active":true}}',
} });
export const graphqlChanges: SemanticPreview = { path: "documents/get-user.yaml", before: serializeResource(graphqlRequest), after: serializeResource({ ...graphqlRequest, graphql: { ...graphqlRequest.graphql, query: graphqlRequest.graphql!.query.replace("    name", "    email"), variables: '{"id":"42","filter":{"limit":20,"active":true}}' } }) };
export const graphqlFormatting: SemanticPreview = { ...graphqlChanges, after: serializeResource({ ...graphqlRequest, graphql: { ...graphqlRequest.graphql, query: 'query Customer($id:ID!,$limit:Int=10){customer(id:$id){id name friends(limit:$limit){id}}}', variables: '{ "id": "42", "filter": { "limit": 10, "active": true } }' } }) };
export const schemaChanges: SemanticPreview = { path: "schemas/characters.graphql", before: '"A character"\ntype Character {\n  id: ID!\n  name: String\n  status: String\n}\n\ntype Query {\n  character(id: ID!): Character\n}\n', after: '"A character"\ntype Character {\n  id: ID!\n  name: String!\n  created: DateTime\n}\n\ntype Query {\n  character(id: ID!): Character\n}\n\nscalar DateTime\n' };
export const newSchema: SemanticPreview = { ...schemaChanges, before: "" };
export const deletedSchema: SemanticPreview = { ...schemaChanges, after: "" };

const alignmentEnvironment = environmentDefinitionSchema.parse({ ...environment, variables: [
  { id: "notes", name: "notes", kind: "static", value: "first\nsecond\nthird", enabled: true, sensitive: false },
  ...environment.variables,
] });
export const alignmentChanges: SemanticPreview = { path: "environments/test.yaml", before: serializeResource(alignmentEnvironment), after: serializeResource({ ...alignmentEnvironment, variables: alignmentEnvironment.variables.map((variable) => variable.id === "notes" ? { ...variable, value: "first\nupdated" } : variable.id === "region" ? { ...variable, enabled: true } : variable.id === "base" ? { ...variable, value: "https://staging.example.test" } : variable.id === "secret" ? { ...variable, secretRef: "purr/git-fixture/credentials/new-token" } : { ...variable, expression: "$.body.customer.id" }) }) };

const documentedRequest = requestDefinitionSchema.parse({ ...request, documentation: Array.from({ length: 40 }, (_, index) => `Documentation line ${index + 1}: retained context`).join("\n") });
export const longTextChange: SemanticPreview = { path: "documents/get-user.yaml", before: serializeResource(documentedRequest), after: serializeResource({ ...documentedRequest, url: documentedRequest.url + "/42" }) };

function requestPreview(before: unknown, after: unknown): SemanticPreview {
  return { path: "documents/get-user.yaml", before: serializeResource(requestDefinitionSchema.parse(before)), after: serializeResource(requestDefinitionSchema.parse(after)) };
}
const headerRequest = requestDefinitionSchema.parse({ ...request, headers: [{ id: "header", name: "X-Mode", enabled: true, sensitive: false, value: { kind: "plain", value: "pam" } }] });
export const headerValueChange = requestPreview(headerRequest, { ...headerRequest, headers: [{ ...headerRequest.headers[0], value: { kind: "plain", value: "pa" } }] });
export const headerRename = requestPreview(headerRequest, { ...headerRequest, headers: [{ ...headerRequest.headers[0], name: "X-Request-Mode" }] });
export const headerRenameAndValue = requestPreview(headerRequest, { ...headerRequest, headers: [{ ...headerRequest.headers[0], name: "X-Request-Mode", value: { kind: "plain", value: "Token" } }] });
export const headerAddRemove = requestPreview(headerRequest, { ...headerRequest, headers: [{ id: "added", name: "X-New", value: { kind: "plain", value: "enabled" } }] });
const secretRequest = requestDefinitionSchema.parse({ ...request, headers: [
  { id: "changed", name: "X-API-Key", sensitive: true, value: { kind: "secret", ref: "purr/git-fixture/credentials/old" } },
  { id: "same", name: "X-Same-Key", sensitive: true, value: { kind: "secret", ref: "purr/git-fixture/credentials/same" } },
] });
export const secretHeaderChanges = requestPreview(secretRequest, { ...secretRequest, headers: [{ ...secretRequest.headers[0], value: { kind: "secret", ref: "purr/git-fixture/credentials/new" } }, secretRequest.headers[1]] });
const jsonRequest = requestDefinitionSchema.parse({ ...request, body: { type: "json", data: '{\n  "name": "Nora",\n  "limit": 10,\n  "active": true\n}' } });
export const bodyReplacement = requestPreview(jsonRequest, { ...jsonRequest, body: { type: "xml", data: '<customer active="true">\n  <name>Nora</name>\n  <limit>20</limit>\n</customer>' } });
export const jsonValueChange = requestPreview(jsonRequest, { ...jsonRequest, body: { ...jsonRequest.body, data: '{\n  "name": "Nora",\n  "limit": 20,\n  "active": true\n}' } });
export const xmlValueChange = requestPreview({ ...request, body: { type: "xml", data: '<customer>\n  <name>Nora</name>\n  <limit>10</limit>\n</customer>' } }, { ...request, body: { type: "xml", data: '<customer>\n  <name>Nora</name>\n  <limit>20</limit>\n</customer>' } });
export const nestedGraphqlChanges = requestPreview({ ...graphqlRequest, graphql: { ...graphqlRequest.graphql,
  query: 'query Customer($id: ID!, $active: Boolean = true) {\n  customer(id: $id) {\n    id\n    name\n    friends(limit: 10) {\n      id\n      name\n    }\n    legacy\n  }\n}\n\nfragment Info on User {\n  name @include(if: true)\n}',
} }, { ...graphqlRequest, graphql: { ...graphqlRequest.graphql,
  query: 'query Customer($id: ID!, $active: Boolean = false) {\n  customer(id: $id) {\n    name\n    id\n    friends(limit: 20) {\n      name\n      id\n      email\n    }\n    created\n  }\n}\n\nfragment Info on User {\n  name @include(if: false)\n}',
} });
export const largeNewSchema: SemanticPreview = { path: "schemas/catalog.graphql", before: "", after: Array.from({ length: 12 }, (_, index) => `type Entity${index} {\n${Array.from({ length: 60 }, (_, field) => `  field${field}: String`).join("\n")}\n}`).join("\n\n") };
export const deletedRequest: SemanticPreview = { ...newRequest, before: newRequest.after, after: "" };

const entityHeaders = requestDefinitionSchema.parse({ ...request, headers: [
  { id: "renamed", name: "another", value: { kind: "plain", value: "another" } },
  { id: "removed", name: "X-API-Key", sensitive: true, value: { kind: "secret", ref: "purr/git-fixture/credentials/removed-key" } },
] });
export const headerEntities = requestPreview(entityHeaders, { ...entityHeaders, headers: [
  { ...entityHeaders.headers[0], name: "anothe", value: { kind: "plain", value: "another-change" } },
  { id: "new", name: "newgate", value: { kind: "plain", value: "new" } },
] });
const duplicateHeaders = requestDefinitionSchema.parse({ ...request, headers: [
  { id: "one", name: "X-Repeat", value: { kind: "plain", value: "one" } },
  { id: "two", name: "X-Repeat", value: { kind: "plain", value: "two" } },
] });
export const duplicateHeaderChanges = requestPreview(duplicateHeaders, { ...duplicateHeaders, headers: duplicateHeaders.headers.map((header, index) => ({ ...header, value: { kind: "plain", value: index === 0 ? "one-update" : "two-update" } })) });
export const reorderedHeaders = requestPreview(duplicateHeaders, { ...duplicateHeaders, headers: [...duplicateHeaders.headers].reverse() });
const stateHeaders = requestDefinitionSchema.parse({ ...request, headers: [
  { id: "disabled", name: "X-Mode", value: { kind: "plain", value: "same" } },
  { id: "sensitive", name: "X-Template", value: { kind: "template", value: "{{api_token}}" } },
] });
export const headerStateChanges = requestPreview(stateHeaders, { ...stateHeaders, headers: [{ ...stateHeaders.headers[0], enabled: false }, { ...stateHeaders.headers[1], sensitive: true }] });
export const longHeaderRename = requestPreview({ ...headerRequest, headers: [{ ...headerRequest.headers[0], name: `X-Previous-${"Long".repeat(18)}`, value: { kind: "plain", value: "https://example.test/" + "before/".repeat(18) } }] }, { ...headerRequest, headers: [{ ...headerRequest.headers[0], name: `X-Current-${"Long".repeat(18)}`, value: { kind: "plain", value: "https://example.test/" + "after/".repeat(18) } }] });
export const collectionValueChanges = requestPreview({ ...request, params: [{ name: "search", value: "old" }], body: { type: "url-encoded", fields: [{ name: "field", value: "one" }, { name: "tag", value: "first" }, { name: "tag", value: "second", enabled: false }] } }, { ...request, params: [{ name: "search", value: "new" }], body: { type: "url-encoded", fields: [{ name: "field", value: "two" }, { name: "tag", value: "second", enabled: false }, { name: "tag", value: "first" }] } });
