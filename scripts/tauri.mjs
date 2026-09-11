import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const isMacDev = process.platform === "darwin" && args[0] === "dev";
const hasRunner = args.some((argument) => argument === "--runner" || argument === "-r");

if (isMacDev && !hasRunner) {
  const runner = fileURLToPath(new URL("./tauri-dev-runner.sh", import.meta.url));
  args.splice(1, 0, "--runner", runner);
}

const cli = fileURLToPath(new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url));
const result = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" });

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
