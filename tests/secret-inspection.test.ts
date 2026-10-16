import assert from "node:assert/strict";
import test from "node:test";
import { MemorySecureStore, SecretPreparationStore } from "../src/storage/secrets";

test("value-free inspection distinguishes missing, saved empty, and staged changes", async () => {
  const store = new MemorySecureStore();
  const empty = "purr/workspace/credentials/variables/empty";
  const absent = "purr/workspace/credentials/variables/absent";
  await store.set(empty, "");
  assert.deepEqual(await store.inspect([empty, absent]), [
    { ref: empty, status: "available", revision: 1, empty: true },
    { ref: absent, status: "missing", revision: 0 },
  ]);
  const prepared = new SecretPreparationStore(store);
  await prepared.set(absent, "pending");
  await prepared.delete(empty);
  assert.deepEqual(await prepared.inspect([empty, absent]), [
    { ref: empty, status: "missing", revision: 1 },
    { ref: absent, status: "available", revision: 0, empty: false },
  ]);
  assert.deepEqual(await store.inspect([empty, absent]), [
    { ref: empty, status: "available", revision: 1, empty: true },
    { ref: absent, status: "missing", revision: 0 },
  ]);
});
