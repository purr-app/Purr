import assert from "node:assert/strict";
import { test } from "node:test";
import { integrationTraceUrl } from "../src/integrations/trace-url";
import { integrationDefinitionSchema } from "../src/domain/project";

test("provider browser links resolve variables, retain base paths and exclude prepared authentication", () => {
  const integration = integrationDefinitionSchema.parse({ kind: "integration", id: "traces", provider: "private.traces", name: "Traces", configVersion: 1, enabled: true, config: { endpoint: "{{origin}}/nested", auth: "request" }, credentials: {} });
  const provider = { id: "private.traces", label: "Traces", traceUrl: (config: Record<string, unknown>, id: string) => `${config.endpoint}/trace/${id}` };
  const id = "a".repeat(32);
  assert.equal(integrationTraceUrl(integration, provider, id, { origin: "https://example.com" }), `https://example.com/nested/trace/${id}`);
  assert.throws(() => integrationTraceUrl(integration, provider, "invalid", { origin: "https://example.com" }));
  for (const origin of ["file:///tmp", "javascript:alert(1)", "https://user:password@example.com"]) {
    assert.throws(() => integrationTraceUrl(integration, provider, id, { origin }));
  }
});
