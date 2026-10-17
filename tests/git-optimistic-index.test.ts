import { test } from "node:test";
import assert from "node:assert/strict";
import { optimisticIndex } from "../src/features/git/optimistic-index";
import type { GitStatus } from "../src/application/ports/git";
const status = (index: string, worktree: string): GitStatus => ({ directory: "/project", initialized: true, version: "git", branch: "main", head: "commit", upstream: null, ahead: 0, behind: 0, branches: [], remotes: [], operation: null, lastFetched: null, files: [{ path: "request.yaml", index, worktree, conflicted: false }, { path: "other.yaml", index: ".", worktree: "M", conflicted: false }] });
test("queued stage/unstage previews preserve unrelated and later working changes", () => {
  const original = status(".", "M");
  const staged = optimisticIndex(original, { type: "stage", paths: ["request.yaml"] });
  assert.deepEqual(staged.files.map(({ index, worktree }) => [index, worktree]), [["M", "."], [".", "M"]]);
  assert.deepEqual(optimisticIndex(staged, { type: "unstage", paths: ["request.yaml"] }), original);
  assert.equal(optimisticIndex(status("M", "D"), { type: "unstage", paths: ["request.yaml"] }).files[0].worktree, "D");
});
test("new files remain untracked after unstaging", () => {
  const staged = optimisticIndex(status("?", "?"), { type: "stage", paths: ["request.yaml"] });
  assert.equal(staged.files[0].index, "A");
  assert.equal(optimisticIndex(staged, { type: "unstage", paths: ["request.yaml"] }).files[0].index, "?");
});
