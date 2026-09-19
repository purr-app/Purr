import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dryRun = process.argv.includes("--dry-run");
const unexpectedArguments = process.argv.slice(2).filter((argument) => argument !== "--dry-run");
if (unexpectedArguments.length > 0) {
  throw new Error("Usage: node scripts/create-github-release.mjs [--dry-run]");
}
if (!dryRun && process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("GitHub Releases may only be created by the validated GitHub Actions workflow. Use --dry-run locally.");
}

const changesetFiles = readdirSync(".changeset")
  .filter((name) => name.endsWith(".md") && name !== "README.md");

if (changesetFiles.length > 0) {
  process.stdout.write(`Pending changesets remain (${changesetFiles.join(", ")}); no release will be created.\n`);
  process.exit(0);
}

if (!existsSync("CHANGELOG.md")) {
  process.stdout.write("CHANGELOG.md does not exist yet; the initial release is intentionally manual.\n");
  process.exit(0);
}

run("node", ["scripts/sync-release-version.mjs", "--check"]);

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const tag = `v${version}`;
const target = process.env.GITHUB_SHA || run("git", ["rev-parse", "HEAD"], { capture: true });
const remoteTag = run(
  "git",
  ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
  { allowFailure: true, capture: true },
);

if (remoteTag) {
  const tagLines = remoteTag.split("\n");
  const peeledLine = tagLines.find((line) => line.endsWith(`refs/tags/${tag}^{}`));
  const [remoteSha] = (peeledLine ?? tagLines[0]).split(/\s+/);
  if (remoteSha !== target) {
    throw new Error(`${tag} already points to ${remoteSha}; refusing to move it to ${target}.`);
  }

  if (run("gh", ["release", "view", tag], { allowFailure: true })) {
    process.stdout.write(`GitHub Release ${tag} already exists; nothing to do.\n`);
    process.exit(0);
  }
}

const notes = extractReleaseNotes(readFileSync("CHANGELOG.md", "utf8"), version);
const temporaryDirectory = mkdtempSync(join(tmpdir(), "purr-release-"));
const notesPath = join(temporaryDirectory, `${tag}.md`);

try {
  writeFileSync(notesPath, `${notes.trim()}\n`);
  const args = [
    "release",
    "create",
    tag,
    "--title",
    `Purr ${tag}`,
    "--notes-file",
    notesPath,
  ];
  if (remoteTag) args.push("--verify-tag");
  else args.push("--target", target);
  if (dryRun) {
    process.stdout.write(`Dry run: would create ${tag} at ${target} with notes from CHANGELOG.md.\n`);
  } else {
    run("gh", args);
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

if (!dryRun) {
  process.stdout.write(`Created immutable tag and GitHub Release ${tag} at ${target}.\n`);
}

function extractReleaseNotes(changelog, releaseVersion) {
  const escapedVersion = releaseVersion.replaceAll(".", "\\.");
  const match = changelog.match(new RegExp(`^## ${escapedVersion}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"));
  if (!match?.[1]?.trim()) {
    throw new Error(`CHANGELOG.md has no release notes for ${releaseVersion}.`);
  }
  return match[1];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: process.env,
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}.`);
  }
  return options.capture ? result.stdout.trim() : result.status === 0;
}
