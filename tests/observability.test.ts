import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tracePageSchema } from "../src/domain/observability";
import { deserializeResource, serializeResource } from "../src/storage/yaml";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/observability/trace-page.json", import.meta.url), "utf8"));
test("native trace fixture decodes through the bounded provider-neutral IPC schema", () => {
  assert.deepEqual(tracePageSchema.parse(fixture), fixture);
  assert.equal(tracePageSchema.safeParse({ ...fixture, apiKey: "synthetic-forbidden" }).success, false);
  assert.equal(tracePageSchema.safeParse({ ...fixture, spans: Array(26).fill(fixture.spans[0]) }).success, false);
  assert.equal(tracePageSchema.safeParse({ ...fixture, protocolVersion: 2 }).success, false);
  assert.equal(tracePageSchema.safeParse({ ...fixture, spans: [{ ...fixture.spans[0], vendorPayload: {} }] }).success, false);
});

test("observability domain and UI cannot implement native providers or access credentials", () => {
  const domain = readFileSync(new URL("../src-tauri/src/observability/domain.rs", import.meta.url), "utf8");
  assert.doesNotMatch(domain, /(?:use|crate::).*(?:tauri|reqwest|persistence|security|providers)/);
  const ui = readFileSync(new URL("../src/features/observability/trace-panel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(ui, /httpTransport|secureStore|credentialResolver|fetch\(|traceparent|x-b3|reqwest|@tauri-apps/);
});

test("synthetic integration generator produces canonical refs and never embeds tokens in YAML", () => {
  const root = mkdtempSync(join(tmpdir(), "purr-observability-"));
  const output = join(root, "fixtures");
  try {
    execFileSync(process.execPath, ["scripts/performance/create-observability-fixtures.mjs", "synthetic-workspace", output]);
    for (const name of ["alpha", "beta"]) {
      const yaml = readFileSync(join(output, `trace-${name}.yaml`), "utf8");
      const resource = deserializeResource(yaml);
      assert.equal(resource.kind, "integration");
      if (resource.kind !== "integration") throw new Error("Wrong fixture kind");
      assert.equal(resource.credentials.apiToken.kind, "secret");
      assert.deepEqual(deserializeResource(serializeResource(resource)), resource);
      assert.doesNotMatch(yaml, /purr-synthetic-token/);
      assert.match(yaml, new RegExp(`purr/synthetic-workspace/integrations/trace-${name}/apiToken`));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
