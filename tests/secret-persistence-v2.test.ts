import assert from "node:assert/strict";
import test from "node:test";
import { WorkspacePersistence } from "../src/application/workspace-persistence";
import { CommitRejectedError } from "../src/application/ports/credentials";
import type { StorageSnapshot } from "../src/application/ports/persistence";
import { MemorySecureStore } from "../src/storage/secrets";
import { deserializeResource } from "../src/storage/yaml";
import { cloneRequestDraft, createWorkspace, isRequestDocument, type Workspace, type WorkspaceStore } from "../src/features/workspaces/model/workspace";
import { importCurlRequest } from "../src/features/request-workbench/model/curl-import";
import { MemoryPersistenceBackend } from "./helpers/memory-persistence";
import { startSecureStorageFixtureServer, syntheticCredentials } from "./fixtures/secure-storage-server";

const asStore = (workspace: Workspace): WorkspaceStore => ({ activeWorkspaceId: workspace.id, workspaces: [workspace], globalVariables: [] });
function requestDocument(workspace: Workspace, id?: string) {
  const document = id ? workspace.documents.find((value) => value.id === id) : workspace.documents.find(isRequestDocument);
  assert.ok(document && isRequestDocument(document)); return document;
}
function definition(backend: MemoryPersistenceBackend, workspaceId: string, documentId: string) {
  const workspace = backend.snapshot.workspaces.find((value) => value.id === workspaceId);
  assert.ok(workspace);
  for (const [path, file] of Object.entries(workspace.files)) {
    if (path === "purr.yaml" || !path.endsWith(".yaml")) continue;
    const resource = deserializeResource(file.content, (sidecar) => workspace.files[sidecar].content);
    if (resource.id === documentId) {
      assert.ok(resource.kind === "http" || resource.kind === "graphql"); return resource;
    }
  }
  assert.fail("Saved request is missing from canonical files");
}
function fixture(id: string) {
  const secure = new MemorySecureStore(); const backend = new MemoryPersistenceBackend(secure);
  const persistence = new WorkspacePersistence(backend, secure); const workspace = createWorkspace("Secret regression", id);
  const document = requestDocument(workspace); document.saved = true; document.savedRequest = cloneRequestDraft(document.request);
  return { secure, backend, persistence, workspace, document };
}

function legacySnapshot(): StorageSnapshot {
  const files: Record<string, string> = {
    "purr.yaml": "purr: 1\nworkspace:\n  id: legacy-secret\n  name: Legacy fixture\n",
    "documents/basic.yaml": "purr: 1\nkind: http\nid: legacy-basic\nname: Legacy Basic\nmethod: GET\nurl: http://127.0.0.1:18765/basic\nheaders:\n  - name: X-Public\n    value: '{{PUBLIC}}'\nauth:\n  type: basic\n  username: purr-test\n  password:\n    kind: plain\n    value: legacy-password-{{suffix}}\n",
    "documents/untouched.yaml": "purr: 1\nkind: http\nid: untouched\nname: Untouched Bearer\nmethod: GET\nurl: http://127.0.0.1:18765/bearer\nauth:\n  type: bearer\n  token:\n    kind: secret\n    ref: purr/legacy-secret/credentials/requests/untouched/saved/bearer\n",
    "integrations/opaque.yaml": "purr: 1\nkind: integration\nid: opaque\nname: Opaque provider\nprovider: private.example\nconfigVersion: 7\nconfig:\n  emptyList: []\n  nested: { enabled: true, body: { type: none } }\ncredentials: {}\n",
    "schemas/api.yaml": "purr: 1\nkind: api-schema\nid: original-api\nname: Original API\nformat: openapi-3\nsource: { type: text, location: fixture }\nschema: schemas/original.openapi\n",
    "schemas/original.openapi": "openapi: 3.0.3\ninfo: { title: Synthetic, version: 1.0.0 }\npaths: {}\n# preserve original source bytes\n",
    "assets/opaque.bin": "AAECAwQ=",
  };
  return { activeWorkspaceId: "legacy-secret", workspaces: [{ id: "legacy-secret", local: [],
    files: Object.fromEntries(Object.entries(files).map(([path, content], index) => [path, { content, revision: `fixture-${index}` }])) }] };
}

