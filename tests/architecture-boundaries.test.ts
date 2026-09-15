import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { test } from "node:test";

const repositoryRoot = process.cwd();

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  });
}

test("domain, application and feature modules do not import Tauri APIs", () => {
  const files = ["domain", "application", "features"].flatMap((directory) =>
    sourceFiles(join(repositoryRoot, "src", directory)),
  );
  const violations = files.flatMap((path) => {
    const source = readFileSync(path, "utf8");
    return source.includes("@tauri-apps/")
      ? [relative(repositoryRoot, path)]
      : [];
  });
  assert.deepEqual(violations, []);
});

test("Tauri invoke calls remain inside the Tauri platform boundary", () => {
  const files = sourceFiles(join(repositoryRoot, "src"));
  const violations = files.flatMap((path) => {
    const source = readFileSync(path, "utf8");
    if (!/\binvoke(?:<[^>]+>)?\s*\(/.test(source)) return [];
    return path.includes(`${join("src", "platform", "tauri")}`)
      ? []
      : [relative(repositoryRoot, path)];
  });
  assert.deepEqual(violations, []);
});
