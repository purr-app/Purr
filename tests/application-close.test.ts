import { test } from "node:test";
import assert from "node:assert/strict";
import { saveBeforeApplicationExit } from "../src/application/application-close";

test("a failed final save does not block application exit", async () => {
  const calls: string[] = [];
  await saveBeforeApplicationExit(async () => {
    calls.push("save");
    throw new Error("Project file changed externally");
  }, async () => { calls.push("exit"); });
  assert.deepEqual(calls, ["save", "exit"]);
});

test("application exit waits for a successful final save", async () => {
  const calls: string[] = [];
  await saveBeforeApplicationExit(async () => { calls.push("save"); }, async () => { calls.push("exit"); });
  assert.deepEqual(calls, ["save", "exit"]);
});