// The initial flag models an older cURL import or an explicit user marking.
// New ordinary headers are not classified merely from their names.
test("a retained sensitive cURL header stays protected after literal edit, duplicate reorder, disable and reload", async () => {
  const { secure, backend, persistence, workspace, document } = fixture("header-v2");
  document.request = importCurlRequest("curl 'http://127.0.0.1:18765/echo' -H 'Authorization: {{TOKEN}}'", document.request);
  const original = document.request.headers.find((row) => row.name === "Authorization"); assert.ok(original);
  original.secret = true;
  document.savedRequest = cloneRequestDraft(document.request);
  await persistence.save(asStore(workspace));
  const initial = definition(backend, workspace.id, document.id).headers.find((row) => row.id === original.id);
  assert.ok(initial); assert.equal(initial.sensitive, true); assert.deepEqual(initial.value, { kind: "template", value: "{{TOKEN}}" });

  const marker = "synthetic-header-literal-after-template";
  original.value = marker; original.enabled = false;
  document.request.headers = [{ id: "duplicate-public", name: "Authorization", value: "user-public-value", enabled: true, secret: false }, original];
  document.savedRequest = cloneRequestDraft(document.request);
  await persistence.saveWorkspace(workspace, undefined, { intent: "explicit" });
  const saved = definition(backend, workspace.id, document.id);
  assert.deepEqual(saved.headers.map((row) => row.id), ["duplicate-public", original.id]);
  assert.equal(saved.headers[0].sensitive, false); assert.equal(saved.headers[0].value.kind, "plain");
  const secret = saved.headers[1]; assert.equal(secret.enabled, false); assert.equal(secret.sensitive, true);
  assert.equal(secret.value.kind, "secret"); if (secret.value.kind !== "secret") return;
  assert.equal(await secure.get(secret.value.ref), marker);
  assert.ok(!JSON.stringify(backend.snapshot).includes(marker), "canonical and local payloads must contain references only");
  const restarted = await new WorkspacePersistence(backend, secure).load();
  const row = requestDocument(restarted.workspaces[0], document.id).request.headers.find((header) => header.id === original.id);
  assert.ok(row); assert.equal(row.secret, true); assert.equal(row.enabled, false);
  assert.equal(row.secretState?.ref ?? row.secretRef, secret.value.ref);
});

test("mixed passwords are encrypted as whole expressions while pure credential references and URL templates remain canonical", async () => {
  const { secure, backend, persistence, workspace, document } = fixture("expressions-v2");
  document.request.url = "https://{{host}}/api";
  document.request.auth.type = "basic"; document.request.auth.basic.password = "synthetic-prefix-{{suffix}}";
  document.savedRequest = cloneRequestDraft(document.request);
  await persistence.save(asStore(workspace));
  const basic = definition(backend, workspace.id, document.id); assert.equal(basic.auth.type, "basic");
  if (basic.auth.type !== "basic") return;
  assert.equal(basic.auth.password.kind, "secret"); if (basic.auth.password.kind !== "secret") return;
  assert.equal(await secure.get(basic.auth.password.ref), "synthetic-prefix-{{suffix}}");
  assert.equal(basic.url, "https://{{host}}/api"); assert.ok(!JSON.stringify(backend.snapshot).includes("synthetic-prefix"));
  document.request.auth.type = "bearer"; document.request.auth.bearer.token = " \n{{ API_TOKEN }}\t ";
  document.savedRequest = cloneRequestDraft(document.request);
  await persistence.saveWorkspace(workspace, undefined, { intent: "explicit" });
  const bearer = definition(backend, workspace.id, document.id); assert.equal(bearer.auth.type, "bearer");
  if (bearer.auth.type === "bearer") assert.deepEqual(bearer.auth.token, { kind: "template", value: " \n{{ API_TOKEN }}\t " });
});

