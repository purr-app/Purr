import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWorkspaceRequestConfig, cloneRequestDraft, closeDocument, createHttpDocument, createWorkspace, discardAllDrafts, discardDocument, duplicateDocument, getDocumentDisplayName, getEnvironmentVariables, isDocumentDirty, isMeaningfulDraft, openDocument, pinDocument, previewDocument, reorderOpenDocuments, validateEnvironment, validateWorkspace } from "../src/features/workspaces/model/workspace";
import { resolveEnvironmentValue } from "../src/shared/lib/resolve-variables";
import { resolveRequestEnvironment } from "../src/features/workspaces/model/environment";
import { applyRequestQueryParamsToUrl, getRequestHeaders, getRequestQueryParamsFromUrl } from "../src/features/request-workbench/model/request";
import { serializeRequestBody } from "../src/features/request-workbench/model/request-body";
import { createRequestAuth } from "../src/features/request-workbench/model/request-auth";

test("new workspaces have independent blank documents and layout state", () => {
  const first = createWorkspace(); const second = createWorkspace("Team");
  assert.equal(first.name, "Personal");
  assert.equal(first.documents[0].request.url, "");
  assert.notEqual(first.documents[0].id, second.documents[0].id);
  assert.notEqual(first.documents[0].request.body, second.documents[0].request.body);
  first.ui.view = "vertical";
  assert.equal(second.ui.view, "canvas");
});

test("draft labels follow the URL while saved document names stay stable", () => {
  const document = createHttpDocument();
  assert.equal(getDocumentDisplayName(document), "Untitled Request");
  document.request.url = "https://api.example.com/users/42?active=true";
  assert.equal(getDocumentDisplayName(document), "api.example.com/users/42?active=true");
  document.name = "List users";
  document.saved = true;
  assert.equal(getDocumentDisplayName(document), "List users");
});

test("closing tabs preserves real drafts, removes pristine tabs, and does not duplicate tabs", () => {
  let workspace = createWorkspace(); const first = workspace.documents[0]; const second = createHttpDocument();
  second.request.url = "https://example.com/draft";
  workspace.documents.push(second);
  workspace.ui.cookiesTabOpen = true;
  workspace.ui.cookiesTabActive = true;
  workspace = openDocument(workspace, second.id);
  assert.equal(workspace.ui.cookiesTabActive, false);
  workspace = openDocument(workspace, second.id);
  assert.equal(workspace.ui.openDocumentIds.length, 2);
  workspace = closeDocument(workspace, second.id);
  assert.equal(workspace.ui.activeDocumentId, first.id);
  assert.equal(workspace.documents.length, 2);
  workspace = closeDocument(workspace, first.id);
  assert.equal(workspace.ui.activeDocumentId, null);
  assert.equal(workspace.documents.length, 1);
  assert.equal(openDocument(workspace, second.id).ui.activeDocumentId, second.id);
});

test("saved documents keep an explicit snapshot until Save and drafts can be discarded", () => {
  let workspace = createWorkspace();
  const id = workspace.documents[0].id;
  workspace.documents[0].request.url = "https://example.com/saved";
  workspace.documents[0].saved = true;
  workspace.documents[0].savedRequest = cloneRequestDraft(workspace.documents[0].request);
  workspace.documents[0].request.url = "https://example.com/working-copy";
  assert.equal(isDocumentDirty(workspace.documents[0]), true);
  workspace = closeDocument(workspace, id);
  assert.equal(workspace.documents[0].request.url, "https://example.com/saved");
  assert.equal(isDocumentDirty(workspace.documents[0]), false);

  const draft = createHttpDocument();
  draft.request.headers[0] = { ...draft.request.headers[0], name: "X-Draft", value: "one", enabled: true };
  workspace.documents.push(draft);
  workspace = openDocument(workspace, draft.id);
  assert.equal(isMeaningfulDraft(draft), true);
  workspace = discardDocument(workspace, draft.id);
  assert.equal(workspace.documents.some((document) => document.id === draft.id), false);

  const firstDraft = createHttpDocument(); firstDraft.request.url = "https://example.com/one";
  const secondDraft = createHttpDocument(); secondDraft.request.url = "https://example.com/two";
  const blank = createHttpDocument();
  workspace.documents.push(firstDraft, secondDraft, blank);
  workspace = openDocument(openDocument(workspace, firstDraft.id), secondDraft.id);
  workspace = discardAllDrafts(workspace);
  assert.equal(workspace.documents.some((document) => document.id === firstDraft.id || document.id === secondDraft.id), false);
  assert.equal(workspace.documents.some((document) => document.id === blank.id), true);
});

