import { test } from "node:test";
import assert from "node:assert/strict";
import { createGraphqlDocument, createSchemaDocument, createWorkspace, isDocumentDirty, type Variable } from "../src/features/workspaces/model/workspace";
import { renameTemplateReferences, renameVariableDefinitions, renameWorkspaceReferences, variableRenameError, variableRenames } from "../src/features/workspaces/model/rename-variable";
import { secretRef } from "../src/storage/secrets";

const variable = (id: string, name = "base"): Variable => ({ id, name, kind: "static", value: "https://example.com", enabled: true, sensitive: false });
const renames = new Map([["base", "endpoint"]]);

test("rename matches whole tokens, preserves whitespace, and handles encoded query parameters", () => {
  assert.equal(renameTemplateReferences("{{ base }} {{base_suffix}} base {{BASE}} ?q=%7B%7Bbase%7D%7D", renames), "{{ endpoint }} {{base_suffix}} base {{BASE}} ?q=%7B%7Bendpoint%7D%7D");
  assert.equal(renameTemplateReferences("{{base}}", new Map([["base", "$&"]])), "{{$&}}");
  assert.equal(renameTemplateReferences("%7B%7Bbad%ZZ%7D%7D", renames), "%7B%7Bbad%ZZ%7D%7D");
});

test("rename keeps saved and working requests distinct and leaves history, responses and files intact", () => {
  const workspace = createWorkspace();
  const request = createGraphqlDocument();
  const file = new File(["{{base}}"], "{{base}}.txt");
  request.saved = true;
  request.request.url = "{{base}}/saved";
  request.request.body.json = '{"url":"{{base}}"}';
  request.request.body.xml = "<url>{{base}}</url>";
  request.request.body.text = "{{base}}";
  request.request.body.formData = [{ id: "field", enabled: false, key: "{{base}}", value: "{{base}}", attachment: file, contentType: "{{base}}" }];
  request.request.body.urlEncoded = [{ id: "form", enabled: true, key: "url", value: "{{base}}" }];
  request.request.headers = [{ id: "header", name: "X-{{base}}", value: "{{base}}", enabled: false }];
  request.request.params = [{ id: "param", key: "{{base}}", value: "{{base}}", enabled: false }];
  request.request.pathParams = [{ id: "path", key: "id", value: "{{base}}", enabled: true }];
  request.request.auth.bearer.token = "{{base}}";
  request.request.auth.basic.password = "{{base}}";
  request.request.auth.oauth2.clientSecret = "{{base}}";
  request.request.auth.secretRefs = { "basic.password": "purr/workspace/credentials/auth/secret" };
  request.request.graphql = { query: 'query { user(id: "{{base}}") { id } }', variables: '{"id":"{{base}}"}', operationName: "{{base}}" };
  request.savedRequest = structuredClone(request.request);
  request.request.url = "{{base}}/working";
  const historical = { ...request, id: "history", historical: { entryId: "execution", documentId: request.id, startedAt: 1, error: "" } };
  const schema = createSchemaDocument(request);
  schema.endpoint = "{{base}}/graphql";
  workspace.documents = [request, historical, schema];
  workspace.requestConfig.headers = [{ id: "shared", enabled: true, scope: "all", name: "X-Base", value: "{{base}}" }];
  workspace.requestConfig.auth = [{ id: "auth", name: "Profile", enabled: true, scope: "all", value: request.request.auth }];
  const next = renameWorkspaceReferences(workspace, renames);
  const renamed = next.documents[0];
  assert.equal(renamed.kind, "graphql");
  if (renamed.kind !== "graphql") throw new Error("Expected GraphQL");
  assert.equal(renamed.request.url, "{{endpoint}}/working");
  assert.equal(renamed.savedRequest!.url, "{{endpoint}}/saved");
  assert.equal(isDocumentDirty(renamed), true);
  assert.equal(renamed.request.body.json, '{"url":"{{endpoint}}"}');
  assert.equal(renamed.request.body.xml, "<url>{{endpoint}}</url>");
  assert.equal(renamed.request.body.formData[0].enabled, false);
  assert.equal(renamed.request.body.formData[0].attachment, file);
  assert.equal(renamed.request.body.formData[0].value, "{{endpoint}}");
  assert.equal(renamed.request.body.formData[0].contentType, "{{endpoint}}");
  assert.equal(renamed.request.auth.basic.password, "{{endpoint}}");
  assert.deepEqual(renamed.request.auth.secretRefs, request.request.auth.secretRefs);
  assert.equal(renamed.request.graphql!.variables, '{"id":"{{endpoint}}"}');
  assert.equal(next.documents[1], historical);
  assert.equal(renamed.lastResponse, request.lastResponse);
  assert.equal(next.requestConfig.headers[0].value, "{{endpoint}}");
  assert.equal(next.requestConfig.auth[0].value.bearer.token, "{{endpoint}}");
  assert.equal(next.documents[2].kind === "schema" && next.documents[2].endpoint, "{{endpoint}}/graphql");
  assert.equal(request.request.url, "{{base}}/working");
  request.request = request.savedRequest!;
  assert.equal(isDocumentDirty(renameWorkspaceReferences({ ...workspace, documents: [request] }, renames).documents[0]), false);
});

test("same-name environment overrides rename together without changing ids or secret refs", () => {
  const workspace = createWorkspace();
  workspace.variables = [variable("workspace"), { ...variable("nested", "nested"), value: "{{base}}/nested" }];
  const ref = secretRef(workspace.id, "variables", "production");
  workspace.environments = [{ id: "local", name: "Local", variables: [variable("local")] },
    { id: "production", name: "Production", variables: [{ ...variable("production"), sensitive: true, secretRef: ref, value: "" }] }];
  const next = renameWorkspaceReferences(workspace, renames);
  assert.equal(next.variables[0].name, "endpoint");
  assert.equal(next.variables[1].kind === "static" && next.variables[1].value, "{{endpoint}}/nested");
  assert.deepEqual(next.environments.map((environment) => environment.variables[0].name), ["endpoint", "endpoint"]);
  assert.equal(next.environments[1].variables[0].id, "production");
  const secret = next.environments[1].variables[0];
  assert.equal(secret.kind === "static" && secret.secretRef, ref);
  const collision = { ...workspace, environments: [{ id: "test", name: "Test", variables: [variable("a"), variable("b", "endpoint")] }] };
  assert.match(variableRenameError([collision], variable("a"), variable("a", "endpoint")), /already exists/);
  assert.equal(variableRenameError([workspace], variable("a"), variable("a", "endpoint")), "");
  assert.match(variableRenameError([{ ...workspace, environments: [{ id: "other", name: "Other", variables: [variable("b", "endpoint")] }] }], variable("a"), variable("a", "endpoint")), /already exists/);
  assert.deepEqual(variableRenames([variable("a")], [variable("a", "endpoint")]), renames);
  assert.equal(renameVariableDefinitions([{ ...variable("global", "global"), value: "{{base}}" }], renames)[0].kind, "static");
});