test("missing refs survive unrelated saves; intentionally empty and explicit deletion remain different mutations", async () => {
  const { secure, backend, persistence, workspace, document } = fixture("availability-v2");
  document.request.auth.type = "basic"; document.request.auth.basic.password = "synthetic-initial-password";
  document.savedRequest = cloneRequestDraft(document.request); await persistence.save(asStore(workspace));
  const saved = definition(backend, workspace.id, document.id); assert.equal(saved.auth.type, "basic");
  if (saved.auth.type !== "basic" || saved.auth.password.kind !== "secret") return assert.fail("Expected a password ref");
  const reference = saved.auth.password.ref; await secure.delete(reference);
  const restarted = new WorkspacePersistence(backend, secure); const store = await restarted.load();
  const missing = requestDocument(store.workspaces[0], document.id); const before = await secure.read(reference);
  assert.notEqual(missing.request.auth.credentialStates?.password?.status, "available");
  missing.name = "Unrelated rename"; store.workspaces[0].ui.sidebarWidth = 19;
  await restarted.save(store);
  assert.deepEqual(await secure.read(reference), before);
  const preserved = definition(backend, workspace.id, document.id); assert.equal(preserved.auth.type, "basic");
  if (preserved.auth.type === "basic") assert.deepEqual(preserved.auth.password, { kind: "secret", ref: reference });

  missing.request.auth.credentialStates = { ...missing.request.auth.credentialStates,
    password: { ref: reference, status: "missing", edit: { kind: "set", value: "" } } };
  missing.request.auth.basic.password = ""; missing.savedRequest = cloneRequestDraft(missing.request);
  await restarted.saveWorkspace(store.workspaces[0], undefined, { intent: "explicit" });
  const empty = await secure.resolve(reference); assert.equal(empty.status, "available");
  if (empty.status === "available") assert.equal(empty.value, "");
  missing.request.auth.credentialStates.password = { ref: reference, status: "available", edit: { kind: "delete" } };
  missing.savedRequest = cloneRequestDraft(missing.request);
  await restarted.saveWorkspace(store.workspaces[0], undefined, { intent: "explicit" });
  const deleted = await secure.resolve(reference); assert.equal(deleted.status, "missing");
  if (deleted.status === "missing" && empty.status === "available") assert.ok(deleted.revision > empty.revision);
});

test("v1 opening and layout autosave preserve canonical bytes and saved credential ownership", async () => {
  const secure = new MemorySecureStore(); const backend = new MemoryPersistenceBackend(secure); backend.snapshot = legacySnapshot();
  const reference = "purr/legacy-secret/credentials/requests/untouched/saved/bearer";
  await secure.set(reference, "synthetic-existing-token"); const before = await secure.read(reference);
  const original = structuredClone(backend.snapshot.workspaces[0].files);
  const persistence = new WorkspacePersistence(backend, secure); const store = await persistence.load();
  assert.deepEqual(backend.snapshot.workspaces[0].files, original); assert.equal(backend.writes.length, 0);
  assert.equal(persistence.getWorkspaceStatus("legacy-secret").sourceVersion, 1);
  assert.equal(persistence.getWorkspaceStatus("legacy-secret").migrationRequired, true);
  store.workspaces[0].ui.sidebarWidth = 21;
  await persistence.save(store);
  assert.deepEqual(backend.snapshot.workspaces[0].files, original); assert.equal(backend.writes.length, 0);
  assert.deepEqual(await secure.read(reference), before);
  assert.equal(await secure.get("purr/legacy-secret/credentials/requests/legacy-basic/saved/password"), null);
});

