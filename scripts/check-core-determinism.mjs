import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist-core");

function build() {
  execFileSync("npm", ["run", "build:core"], { cwd: root, stdio: "inherit" });
}

function snapshot() {
  return readdirSync(output, { recursive: true })
    .filter((path) => statSync(resolve(output, path)).isFile())
    .map((path) => {
      const content = readFileSync(resolve(output, path));
      return `${path}:${createHash("sha256").update(content).digest("hex")}`;
    })
    .sort();
}

build();
const first = snapshot();
build();
const second = snapshot();
if (JSON.stringify(first) !== JSON.stringify(second)) {
  throw new Error("Core package artifact changed between identical consecutive builds.");
}
console.log(`Core package build is deterministic across ${second.length} emitted files.`);
