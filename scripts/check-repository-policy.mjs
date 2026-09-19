import { existsSync, readFileSync } from "node:fs";

const failures = [];
const forbiddenPackageManagerArtifacts = ["yarn.lock", ".yarnrc", ".yarnrc.yml", ".yarn"];

for (const path of forbiddenPackageManagerArtifacts) {
  if (existsSync(path)) failures.push(`Remove unsupported Yarn artifact: ${path}`);
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));

if (packageJson.name !== "@purr/core") {
  failures.push("package.json must reserve the @purr/core package identity.");
}
if (!String(packageJson.packageManager ?? "").startsWith("npm@")) {
  failures.push("package.json must pin npm through packageManager.");
}
if (packageLock.name !== packageJson.name || packageLock.version !== packageJson.version
  || packageLock.packages?.[""]?.name !== packageJson.name
  || packageLock.packages?.[""]?.version !== packageJson.version) {
  failures.push("package-lock.json root metadata must match package.json.");
}
if (Object.hasOwn(tauriConfig.bundle?.macOS ?? {}, "signingIdentity")) {
  failures.push("Public Tauri configuration must not contain bundle.macOS.signingIdentity.");
}

for (const entry of Object.values(packageLock.packages ?? {})) {
  if (!entry?.resolved) continue;
  const resolved = new URL(entry.resolved);
  if (resolved.username || resolved.password) failures.push(`Credential-bearing package URL: ${resolved.origin}`);
  if (resolved.hostname !== "registry.npmjs.org") failures.push(`Non-public npm package source: ${resolved.origin}`);
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("Repository package, lockfile, signing, and registry policy passed.\n");