test("explicit v1 upgrade publishes every YAML at v2 together and a rejected commit leaves originals and secrets untouched", async () => {
  const secure = new MemorySecureStore(); const backend = new MemoryPersistenceBackend(secure); backend.snapshot = legacySnapshot();
  const persistence = new WorkspacePersistence(backend, secure); const store = await persistence.load(); const workspace = store.workspaces[0];
  const before = structuredClone(backend.snapshot); const commit = backend.commit.bind(backend);
  const rejectedPlans: Parameters<typeof backend.commit>[] = [];
  backend.commit = async (...args) => { rejectedPlans.push(args); throw new CommitRejectedError("Injected upgrade rejection"); };
  await assert.rejects(persistence.upgradeWorkspace(workspace), /Injected upgrade rejection/);
  assert.deepEqual(backend.snapshot, before); assert.equal(persistence.getWorkspaceStatus(workspace.id).sourceVersion, 1);
  assert.equal(await secure.get("purr/legacy-secret/credentials/requests/legacy-basic/saved/password"), null);
  const plans: Parameters<typeof backend.commit>[] = [];
  backend.commit = async (...args) => { plans.push(args); return commit(...args); };
  await persistence.upgradeWorkspace(workspace);
  assert.equal(plans.length, 1, "the complete format transition must use one S01 commit");
  assert.equal(rejectedPlans.length, 1);
  assert.notEqual(plans[0][3]?.operationId, rejectedPlans[0][3]?.operationId, "retry prepares a fresh operation");
  const plannedHeaderIds = (plan: Parameters<typeof backend.commit>) => plan[1].flatMap((change) => {
    if (!change.content || !change.path.endsWith(".yaml") || change.path === "purr.yaml") return [];
    if (!change.content.includes("id: legacy-basic\n")) return [];
    const resource = deserializeResource(change.content);
    return resource.kind === "http" ? resource.headers.map((header) => header.id) : [];
  });
  assert.ok(plannedHeaderIds(plans[0]).length);
  assert.deepEqual(plannedHeaderIds(plans[0]), plannedHeaderIds(rejectedPlans[0]), "conversion identities survive a rejected upgrade");
  assert.ok(plans[0][1].some((change) => change.path === "purr.yaml"));
  const files = backend.snapshot.workspaces[0].files;
  for (const [path, file] of Object.entries(files)) if (path.endsWith(".yaml")) assert.match(file.content, /^purr: 2\n/, path);
  assert.equal(files["schemas/original.openapi"].content, before.workspaces[0].files["schemas/original.openapi"].content);
  assert.equal(files["assets/opaque.bin"].content, before.workspaces[0].files["assets/opaque.bin"].content);
  const opaque = deserializeResource(files["integrations/opaque.yaml"].content);
  assert.equal(opaque.kind, "integration"); if (opaque.kind === "integration") assert.deepEqual(opaque.config, { emptyList: [], nested: { enabled: true, body: { type: "none" } } });
  assert.equal(persistence.getWorkspaceStatus(workspace.id).sourceVersion, 2);
  assert.equal(persistence.getWorkspaceStatus(workspace.id).migrationRequired, false);
  assert.ok(!JSON.stringify(backend.snapshot).includes("legacy-password-{{suffix}}"));
  assert.equal(await secure.get("purr/legacy-secret/credentials/requests/legacy-basic/saved/password"), "legacy-password-{{suffix}}");
});

test("canonical-only degraded loading and autosave leave opaque local records and the vault untouched", async () => {
  const secure = new MemorySecureStore(); const backend = new MemoryPersistenceBackend(secure); backend.snapshot = legacySnapshot();
  backend.snapshot.protectedState = { status: "locked", code: "synthetic-keystore-locked" };
  backend.snapshot.workspaces[0].local = [{ table: "drafts", id: "opaque", value: { encrypted: "synthetic-opaque-payload" } }];
  const original = structuredClone(backend.snapshot); let writes = 0; let reads = 0;
  backend.commit = async () => { writes += 1; throw new Error("Unexpected degraded write"); };
  backend.writeGlobal = async () => { writes += 1; throw new Error("Unexpected degraded global write"); };
  backend.setActiveWorkspace = async () => { writes += 1; throw new Error("Unexpected degraded active selection write"); };
  backend.finishMigration = async () => { writes += 1; throw new Error("Unexpected degraded migration write"); };
  secure.read = async () => { reads += 1; throw new Error("Unexpected unavailable vault read"); };
  const persistence = new WorkspacePersistence(backend, secure); const store = await persistence.load();
  assert.equal(store.workspaces[0].id, "legacy-secret"); assert.equal(persistence.getWorkspaceStatus("legacy-secret").protectedState.status, "locked");
  store.workspaces[0].ui.sidebarWidth = 20; await persistence.save(store);
  await assert.rejects(persistence.upgradeWorkspace(store.workspaces[0]), /locked|unavailable|protected|read.only/i);
  assert.equal(writes, 0); assert.equal(reads, 0); assert.deepEqual(backend.snapshot, original);
});

