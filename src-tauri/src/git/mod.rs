//! System Git boundary. Arguments are never interpreted by a shell.
pub mod native;
mod reads;
mod recovery;
#[cfg(test)]
mod tests;
mod validation;
mod writes;

use crate::persistence::project_files::{revision, FilesystemWorkspaceStore, ProjectFile};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};
use tokio_util::sync::CancellationToken;

pub type Result<T> = std::result::Result<T, GitError>;
#[derive(Debug, Serialize, Clone)]
pub struct GitError {
    pub code: String,
    pub message: String,
}
impl GitError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl From<String> for GitError {
    fn from(message: String) -> Self {
        Self::new("git", message)
    }
}
impl From<std::io::Error> for GitError {
    fn from(_: std::io::Error) -> Self {
        Self::new("git", "Cannot access a Git project file.")
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub index: String,
    pub worktree: String,
    pub conflicted: bool,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub directory: String,
    pub initialized: bool,
    pub version: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileStatus>,
    pub branches: Vec<Branch>,
    pub remotes: Vec<Remote>,
    pub operation: Option<String>,
    pub last_fetched: Option<u64>,
    pub recovery: bool,
}
#[derive(Serialize, Debug)]
pub struct Branch {
    pub name: String,
    pub remote: bool,
    pub current: bool,
    pub upstream: Option<String>,
}
#[derive(Serialize, Debug)]
pub struct Remote {
    pub name: String,
    pub url: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRequest {
    pub path: String,
    pub old_path: Option<String>,
    pub scope: String,
    pub commit: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    pub path: String,
    pub before: String,
    pub after: String,
    pub before_exists: bool,
    pub after_exists: bool,
    pub before_bytes: usize,
    pub after_bytes: usize,
    pub binary: bool,
    pub truncated: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub id: String,
    pub short_id: String,
    pub message: String,
    pub author: String,
    pub timestamp: u64,
}
#[derive(Serialize)]
pub struct Stash {
    pub id: String,
    pub message: String,
}
#[derive(Serialize)]
pub struct Conflict {
    pub path: String,
    pub base: Option<String>,
    pub local: Option<String>,
    pub incoming: Option<String>,
    pub binary: bool,
    pub revision: String,
}
#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    Init,
    Stage {
        paths: Vec<String>,
    },
    Unstage {
        paths: Vec<String>,
    },
    Discard {
        paths: Vec<String>,
    },
    Commit {
        message: String,
        author: Option<Author>,
    },
    CreateBranch {
        name: String,
    },
    SwitchBranch {
        name: String,
        #[serde(default, rename = "allowDirty")]
        allow_dirty: bool,
    },
    SetRemote {
        name: String,
        url: String,
    },
    RemoveRemote {
        name: String,
    },
    Fetch {
        remote: Option<String>,
        branch: Option<String>,
    },
    Pull {
        remote: Option<String>,
        branch: Option<String>,
        #[serde(default, rename = "allowDirty")]
        allow_dirty: bool,
    },
    Push {
        remote: Option<String>,
        branch: Option<String>,
    },
    Stash {
        message: String,
    },
    ApplyStash {
        id: String,
    },
    DropStash {
        id: String,
    },
    ResolveConflict {
        path: String,
        content: Option<String>,
        side: Option<String>,
        revision: String,
    },
    FinishMerge {
        message: String,
    },
    AbortMerge,
}
#[derive(Deserialize, Debug)]
pub struct Author {
    pub name: String,
    pub email: String,
}

type JournalWriter =
    Box<dyn Fn(Option<serde_json::Value>) -> std::result::Result<(), String> + Send + Sync>;

pub struct Git {
    pub root: PathBuf,
    pub workspace: String,
    pub cancel: CancellationToken,
    pub journal: Option<JournalWriter>,
    pub checkpoint: Option<serde_json::Value>,
}
pub struct Output {
    pub success: bool,
    pub stdout: Vec<u8>,
    pub stderr: String,
}
impl Output {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).trim().to_string()
    }
}
impl Git {
    pub fn new(root: PathBuf, workspace: String) -> Self {
        Self {
            root,
            workspace,
            cancel: CancellationToken::new(),
            journal: None,
            checkpoint: None,
        }
    }
    pub async fn output(&self, args: &[&str]) -> Result<Output> {
        self.command(args).await
    }
    async fn command(&self, args: &[&str]) -> Result<Output> {
        if self.cancel.is_cancelled() {
            return Err(GitError::new("cancelled", "Git operation cancelled."));
        }
        let mut command = Command::new("git");
        #[cfg(unix)]
        command.process_group(0);
        command
            .current_dir(&self.root)
            .args(["--literal-pathspecs", "--no-pager", "-c", "color.ui=false"])
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_MERGE_AUTOEDIT", "no")
            .env("GIT_EDITOR", "true")
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // SSH must use the existing agent, never wait for a hidden terminal prompt.
        if std::env::var_os("GIT_SSH_COMMAND").is_none() {
            command.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
        }
        let mut child = command.spawn().map_err(|_| {
            GitError::new(
                "unavailable",
                "Git is unavailable. Install Git and restart Purr.",
            )
        })?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| GitError::new("git", "Cannot read Git output."))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| GitError::new("git", "Cannot read Git output."))?;
        let output = async {
            let mut bytes = Vec::new();
            let mut errors = Vec::new();
            let mut stdout = stdout.take(128 * 1024 * 1024 + 1);
            let mut stderr = stderr.take(256 * 1024);
            let (read, err, status) = tokio::join!(
                stdout.read_to_end(&mut bytes),
                stderr.read_to_end(&mut errors),
                child.wait()
            );
            read?;
            err?;
            let status = status?;
            if bytes.len() > 128 * 1024 * 1024 {
                return Err(GitError::new(
                    "git",
                    "Git output exceeds the project size limit.",
                ));
            }
            Ok(Output {
                success: status.success(),
                stdout: bytes,
                stderr: sanitize(&String::from_utf8_lossy(&errors)),
            })
        };
        let result = tokio::select! {
            result = output => return result,
            _ = self.cancel.cancelled() => GitError::new("cancelled", "Git operation cancelled. Refreshing repository state."),
            _ = tokio::time::sleep(Duration::from_secs(300)) => GitError::new("git", "Git operation timed out. Refresh before retrying."),
        };
        // Reap Git before releasing the lease or inspecting its index. On Unix,
        // terminate its credential/SSH/hook children as part of the same group.
        #[cfg(unix)]
        if let Some(id) = child.id() {
            unsafe {
                libc::killpg(id as i32, libc::SIGKILL);
            }
        }
        let _ = child.kill().await;
        Err(result)
    }
    pub async fn run(&self, args: &[&str]) -> Result<String> {
        let out = self.output(args).await?;
        if !out.success {
            return Err(classify(&out.stderr));
        }
        Ok(out.text())
    }
    pub fn path(&self, path: &str) -> Result<PathBuf> {
        if path.is_empty()
            || path.contains(['\0', '\\'])
            || !Path::new(path)
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
            || path.split('/').any(|part| {
                part.eq_ignore_ascii_case(".git") || part == "." || part == ".." || part.is_empty()
            })
        {
            return Err(GitError::new("git", "Invalid repository file path."));
        }
        let mut target = self.root.clone();
        for part in Path::new(path).components() {
            target.push(part);
            if std::fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err(GitError::new(
                    "unsupported",
                    "Symbolic links cannot be edited through Purr Git.",
                ));
            }
        }
        Ok(target)
    }
    pub async fn repository(&self) -> Result<()> {
        let top = self.run(&["rev-parse", "--show-toplevel"]).await?;
        let top = std::fs::canonicalize(top)?;
        if top != std::fs::canonicalize(&self.root)?
            || !self.root.join(".git").is_dir()
            || std::fs::symlink_metadata(self.root.join(".git"))
                .is_ok_and(|m| m.file_type().is_symlink())
        {
            return Err(GitError::new("unsupported", "Use a standalone repository with purr.yaml at its root. Nested projects and linked worktrees are not supported."));
        }
        if self
            .output(&["ls-files", "--stage", "-z"])
            .await?
            .stdout
            .split(|b| *b == 0)
            .any(|entry| entry.starts_with(b"160000 "))
        {
            return Err(GitError::new(
                "unsupported",
                "Repositories containing submodules are not supported by Purr Git.",
            ));
        }
        Ok(())
    }
    pub fn validate_files(&self, files: &BTreeMap<String, ProjectFile>) -> Result<()> {
        let text = &files
            .get("purr.yaml")
            .ok_or_else(|| {
                GitError::new(
                    "invalid-project",
                    "This repository is not a valid Purr workspace: purr.yaml is missing.",
                )
            })?
            .content;
        let manifest: serde_json::Value = serde_yaml::from_str(text)
            .map_err(|_| GitError::new("invalid-project", "The workspace manifest is invalid."))?;
        if manifest["workspace"]["id"].as_str() != Some(&self.workspace) {
            return Err(GitError::new(
                "identity",
                "This branch or remote belongs to a different workspace.",
            ));
        }
        crate::transfer::validate_project_files(files, &self.workspace)
            .and_then(|_| validation::project(files))
            .map_err(|_|GitError::new("invalid-project", "The saved project is invalid or uses an older format. Save/upgrade the workspace and include all required schema, folder and asset files."))
    }
    pub fn validate_worktree(&self) -> Result<()> {
        self.validate_files(
            &FilesystemWorkspaceStore {
                directory: self.root.clone(),
            }
            .load()
            .map_err(GitError::from)?,
        )
    }
    pub async fn files_at(&self, reference: &str) -> Result<BTreeMap<String, ProjectFile>> {
        let listing = self
            .output(&["ls-tree", "-rz", "--full-tree", reference])
            .await?;
        if !listing.success {
            return Err(classify(&listing.stderr));
        }
        let paths = parse_tree(&listing.stdout)?;
        let store = FilesystemWorkspaceStore {
            directory: self.root.clone(),
        };
        let mut files = BTreeMap::new();
        let mut total = 0usize;
        for (path, oid, mode) in paths {
            if mode == "160000" {
                return Err(GitError::new(
                    "unsupported",
                    "Branches containing submodules are not supported by Purr Git.",
                ));
            }
            if store.path(&path).is_err() {
                continue;
            }
            if mode != "100644" && mode != "100755" {
                return Err(GitError::new(
                    "invalid-project",
                    "Canonical resources cannot be symbolic links or submodules.",
                ));
            }
            let size = self
                .run(&["cat-file", "-s", &oid])
                .await?
                .parse::<usize>()
                .map_err(|_| GitError::new("git", "Invalid Git blob size."))?;
            if size > 64 * 1024 * 1024 || total + size > 64 * 1024 * 1024 {
                return Err(GitError::new(
                    "invalid-project",
                    "The canonical project exceeds 64 MiB.",
                ));
            }
            let out = self.output(&["cat-file", "blob", &oid]).await?;
            if !out.success {
                return Err(classify(&out.stderr));
            }
            total += out.stdout.len();
            if total > 64 * 1024 * 1024 {
                return Err(GitError::new(
                    "invalid-project",
                    "The canonical project exceeds 64 MiB.",
                ));
            }
            use base64::Engine;
            let content = if path.starts_with("assets/") {
                base64::engine::general_purpose::STANDARD.encode(&out.stdout)
            } else {
                String::from_utf8(out.stdout.clone()).map_err(|_| {
                    GitError::new("invalid-project", "Canonical text files must use UTF-8.")
                })?
            };
            files.insert(
                path,
                ProjectFile {
                    content,
                    revision: revision(&out.stdout),
                },
            );
        }
        Ok(files)
    }
}
fn parse_tree(bytes: &[u8]) -> Result<Vec<(String, String, String)>> {
    bytes
        .split(|b| *b == 0)
        .filter(|x| !x.is_empty())
        .map(|record| {
            let split = record
                .iter()
                .position(|b| *b == b'\t')
                .ok_or_else(|| GitError::new("git", "Invalid Git tree output."))?;
            let info = String::from_utf8_lossy(&record[..split]);
            let parts: Vec<_> = info.split(' ').collect();
            if parts.len() != 3 {
                return Err(GitError::new("git", "Invalid Git tree output."));
            }
            Ok((
                String::from_utf8(record[split + 1..].to_vec()).map_err(|_| {
                    GitError::new("unsupported", "Repository paths must use UTF-8.")
                })?,
                parts[2].into(),
                parts[0].into(),
            ))
        })
        .collect()
}
fn classify(message: &str) -> GitError {
    let lower = message.to_lowercase();
    let code = if lower.contains("index.lock") || lower.contains("another git process") {
        "busy"
    } else if lower.contains("authentication")
        || lower.contains("permission denied")
        || lower.contains("could not read username")
        || lower.contains("host key verification")
    {
        "authentication"
    } else if lower.contains("author identity") || lower.contains("unable to auto-detect email") {
        "author"
    } else if lower.contains("would be overwritten") || lower.contains("local changes") {
        "dirty"
    } else if lower.contains("non-fast-forward") || lower.contains("rejected") {
        "rejected"
    } else {
        "git"
    };
    GitError::new(
        code,
        if message.trim().is_empty() {
            "Git could not complete the operation.".into()
        } else {
            sanitize(message).chars().take(4000).collect::<String>()
        },
    )
}
pub fn sanitize(value: &str) -> String {
    // Existing remote config may contain URL credentials. Never echo them through IPC.
    let re = regex::Regex::new(r"(https?://)[^/@\s]+@").expect("constant regex");
    re.replace_all(value, "${1}[redacted]@").into_owned()
}
pub fn validate_url(url: &str) -> Result<()> {
    if url.is_empty() || url.starts_with('-') || url.contains(['\0', '\n', '\r']) {
        return Err(GitError::new(
            "git",
            "Enter a valid HTTPS or SSH repository URL.",
        ));
    }
    if url.starts_with("https://") || url.starts_with("ssh://") {
        let parsed =
            tauri::Url::parse(url).map_err(|_| GitError::new("git", "Invalid repository URL."))?;
        if parsed.host_str().is_none()
            || parsed.password().is_some()
            || (parsed.scheme() == "https" && !parsed.username().is_empty())
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(GitError::new("git", "Use a repository URL without embedded credentials, query or fragment. Configure access with your Git credential helper or SSH agent."));
        }
    } else if !(url.contains('@') && url.contains(':') && !url.contains(char::is_whitespace)) {
        return Err(GitError::new("git", "Use an HTTPS or SSH repository URL."));
    }
    Ok(())
}