test("clean saved documents use one replaceable preview tab and ordered tabs can be pinned", () => {
  let workspace = createWorkspace();
  const first = workspace.documents[0];
  first.name = "First";
  first.saved = true;
  first.request.url = "https://example.com/first";
  first.savedRequest = cloneRequestDraft(first.request);
  workspace = closeDocument(workspace, first.id);

  const second = createHttpDocument();
  second.name = "Second";
  second.saved = true;
  second.request.url = "https://example.com/second";
  second.savedRequest = cloneRequestDraft(second.request);
  const third = createHttpDocument();
  third.name = "Third";
  third.saved = true;
  third.request.url = "https://example.com/third";
  third.savedRequest = cloneRequestDraft(third.request);
  workspace.documents.push(second, third);

  workspace = previewDocument(workspace, second.id);
  assert.deepEqual(workspace.ui.openDocumentIds, [second.id]);
  assert.equal(workspace.ui.previewDocumentId, second.id);
  workspace = previewDocument(workspace, third.id);
  assert.deepEqual(workspace.ui.openDocumentIds, [third.id]);
  assert.equal(workspace.ui.previewDocumentId, third.id);
  workspace = pinDocument(workspace, third.id);
  workspace = openDocument(workspace, second.id);
  workspace = reorderOpenDocuments(workspace, second.id, third.id);
  assert.deepEqual(workspace.ui.openDocumentIds, [second.id, third.id]);
  assert.equal(workspace.ui.previewDocumentId, null);
});

test("duplicating a document creates an independent pinned draft without reusing runtime credentials", () => {
  const workspace = createWorkspace(); const source = workspace.documents[0];
  source.saved = true; source.name = "Documented request";
  source.request.url = "https://example.test/users";
  source.request.documentation = "# Users\n\nReturns users.";
  source.request.auth.secretRefs = { bearer: "purr/workspace/requests/source/bearer" };
  source.request.auth.oauth2.token = { accessToken: "runtime-token", tokenType: "Bearer", obtainedAt: 1 };
  source.savedRequest = cloneRequestDraft(source.request);

  const duplicated = duplicateDocument(workspace, source.id);
  const copy = duplicated.documents.at(-1)!;
  assert.notEqual(copy.id, source.id);
  assert.equal(copy.name, "Documented request copy");
  assert.equal(copy.saved, false);
  assert.equal(duplicated.ui.activeDocumentId, copy.id);
  assert.equal(duplicated.ui.previewDocumentId, null);
  assert.ok("request" in copy);
  assert.equal(copy.request.documentation, source.request.documentation);
  assert.equal(copy.request.auth.secretRefs, undefined);
  assert.equal(copy.request.auth.oauth2.token, null);
  copy.request.documentation = "Changed independently";
  assert.equal(source.request.documentation, "# Users\n\nReturns users.");
});

test("workspace validation refuses unsupported versions and repairs dangling tab IDs", () => {
  const workspace = createWorkspace();
  workspace.ui.openDocumentIds.push("missing"); workspace.ui.activeDocumentId = "missing";
  const repaired = validateWorkspace(workspace);
  assert.deepEqual(repaired.ui.openDocumentIds, [workspace.documents[0].id]);
  assert.equal(repaired.ui.activeDocumentId, workspace.documents[0].id);
  assert.throws(() => validateWorkspace({ ...workspace, schemaVersion: 2 }), /Unsupported/);
  assert.throws(() => validateWorkspace({ ...workspace, documents: [{ ...workspace.documents[0], request: { ...workspace.documents[0].request, headers: "not-an-array" } }] }), /Invalid document/);
});

test("scoped shared values remain request-overridable", () => {
  const restored = createWorkspace();
  const document = restored.documents[0];
  restored.requestConfig.headers = [
    { id: "all", name: "X-Workspace", value: "shared", enabled: true, scope: "all" },
    { id: "gql", name: "X-GraphQL", value: "only", enabled: true, scope: "graphql" },
  ];
  const sharedAuth = createRequestAuth();
  sharedAuth.type = "bearer";
  sharedAuth.bearer.token = "workspace-token";
  restored.requestConfig.auth = [{ id: "http-auth", name: "HTTP auth", enabled: true, scope: "http", value: sharedAuth }];
  let effective = applyWorkspaceRequestConfig(document.request, "http", restored.requestConfig);
  assert.equal(effective.headers.some((header) => header.name === "X-Workspace" && header.readOnly), true);
  assert.equal(effective.headers.some((header) => header.name === "X-GraphQL"), false);
  assert.equal(effective.auth.type, "inherit");
  assert.equal(effective.auth.inherit.source, "workspace");
  assert.equal(effective.auth.inherit.profileId, "http-auth");

  document.request.workspace.headerOverrides.all = false;
  document.request.workspace.authEnabled = false;
  effective = applyWorkspaceRequestConfig(document.request, "http", restored.requestConfig);
  assert.equal(effective.headers.find((header) => header.name === "X-Workspace")?.enabled, false);
  assert.equal(effective.auth.type, "none");

  document.request.workspace.headerOverrides.all = true;
  document.request.headers = [{ id: "local", name: "X-Workspace", value: "local", enabled: true }];
  effective = applyWorkspaceRequestConfig(document.request, "http", restored.requestConfig);
  assert.deepEqual(effective.headers.filter((header) => header.name === "X-Workspace").map((header) => header.value), ["local"]);
});

