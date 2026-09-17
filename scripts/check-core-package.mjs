import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const fail = (message) => { throw new Error(`Core package check failed: ${message}`); };

if (JSON.stringify(packageJson.files) !== JSON.stringify(["dist-core"])) {
  fail("published files must be limited to the compiled dist-core artifact");
}

for (const dependency of ["react", "react-dom"]) {
  if (!packageJson.peerDependencies?.[dependency]) fail(`${dependency} must be a peer dependency`);
  if (packageJson.dependencies?.[dependency]) fail(`${dependency} must not be a runtime dependency`);
}

const supportedExports = new Set(["./app", "./extension-api", "./ui", "./test-kit", "./styles"]);
for (const [name, target] of Object.entries(packageJson.exports ?? {})) {
  if (!supportedExports.has(name)) fail(`unexpected public export ${name}`);
  const paths = typeof target === "string" ? [target] : Object.values(target);
  for (const path of paths) {
    if (!path.startsWith("./dist-core/") || !existsSync(resolve(root, path))) {
      fail(`${name} points to missing or non-artifact path ${path}`);
    }
  }
}
for (const name of supportedExports) {
  if (!packageJson.exports?.[name]) fail(`missing public export ${name}`);
}

const coreJavaScript = readdirSync(resolve(root, "dist-core"), { recursive: true })
  .filter((path) => path.endsWith(".js") && statSync(resolve(root, "dist-core", path)).isFile())
  .map((path) => readFileSync(resolve(root, "dist-core", path), "utf8"))
  .join("\n");
if (!/from\s+["']react(?:\/jsx-runtime)?["']/.test(coreJavaScript)) {
  fail("built core does not retain React as an external import");
}
if (/react\.production\.min|__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED/.test(coreJavaScript)) {
  fail("built core appears to contain a bundled React runtime");
}

const npmTree = JSON.parse(execFileSync("npm", ["ls", "react", "react-dom", "--all", "--json"], {
  cwd: root,
  encoding: "utf8",
}));
const versions = new Map([["react", new Set()], ["react-dom", new Set()]]);
function collect(node) {
  for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
    if (versions.has(name) && dependency.version) versions.get(name).add(dependency.version);
    collect(dependency);
  }
}
collect(npmTree);
for (const [name, found] of versions) {
  if (found.size !== 1) fail(`${name} must resolve to one version, found ${[...found].join(", ") || "none"}`);
}

const consumerRoot = resolve(root, "tests/fixtures/core-consumer");
const consumerSources = readdirSync(resolve(consumerRoot, "src"))
  .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
  .map((name) => readFileSync(resolve(consumerRoot, "src", name), "utf8"))
  .join("\n");
const publicImports = [...consumerSources.matchAll(/from\s+["'](@purr\/core[^"']*)["']|import\s+["'](@purr\/core[^"']*)["']/g)]
  .map((match) => match[1] ?? match[2]);
for (const specifier of publicImports) {
  if (!["@purr/core/app", "@purr/core/extension-api", "@purr/core/ui", "@purr/core/styles"].includes(specifier)) {
    fail(`consumer imports unsupported frontend path ${specifier}`);
  }
}
if (publicImports.length < 4) fail("consumer fixture does not exercise all required frontend surfaces");

const nativeSource = readFileSync(resolve(consumerRoot, "src-tauri/src/main.rs"), "utf8");
if (/purr_core::(?:observability|persistence|security|commands|http|content)/.test(nativeSource)) {
  fail("consumer native fixture imports an internal Rust module");
}
if (!nativeSource.includes("purr_core::native_extension_api") || !nativeSource.includes("purr_core::core_builder()")) {
  fail("consumer native fixture does not use the supported Rust composition surface");
}
const nativeApi = readFileSync(resolve(root, "src-tauri/src/native_extension_api.rs"), "utf8");
const publicUses = [...nativeApi.matchAll(/pub use ([^;]+);/gs)].map((match) => match[1]).join("\n");
if (/(?:commands|persistence|security|content|http|SecureStore|rusqlite)/.test(publicUses)) {
  fail("native extension API re-exports a privileged core implementation");
}

console.log("Core package exports, React singleton, and external consumer boundaries are valid.");
