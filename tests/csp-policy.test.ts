import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const config = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const application = config("src-tauri/tauri.conf.json");
const consumer = config("tests/fixtures/core-consumer/src-tauri/tauri.conf.json");
const directives = (value: string) => new Map(value.split(";").map((part) => {
  const [name, ...sources] = part.trim().split(/\s+/);
  return [name, sources] as const;
}));

test("production CSP restricts scripts, network, documents and workers; consumer preserves the boundary", () => {
  const policy = directives(application.app.security.csp);
  assert.deepEqual(policy.get("default-src"), ["'none'"]);
  assert.deepEqual(policy.get("script-src"), ["'self'"]);
  assert.deepEqual(policy.get("connect-src"), ["ipc:", "http://ipc.localhost"]);
  assert.deepEqual(policy.get("worker-src"), ["'self'", "blob:"]);
  for (const name of ["object-src", "base-uri", "form-action"]) assert.deepEqual(policy.get(name), ["'none'"]);
  assert.deepEqual(policy.get("frame-src"), ["'self'"]);
  assert.ok(!application.app.security.csp.includes("unsafe-eval"));
  assert.ok(!application.app.security.csp.includes("localhost:142"));
  assert.deepEqual(consumer.app.security, application.app.security);
  const dev = directives(application.app.security.devCsp);
  assert.ok(dev.get("connect-src")!.includes("ws://localhost:1420"));
  assert.ok(!application.app.security.devCsp.includes("unsafe-eval"));
});

test("every registered core command has local main-webview ACL in both shells", () => {
  const composition = readFileSync("src-tauri/src/composition.rs", "utf8");
  const commands = [...composition.match(/generate_handler!\[([\s\S]*?)\]/)![1].matchAll(/::([a-z_]+)(?=,|\s*$)/gm)].map((match) => match[1]);
  for (const base of ["src-tauri", "tests/fixtures/core-consumer/src-tauri"]) {
    const permission = readFileSync(`${base}/permissions/purr-core.toml`, "utf8");
    const allowed = JSON.parse(permission.match(/commands.allow = (\[[\s\S]*?\])/)![1]);
    assert.deepEqual(allowed, commands);
    const capability = config(`${base}/capabilities/default.json`);
    assert.deepEqual(capability.windows, []);
    assert.deepEqual(capability.webviews, ["main"]);
    assert.equal(capability.local, true);
    assert.equal(capability.remote, undefined);
    assert.ok(capability.permissions.includes("purr-core"));
  }
  assert.match(composition, /invoke_handler\(crate::security::caller::guard\(/);
});