test("reusable localhost fixture distinguishes A/B credentials, rejects invalid auth, echoes synthetic data and sets cookies", async (context) => {
  const fixture = await startSecureStorageFixtureServer(0); context.after(() => fixture.close());
  assert.match(fixture.url, /^http:\/\/127\.0\.0\.1:/);
  assert.deepEqual(await (await fetch(`${fixture.url}/health`)).json(), { ok: true });
  for (const label of ["A", "B"] as const) {
    const basic = await fetch(`${fixture.url}/basic`, { headers: { authorization: `Basic ${Buffer.from(`${syntheticCredentials.username}:${syntheticCredentials[label]}`).toString("base64")}` } });
    assert.equal(basic.status, 200); assert.deepEqual(await basic.json(), { credential: label });
    assert.deepEqual(await (await fetch(`${fixture.url}/bearer`, { headers: { authorization: `Bearer ${syntheticCredentials[label]}` } })).json(), { credential: label });
  }
  const missing = await fetch(`${fixture.url}/basic`); assert.equal(missing.status, 401); assert.deepEqual(await missing.json(), { credential: "missing-or-invalid" });
  const echo = await (await fetch(`${fixture.url}/echo?a=one&a=two`, { method: "POST", headers: { "x-fixture": "synthetic-header" }, body: "synthetic-body" })).json() as { query: string[][]; headers: Record<string, string>; body: string };
  assert.deepEqual(echo.query, [["a", "one"], ["a", "two"]]); assert.equal(echo.headers["x-fixture"], "synthetic-header"); assert.equal(echo.body, "synthetic-body");
  const cookie = (await fetch(`${fixture.url}/cookies/set`)).headers.get("set-cookie"); assert.ok(cookie);
  assert.deepEqual(await (await fetch(`${fixture.url}/cookies/check`, { headers: { cookie: cookie.split(";")[0] } })).json(), { cookie: "A" });
  assert.deepEqual(await (await fetch(`${fixture.url}/cookies/check`)).json(), { cookie: "missing" });
});

test("autosave preserves resolved clean editor buffers after lazy restart", async () => {
  for (const type of ["basic", "bearer"] as const) {
    const { secure, backend, persistence, workspace, document } = fixture(`hydration-${type}`);
    document.request.auth.type = type;
    document.request.auth.basic.password = "synthetic-password";
    document.request.auth.bearer.token = "synthetic-bearer";
    document.request.headers = [{ id: "sensitive-row", name: "X-User-Secret", value: "synthetic-header", enabled: true, secret: true }];
    document.savedRequest = cloneRequestDraft(document.request);
    await persistence.save(asStore(workspace));
    const restarted = new WorkspacePersistence(backend, secure);
    const store = await restarted.load();
    const restored = requestDocument(store.workspaces[0], document.id);
    const slot = type === "basic" ? "password" : "bearer";
    const state = restored.request.auth.credentialStates![slot];
    assert.equal(state.status, "unresolved");
    const resolution = await secure.resolve(state.ref);
    assert.equal(resolution.status, "available");
    if (resolution.status !== "available") assert.fail("Synthetic secret must be available");
    const header = restored.request.headers.find((row) => row.id === "sensitive-row")!;
    const headerResolution = await secure.resolve(header.secretState!.ref);
    if (headerResolution.status !== "available") assert.fail("Synthetic header must be available");
    const auth = { ...restored.request.auth, credentialStates: { ...restored.request.auth.credentialStates, [slot]: { ...state, status: "available" as const } },
      ...(type === "basic" ? { basic: { ...restored.request.auth.basic, password: resolution.value } } : { bearer: { ...restored.request.auth.bearer, token: resolution.value } }) };
    restored.request = { ...restored.request, auth, headers: restored.request.headers.map((row) => row.id === header.id ? { ...row, value: headerResolution.value, secretState: { ...row.secretState!, status: "available" as const } } : row) };
    const before = await secure.read(state.ref);
    for (let index = 0; index < 3; index++) {
      store.workspaces[0].ui.sidebarWidth = 19 + index;
      await restarted.save(store);
      assert.equal(restored.request.auth.credentialStates![slot].status, "available", `${type}: autosave must not restore the unresolved saved buffer`);
      assert.equal(restored.request.headers.find((row) => row.id === header.id)!.secretState!.status, "available");
      assert.deepEqual(await secure.read(state.ref), before, "hydration must not modify the vault");
    }
    for (const status of ["missing", "locked"] as const) {
      restored.request.auth.credentialStates![slot] = { ...restored.request.auth.credentialStates![slot], status };
      await restarted.save(store);
      assert.equal(restored.request.auth.credentialStates![slot].status, status, "autosave must preserve known unavailable states too");
      assert.deepEqual(await secure.read(state.ref), before);
    }
    assert.ok(!JSON.stringify(backend.snapshot).includes(resolution.value));
    assert.ok(!JSON.stringify(backend.snapshot).includes(headerResolution.value));
  }
});
