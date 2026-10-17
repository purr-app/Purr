import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { projectJsonSchema } from "../scripts/generate-project-schema";

test("native Git canonical schema matches the domain (regenerate with npx tsx scripts/generate-project-schema.ts --write)", async () => {
  assert.equal(await readFile(new URL("../src-tauri/schemas/project.json", import.meta.url), "utf8"), projectJsonSchema());
});
