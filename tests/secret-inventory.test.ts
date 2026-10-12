import assert from "node:assert/strict";
import test from "node:test";
import { buildSecretInventory, resolveSecretInventory } from "../src/application/secret-inventory";
import { createWorkspace, isRequestDocument, type Variable } from "../src/features/workspaces/model/workspace";
import { MemorySecureStore } from "../src/storage/secrets";
import { deserializeManifest, deserializeResource } from "../src/storage/yaml";
import { createRequestAuth } from "../src/features/request-workbench/model/request-auth";

function fixture() {
  const workspace = createWorkspace("Inventory", "inventory");
  const document = workspace.documents[0]; assert.ok(isRequestDocument(document));
  document.name = "Request"; document.request.url = "https://example.test/{{alias}}";
  const ref = "purr/inventory/credentials/variables/token";
  workspace.variables = [{ id: "alias", name: "alias", enabled: true, sensitive: false, kind: "static", value: "{{token}}" },
    { id: "token", name: "token", enabled: true, sensitive: true, kind: "static", value: "", secretRef: ref }];
  return { workspace, document, ref };
}

test("inventory discovers transitive global dependencies while returning no secret values", async () => {
  const { workspace, document, ref } = fixture();
  const secure = new MemorySecureStore();
  const globalRef = "purr/global/credentials/variables/global-token";
  await secure.set(ref, "synthetic-prefix-{{globalToken}}");
  await secure.set(globalRef, "MUST_NOT_APPEAR_IN_INVENTORY");
  const globals: Variable[] = [{ id: "global-token", name: "globalToken", kind: "static", enabled: true, sensitive: true, value: "", secretRef: globalRef },
    { id: "unrelated", name: "unrelated", kind: "static", enabled: true, sensitive: true, value: "", secretRef: "purr/global/credentials/unrelated" }];
  const read: string[] = []; const resolve = secure.resolve.bind(secure);
  secure.resolve = async (reference) => { read.push(reference); return resolve(reference); };
  const inventory = await resolveSecretInventory({ workspace, globalVariables: globals }, secure);
  assert.deepEqual(inventory.items.filter((item) => item.ref).map((item) => item.ref).sort(), [globalRef, ref].sort());
  assert.ok(inventory.items.find((item) => item.ref === globalRef)?.usages.some((usage) => usage.ownerId === document.id));
  assert.ok(inventory.items.every((item) => item.status.status === "available"));
  assert.equal(read.includes("purr/global/credentials/unrelated"), false);
  assert.doesNotMatch(JSON.stringify(inventory), /MUST_NOT_APPEAR|synthetic-prefix/);
});

test("inventory retains missing versus intentionally empty without enumerating historical secrets", async () => {
  const { workspace, document, ref } = fixture();
  const secure = new MemorySecureStore();
  document.request.auth.type = "basic";
  document.request.auth.secretRefs = { password: "purr/inventory/credentials/requests/password" };
  workspace.documents.push({ ...document, id: "history", historical: { entryId: "history", documentId: document.id, startedAt: 1, error: "" },
    request: { ...document.request, auth: { ...document.request.auth, secretRefs: { password: "purr/inventory/runtime/history/private" } } } });
  await secure.set(ref, "");
  const inventory = await resolveSecretInventory({ workspace, globalVariables: [] }, secure);
  assert.equal(inventory.items.find((item) => item.ref === ref)?.status.status, "available");
  assert.equal(inventory.items.find((item) => item.ref === "purr/inventory/credentials/requests/password")?.status.status, "missing");
  assert.equal(inventory.items.some((item) => item.ref?.includes("history")), false);
  assert.ok(inventory.items.every((item) => !("value" in item.status)));
});

test("environment-specific dependencies use enabled environment overrides and preserve owner context", () => {
  const { workspace, document } = fixture();
  workspace.environments = [{ id: "development", name: "Development", variables: [
    { id: "env-token", name: "token", kind: "static", enabled: true, sensitive: true, value: "", secretRef: "purr/inventory/credentials/env/token" },
  ] }];
  document.request.environmentId = "development";
  const inventory = buildSecretInventory({ workspace, globalVariables: [] });
  const env = inventory.items.find((item) => item.ref === "purr/inventory/credentials/env/token");
  assert.ok(env?.usages.some((usage) => usage.ownerId === document.id && usage.environmentId === "development"));
  assert.ok(env?.usages.some((usage) => usage.ownerLabel.includes("Development")));
});

test("legacy public literal count and declaration inventory avoid scanning opaque provider config", () => {
  const { workspace } = fixture();
  const project = { workspace: deserializeManifest("purr: 1\nworkspace:\n  id: inventory\n  name: Inventory\n"), resources: [
    deserializeResource("purr: 1\nkind: http\nid: saved\nname: Saved\nmethod: GET\nurl: https://example.test\nauth:\n  type: bearer\n  token:\n    kind: plain\n    value: synthetic-legacy-literal\n"),
    deserializeResource("purr: 1\nkind: extension\nid: private\nname: Private\nextensionType: vendor.private\nconfigVersion: 1\nconfig:\n  credential:\n    kind: secret\n    ref: purr/inventory/credentials/not-owned\n"),
  ] };
  const inventory = buildSecretInventory({ workspace, project, globalVariables: [] });
  assert.equal(inventory.legacyLiteralCount, 1);
  assert.equal(inventory.publicValueCount, 1);
  assert.equal(inventory.items.some((item) => item.ref === "purr/inventory/credentials/not-owned"), false);
  assert.doesNotMatch(JSON.stringify(inventory), /synthetic-legacy-literal/);
});

test("cycles terminate and unavailable status codes never become literal values", async () => {
  const { workspace, ref } = fixture();
  const secure = new MemorySecureStore(); await secure.set(ref, "{{token}}");
  workspace.variables.push({ id: "external", name: "external", enabled: false, sensitive: true, kind: "external-secret", provider: "future", key: "key" });
  const result = await resolveSecretInventory({ workspace, globalVariables: [] }, secure);
  assert.ok(result.items.length < 10);
  secure.resolve = async () => ({ status: "locked", code: "credential-locked", retryable: true });
  const locked = await resolveSecretInventory({ workspace, globalVariables: [] }, secure);
  assert.deepEqual(locked.items.find((item) => item.ref === ref)?.status, { status: "locked", code: "credential-locked", retryable: true });
});

test("inherited credential templates use the request environment without performing requests", () => {
  const { workspace, document } = fixture();
  workspace.variables = [];
  workspace.environments = [{ id: "production", name: "Production", variables: [
    { id: "alias", name: "inherited", kind: "static", enabled: true, sensitive: false, value: "{{globalToken}}" },
  ] }];
  const auth = createRequestAuth(); auth.type = "bearer"; auth.bearer.token = "{{inherited}}";
  workspace.requestConfig.auth = [{ id: "profile", name: "Shared profile", scope: "all", enabled: true, value: auth }];
  document.request.url = "https://example.test";
  document.request.environmentId = "production";
  document.request.auth.type = "inherit";
  document.request.auth.inherit = { source: "workspace", profileId: "profile" };
  const globalVariables: Variable[] = [{ id: "global-token", name: "globalToken", kind: "static", sensitive: true, enabled: true, value: "", secretRef: "purr/global/credentials/variables/token" }];
  const inventory = buildSecretInventory({ workspace, globalVariables });
  assert.ok(inventory.items.find((item) => item.ref === "purr/global/credentials/variables/token")?.usages.some((usage) => usage.ownerId === document.id && usage.environmentId === "production"));
});
