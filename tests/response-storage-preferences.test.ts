import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspace, duplicateDocument, isRequestDocument } from "../src/features/workspaces/model/workspace";

test("duplicating an encrypted request keeps its local override in an Off workspace", () => {
  const workspace = createWorkspace();
  const original = workspace.documents[0]; assert.ok(isRequestDocument(original));
  original.responseStorage = "encrypted";
  const next = duplicateDocument(workspace, original.id);
  const copy = next.documents.find((document) => document.id !== original.id); assert.ok(copy && isRequestDocument(copy));
  assert.equal(next.responseStorage, "plaintext"); assert.equal(copy.responseStorage, "encrypted");
});
