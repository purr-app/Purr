import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const [workspaceId, destination] = process.argv.slice(2);
if (!workspaceId || !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId) || !destination) {
  throw new Error("Usage: node scripts/performance/create-observability-fixtures.mjs WORKSPACE_ID NEW_OUTPUT_DIRECTORY");
}
const output = resolve(destination);
await mkdir(output); // Refuse to overwrite any existing folder or project.
const credentialCommands = [];
for (const name of ["alpha", "beta"]) {
  const id = `trace-${name}`;
  const reference = `purr/${workspaceId}/integrations/${id}/apiToken`;
  await writeFile(join(output, `${id}.yaml`), [
    "purr: 1", "kind: integration", `id: ${id}`, `name: Synthetic ${name}`,
    `provider: test.trace-${name}`, "enabled: true", "configVersion: 1",
    "config:", `  delayMs: ${name === "beta" ? 1500 : 0}`, "credentials:",
    "  apiToken:", "    kind: secret", `    ref: ${reference}`, "",
  ].join("\n"), { flag: "wx" });
  credentialCommands.push(`await window.__TAURI_INTERNALS__.invoke("secure_set", ${JSON.stringify({ reference, value: "purr-synthetic-token" })});`);
}
await writeFile(join(output, "credentials.dev-console.js"), `${credentialCommands.join("\n")}\n`, { flag: "wx" });
console.log(`Created synthetic integration YAML and DevTools credential setup in ${output}. Copy only the YAML files into the test workspace's integrations directory.`);
