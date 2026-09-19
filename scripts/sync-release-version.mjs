import { readFileSync, writeFileSync } from "node:fs";

const mode = process.argv[2];
if (mode !== "--check" && mode !== "--write") {
  throw new Error("Usage: node scripts/sync-release-version.mjs --check|--write");
}

const packagePath = "package.json";
const packageLockPath = "package-lock.json";
const cargoManifestPath = "src-tauri/Cargo.toml";
const cargoLockPath = "src-tauri/Cargo.lock";
const tauriConfigPath = "src-tauri/tauri.conf.json";

const packageJson = readJson(packagePath);
const version = packageJson.version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`package.json version must be a stable N.N.N version, received ${JSON.stringify(version)}.`);
}

const packageLock = readJson(packageLockPath);
const tauriConfigSource = readFileSync(tauriConfigPath, "utf8");
const tauriConfig = JSON.parse(tauriConfigSource);
const cargoManifest = readFileSync(cargoManifestPath, "utf8");
const cargoLock = readFileSync(cargoLockPath, "utf8");

const cargoManifestVersion = readCargoPackageVersion(cargoManifest, cargoManifestPath);
const cargoLockVersion = readCargoLockPackageVersion(cargoLock);
const versions = [
  ["package-lock.json", packageLock.version],
  ["package-lock.json packages['']", packageLock.packages?.[""]?.version],
  ["src-tauri/Cargo.toml", cargoManifestVersion],
  ["src-tauri/Cargo.lock", cargoLockVersion],
  ["src-tauri/tauri.conf.json", tauriConfig.version],
];

if (mode === "--check") {
  const mismatches = versions.filter(([, candidate]) => candidate !== version);
  if (mismatches.length > 0) {
    const detail = mismatches
      .map(([source, candidate]) => `${source}: ${JSON.stringify(candidate)} (expected ${version})`)
      .join("\n");
    throw new Error(`Release versions are not synchronized:\n${detail}`);
  }

  process.stdout.write(`Release version ${version} is synchronized across npm, Cargo, and Tauri.\n`);
  process.exit(0);
}

packageLock.version = version;
if (!packageLock.packages?.[""]) {
  throw new Error("package-lock.json is missing the root packages[''] entry.");
}
packageLock.packages[""].version = version;
writeJson(packageLockPath, packageLock);
writeFileSync(tauriConfigPath, replaceTauriVersion(tauriConfigSource, version));
writeFileSync(
  cargoManifestPath,
  replaceCargoPackageVersion(cargoManifest, version, cargoManifestPath),
);
writeFileSync(cargoLockPath, replaceCargoLockPackageVersion(cargoLock, version));

process.stdout.write(`Synchronized npm, Cargo, and Tauri release versions at ${version}.\n`);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceTauriVersion(source, nextVersion) {
  const versionPattern = /^(\s*"version"\s*:\s*)"[^"]+"(,\s*)$/m;
  if (!versionPattern.test(source)) {
    throw new Error("src-tauri/tauri.conf.json is missing its top-level version.");
  }
  return source.replace(versionPattern, `$1"${nextVersion}"$2`);
}

function readCargoPackageVersion(source, path) {
  const packageSection = source.match(/^\[package\]\n(?<body>[\s\S]*?)(?=^\[)/m)?.groups?.body;
  const result = packageSection?.match(/^version\s*=\s*"(?<version>[^"]+)"\s*$/m)?.groups?.version;
  if (!result) throw new Error(`${path} is missing [package].version.`);
  return result;
}

function replaceCargoPackageVersion(source, nextVersion, path) {
  const currentVersion = readCargoPackageVersion(source, path);
  const packageSectionStart = source.indexOf("[package]");
  const versionStart = source.indexOf(`version = "${currentVersion}"`, packageSectionStart);
  if (versionStart < 0) throw new Error(`Could not update ${path}.`);
  return `${source.slice(0, versionStart)}version = "${nextVersion}"${source.slice(versionStart + `version = "${currentVersion}"`.length)}`;
}

function findCargoLockPackageBlock(source) {
  const starts = [...source.matchAll(/^\[\[package\]\]$/gm)].map((match) => match.index);
  const blocks = starts.map((start, index) => source.slice(start, starts[index + 1] ?? source.length));
  const matches = blocks.filter((block) => /^name = "purr"$/m.test(block));
  if (matches.length !== 1) {
    throw new Error(`src-tauri/Cargo.lock must contain exactly one purr package; found ${matches.length}.`);
  }
  return matches[0];
}

function readCargoLockPackageVersion(source) {
  const block = findCargoLockPackageBlock(source);
  const result = block.match(/^version = "(?<version>[^"]+)"$/m)?.groups?.version;
  if (!result) throw new Error("The purr Cargo.lock package is missing its version.");
  return result;
}

function replaceCargoLockPackageVersion(source, nextVersion) {
  const block = findCargoLockPackageBlock(source);
  const currentVersion = readCargoLockPackageVersion(source);
  const updatedBlock = block.replace(
    `version = "${currentVersion}"`,
    `version = "${nextVersion}"`,
  );
  return source.replace(block, updatedBlock);
}
