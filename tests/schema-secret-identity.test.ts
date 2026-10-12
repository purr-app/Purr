import assert from "node:assert/strict";
import { test } from "node:test";
import { createSchemaDocument } from "../src/features/workspaces/model/workspace";
import { createWorkspaceRequestConfig } from "../src/features/request-workbench/model/request-workspace-config";
import { schemaConnectionIdentity } from "../src/features/graphql/model/schema-connection";

test("schema identity does not gate token-authenticated operations on acquisition variables", async () => {
  const schema = createSchemaDocument(); schema.endpoint = "https://synthetic.test/graphql";
  schema.auth.type = "oauth2";
  schema.auth.oauth2.clientSecret = "{{ acquisition_only }}";
  const identity = await schemaConnectionIdentity(schema, createWorkspaceRequestConfig(), {});
  assert.equal(identity.length, 64);
  schema.auth.oauth2.clientSecret = "{{ different_acquisition }}";
  assert.notEqual(await schemaConnectionIdentity(schema, createWorkspaceRequestConfig(), {}), identity);
});

test("schema credential and header hydration retain stable cache identity by reference", async () => {
  const schema = createSchemaDocument(); schema.endpoint = "https://synthetic.test/graphql"; schema.auth.type = "basic";
  schema.auth.credentialStates = { password: { ref: "purr/test/basic", status: "unresolved", edit: { kind: "keep" } } };
  schema.introspectionHeaders = [{ id: "header", enabled: true, name: "Sensitive", value: "", secret: true, secretState: { ref: "purr/test/header", status: "unresolved", edit: { kind: "keep" } } }];
  const config = createWorkspaceRequestConfig(); const original = await schemaConnectionIdentity(schema, config, {});
  schema.auth.basic.password = "synthetic-password"; schema.auth.credentialStates.password.status = "available";
  schema.introspectionHeaders[0].value = "synthetic-header"; schema.introspectionHeaders[0].secretState!.status = "available";
  assert.equal(await schemaConnectionIdentity(schema, config, {}), original);
  schema.auth.credentialStates.password.edit = { kind: "set", value: "replacement" };
  assert.notEqual(await schemaConnectionIdentity(schema, config, {}), original);
});
