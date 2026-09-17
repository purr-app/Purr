import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveResponseStoragePolicy } from "../src/application/response-storage-policy";

describe("response storage policy", () => {
  it("defaults to encrypted and resolves workspace, folder, then document precedence", () => {
    assert.deepEqual(resolveResponseStoragePolicy({}), { protection: "encrypted" });
    assert.deepEqual(resolveResponseStoragePolicy({ workspace: "plaintext" }), { protection: "plaintext" });
    assert.deepEqual(resolveResponseStoragePolicy({
      workspace: "plaintext",
      folders: ["inherit", "encrypted", "plaintext"],
      document: "encrypted",
    }), { protection: "encrypted" });
  });

  it("uses the nearest explicit ancestor when a document inherits", () => {
    assert.deepEqual(resolveResponseStoragePolicy({
      workspace: "encrypted",
      folders: ["plaintext", "inherit"],
      document: "inherit",
    }), { protection: "plaintext" });
  });
});
