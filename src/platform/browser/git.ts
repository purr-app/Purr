import { GitError, type GitPort } from "../../application/ports/git";
const unavailable = () => Promise.reject(new GitError("unavailable", "Git integration requires the Purr desktop app."));
export const unavailableGit: GitPort = { status: unavailable, execute: unavailable, diff: unavailable, history: unavailable, commitFiles: unavailable, stashes: unavailable, conflicts: unavailable, clone: unavailable };
