import assert from "node:assert/strict";
import test from "node:test";
import type { ApplicationServices } from "../src/app/composition/application-services";
import { MemorySecureStore } from "../src/storage/secrets";
import { integrationDefinitionSchema } from "../src/domain/project";
import { createRequestAuth } from "../src/features/request-workbench/model/request-auth";
import { prepareIntegrationConnection } from "../src/integrations/prepare-connection";

test("integration connection reuses request auth and resolves variables without mutating canonical config", async () => {
  const secureStore = new MemorySecureStore();
  const auth = createRequestAuth(); auth.type = "basic";
  auth.basic = { username: "{{user}}", password: "{{password}}" };
  await secureStore.set("purr/workspace/integrations/provider/auth", JSON.stringify(auth));
  const integration = integrationDefinitionSchema.parse({ kind: "integration", id: "provider", name: "Private", provider: "private.traces", configVersion: 1,
    config: { endpoint: "{{endpoint}}/base", auth: "request" }, credentials: { auth: { kind: "secret", ref: "purr/workspace/integrations/provider/auth" } } });
  const connection = await prepareIntegrationConnection(integration, "workspace", { variables: { endpoint: "https://example.test", user: "alice", password: "secret" } }, { secureStore } as ApplicationServices, new AbortController().signal);
  assert.equal(connection?.endpoint, "https://example.test/base");
  assert.deepEqual(connection?.headers, [["Authorization", `Basic ${Buffer.from("alice:secret").toString("base64")}`]]);
  assert.equal(integration.config.endpoint, "{{endpoint}}/base");
  assert.doesNotMatch(JSON.stringify(integration), /alice|Basic|password/);
  auth.type = "api-key"; auth.apiKey = { name: "key", value: "{{password}}", placement: "query" };
  await secureStore.set("purr/workspace/integrations/provider/auth", JSON.stringify(auth));
  const query = await prepareIntegrationConnection(integration, "workspace", { variables: { endpoint: "https://example.test", password: "secret" } }, { secureStore } as ApplicationServices, new AbortController().signal);
  assert.equal(query?.endpoint, "https://example.test/base?key=secret");
  assert.deepEqual(query?.headers, []);
});
