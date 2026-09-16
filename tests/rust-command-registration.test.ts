import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const nativeRoot = join(root, "src-tauri", "src");

const registeredCommands = [
  "exit_app",
  "observability_integrations",
  "observability_trace",
  "cancel_observability",
  "save_response_body",
  "response_content_save",
  "response_content_inspect",
  "response_content_read_range",
  "response_content_read_lines",
  "response_content_search",
  "response_content_format",
  "response_content_query",
  "cancel_response_content_operation",
  "response_content_release",
  "request_file_create",
  "request_file_append",
  "request_file_finish",
  "request_file_release",
  "request_file_from_attachment",
  "start_http",
  "cancel_http",
  "import_collection",
  "authorize_oauth",
  "cancel_oauth",
  "load_persistence",
  "load_project",
  "read_local_attachment",
  "list_request_history",
  "reload_project_file",
  "commit_project",
  "set_local_active_workspace",
  "write_global_state",
  "delete_project",
  "finish_legacy_migration",
  "open_project_folder",
  "attach_project_directory",
  "secure_get",
  "secure_set",
  "secure_delete",
  "secure_exists",
];

function rustFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? rustFiles(path) : entry.name.endsWith(".rs") ? [path] : [];
  });
}

test("native command registration preserves the public IPC command list", () => {
  const source = readFileSync(join(nativeRoot, "composition.rs"), "utf8");
  const commandList = source.match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? "";
  const actual = [...commandList.matchAll(/::([a-z_]+)(?=,|\s*$)/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(actual, registeredCommands);
});

test("Tauri command adapters are isolated to commands and the OAuth callback boundary", () => {
  const violations = rustFiles(nativeRoot).flatMap((path) => {
    const source = readFileSync(path, "utf8");
    if (!source.includes("#[tauri::command]")) return [];
    const repositoryPath = relative(root, path);
    return repositoryPath.includes("src-tauri/src/commands/") || repositoryPath.endsWith("src-tauri/src/oauth.rs")
      ? []
      : [repositoryPath];
  });
  assert.deepEqual(violations, []);
});