test("multiple shared auth profiles can overlap and requests preserve their selected profile", () => {
  const workspace = createWorkspace();
  const first = createRequestAuth(); first.type = "bearer"; first.bearer.token = "first";
  const second = createRequestAuth(); second.type = "bearer"; second.bearer.token = "second";
  workspace.requestConfig.auth = [
    { id: "first", name: "First", enabled: true, scope: "all", value: first },
    { id: "second", name: "Second", enabled: true, scope: "http", value: second },
  ];
  const request = workspace.documents[0].request;
  request.auth = { ...request.auth, type: "inherit", inherit: { source: "workspace", profileId: "first" } };
  const effective = applyWorkspaceRequestConfig(request, "http", workspace.requestConfig);
  assert.equal(effective.auth.type, "inherit");
  assert.equal(effective.auth.inherit.profileId, "first");
  assert.doesNotThrow(() => validateWorkspace(workspace));
  request.auth.inherit.profileId = "missing";
  assert.throws(() => validateWorkspace(workspace), /missing or incompatible/);
});

test("environments are scoped and disabled variables are excluded", () => {
  const workspace = createWorkspace();
  workspace.environments = [{ id: "local", name: "Local", variables: [
    { id: "1", name: "host", kind: "static", value: "localhost", sensitive: false, enabled: true },
    { id: "2", name: "token", kind: "static", value: "secret", loaded: true, sensitive: true, enabled: false },
  ] }];
  assert.deepEqual(getEnvironmentVariables(workspace), {});
  workspace.activeEnvironmentId = "local";
  assert.deepEqual(getEnvironmentVariables(workspace), { host: "localhost" });
  assert.equal(validateEnvironment(workspace.environments[0]), null);
  assert.match(validateEnvironment({ ...workspace.environments[0], variables: [...workspace.environments[0].variables, { id: "3", name: "host", kind: "static", value: "again", sensitive: false, enabled: true }] })!, /more than once/);
});

test("variables support nesting and Unicode, with visible missing/cyclic errors", () => {
  assert.equal(resolveEnvironmentValue("{{ url }}/{{id}}", { url: "https://{{host}}", host: "example.com", id: "Привіт" }), "https://example.com/Привіт");
  assert.throws(() => resolveEnvironmentValue("{{missing}}", {}), /not defined/);
  assert.throws(() => resolveEnvironmentValue("{{a}}", { a: "{{b}}", b: "{{a}}" }), /circular/);
  assert.throws(() => resolveEnvironmentValue("{{toString}}", {}), /not defined/);
});

test("request resolution replaces only active fields without mutating templates", async () => {
  const draft = createHttpDocument().request;
  draft.url = "{{base}}/users/{{id}}";
  draft.headers = [{ id: "h", name: "{{header}}", value: "{{value}}", enabled: true }, { id: "off", name: "Disabled", value: "{{missing}}", enabled: false }];
  draft.body.type = "json"; draft.body.json = '{"id":{{id}},"name":"{{value}}"}'; draft.body.xml = "{{unused}}";
  const variables = { base: "https://example.com", id: "42", header: "X-Name", value: "Львів" };
  const resolved = resolveRequestEnvironment(draft, variables);
  assert.equal(resolved.url, "https://example.com/users/42");
  assert.deepEqual(JSON.parse(await serializeRequestBody(resolved.body)!.text()), { id: 42, name: "Львів" });
  assert.equal(resolved.headers[0].name, "X-Name");
  assert.equal(resolved.headers[0].value, "Львів");
  assert.equal(draft.url, "{{base}}/users/{{id}}");
  assert.equal(draft.body.json, '{"id":{{id}},"name":"{{value}}"}');
});

test("URL variables preserve embedded queries and query templates are encoded once", () => {
  const draft = createHttpDocument().request;
  draft.url = "{{url}}";
  let resolved = resolveRequestEnvironment(draft, { url: "https://example.com/?q=hello%20world&q=second" });
  assert.equal(new URL(applyRequestQueryParamsToUrl(resolved.url, resolved.params)).searchParams.getAll("q").length, 2);
  draft.url = "https://example.com/?q=%7B%7Bquery%7D%7D";
  draft.params = getRequestQueryParamsFromUrl(draft.url);
  resolved = resolveRequestEnvironment(draft, { query: "a & b" });
  assert.equal(applyRequestQueryParamsToUrl(resolved.url, resolved.params), "https://example.com/?q=a+%26+b");
});

test("environment resolution reaches form fields and authentication", async () => {
  const draft = createHttpDocument().request;
  draft.url = "https://example.com";
  draft.body.type = "url-encoded";
  draft.body.urlEncoded = [{ id: "1", key: "{{key}}", value: "{{value}}", enabled: true }];
  draft.auth.type = "bearer";
  draft.auth.bearer.token = "{{token}}";
  draft.auth.bearer.prefix = "{{prefix}}";
  const variables = { key: "name", value: "a & b", token: "{{secret}}", secret: "abc", prefix: "Bearer" };
  const resolved = resolveRequestEnvironment(draft, variables);
  assert.equal(await serializeRequestBody(resolved.body)!.text(), "name=a+%26+b");
  assert.equal(getRequestHeaders(resolved, { variables }).find((header) => header.name === "Authorization")?.value, "Bearer abc");
});
