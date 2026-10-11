import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/create-github-release.mjs", import.meta.url));
const asset = "Purr-OSS-0.2.2-macOS-arm64.zip";

function releaseFixture(options: { tag?: string; existing?: boolean; assets?: string[]; pending?: boolean; missingAsset?: boolean; dryRun?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "purr-release-test-"));
  try {
    mkdirSync(join(root, ".changeset"));
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.2.2" }));
    writeFileSync(join(root, "CHANGELOG.md"), "## 0.2.2\n\nFix workspace editing.\n");
    if (options.pending) writeFileSync(join(root, ".changeset", "pending.md"), "Pending change");
    if (!options.missingAsset) writeFileSync(join(root, asset), "fixture archive");
    writeFileSync(join(root, "calls.jsonl"), "");
    const shim = `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync("calls.jsonl", JSON.stringify({ command, args }) + "\\n");
if (command === "git") process.stdout.write(process.env.TEST_TAG || "");
if (command === "gh" && args[1] === "view") {
  if (process.env.TEST_EXISTING !== "true") process.exit(1);
  if (args.includes("--json")) process.stdout.write(process.env.TEST_ASSETS);
}
`;
    // Command shims run under real Node; only the version-sync subprocess is stubbed.
    for (const command of ["git", "gh"]) {
      writeFileSync(join(root, "bin", command), shim);
      chmodSync(join(root, "bin", command), 0o755);
    }
    writeFileSync(join(root, "bin", "package.json"), '{"type":"module"}');
    writeFileSync(join(root, "bin", "node"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(root, "bin", "node"), 0o755);
    const result = spawnSync(process.execPath, [script, "--asset", asset, ...(options.dryRun ? ["--dry-run"] : [])], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, GITHUB_ACTIONS: "true", GITHUB_SHA: "validated-sha", TEST_TAG: options.tag ? `${options.tag}\trefs/tags/v0.2.2` : "", TEST_EXISTING: String(Boolean(options.existing)), TEST_ASSETS: JSON.stringify(options.assets ?? []) },
    });
    const calls = readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { command: string; args: string[] });
    return { result, mutations: calls.filter(call => call.command === "gh" && ["create", "upload"].includes(call.args[1])) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("new releases include the validated application archive", () => {
  const { result, mutations } = releaseFixture();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].args[1], "create");
  assert.ok(mutations[0].args.includes(asset));
  assert.deepEqual(mutations[0].args.slice(-2), ["--target", "validated-sha"]);
});

test("rerunning a tagged release uploads a missing archive without replacing assets", () => {
  const { result, mutations } = releaseFixture({ tag: "validated-sha", existing: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(mutations[0].args, ["release", "upload", "v0.2.2", asset]);
  assert.equal(mutations.length, 1);
  assert.equal(releaseFixture({ tag: "validated-sha", existing: true, assets: [asset] }).mutations.length, 0);
});

test("assets cannot be uploaded to a tag from a different commit", () => {
  const { result, mutations } = releaseFixture({ tag: "other-sha", existing: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to move/);
  assert.equal(mutations.length, 0);
});

test("missing artifacts stop release creation", () => {
  const { result, mutations } = releaseFixture({ missingAsset: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /nonempty ZIP/);
  assert.equal(mutations.length, 0);
});

test("pending changesets and dry runs never publish artifacts", () => {
  for (const options of [{ pending: true }, { dryRun: true }, { dryRun: true, tag: "validated-sha", existing: true }]) {
    const { result, mutations } = releaseFixture(options);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(mutations.length, 0);
  }
});
