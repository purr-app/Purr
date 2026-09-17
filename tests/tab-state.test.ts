import assert from "node:assert/strict";
import test from "node:test";
import { TabStateStore } from "../src/shared/state/tab-state";

test("tab UI state survives switching, is isolated, and expires on close", () => {
  const store = new TabStateStore();
  assert.equal(store.remember, true);
  store.scope("workspace:one").set("response.tab", "trace");
  store.scope("workspace:two").set("response.tab", "headers");
  store.retain(new Set(["workspace:one", "workspace:two"]));
  assert.equal(store.scope("workspace:one").get("response.tab"), "trace");
  store.retain(new Set(["workspace:two"]));
  assert.equal(store.scope("workspace:one").size, 0);
  assert.equal(store.scope("workspace:two").get("response.tab"), "headers");
  store.clear();
  assert.equal(store.scope("workspace:two").size, 0);
});
