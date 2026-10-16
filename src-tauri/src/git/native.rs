//! Git mutations are serialized per workspace without holding the SQLite lock.
use super::*;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};
#[derive(Default)]
pub struct GitState(Arc<Mutex<HashMap<String, (String, bool, CancellationToken)>>>);
pub(crate) struct Lease {
    registry: Arc<Mutex<HashMap<String, (String, bool, CancellationToken)>>>,
    id: String,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.registry.lock() {
            registry.remove(&self.id);
        }
    }
}
impl GitState {
    pub(crate) fn acquire(
        &self,
        id: &str,
        workspace: &str,
        mutation: bool,
    ) -> Result<(Lease, CancellationToken)> {
        if id.is_empty() || id.len() > 128 {
            return Err(GitError::new("git", "Invalid operation ID."));
        }
        let mut registry = self
            .0
            .lock()
            .map_err(|_| GitError::new("busy", "Git is busy."))?;
        if registry.contains_key(id)
            || registry
                .values()
                .any(|(owner, mutating, _)| owner == workspace && *mutating)
        {
            return Err(GitError::new(
                "busy",
                "Another Git operation is running for this workspace.",
            ));
        }
        let token = CancellationToken::new();
        registry.insert(id.into(), (workspace.into(), mutation, token.clone()));
        Ok((
            Lease {
                registry: self.0.clone(),
                id: id.into(),
            },
            token,
        ))
    }
    pub fn busy(&self, workspace: &str) -> bool {
        self.0
            .lock()
            .map(|ops| {
                ops.values()
                    .any(|(owner, mutation, _)| owner == workspace && *mutation)
            })
            .unwrap_or(true)
    }
}
pub fn ensure_idle(app: &tauri::AppHandle, workspace: &str) -> std::result::Result<(), String> {
    if app
        .try_state::<GitState>()
        .is_some_and(|s| s.busy(workspace))
    {
        Err("Git is changing this workspace. Wait for it to finish before saving.".into())
    } else {
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Query {
    Status,
    Execute { action: Action },
    Diff { request: DiffRequest },
    History { skip: usize, path: Option<String> },
    CommitFiles { commit: String },
    Stashes,
    Conflicts,
}
pub async fn git_workspace(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    workspace_id: String,
    operation_id: String,
    query: Query,
    on_event: Option<tauri::ipc::JavaScriptChannelId>,
) -> Result<Value> {
    let state = app.state::<GitState>();
    let mutation = matches!(query, Query::Execute { .. });
    let (lease, cancel) = state.acquire(&operation_id, &workspace_id, mutation)?;
    let (root, checkpoint) =
        crate::persistence::runtime::git_context(&app, &workspace_id, mutation)
            .map_err(GitError::from)?;
    let mut git = Git::new(root, workspace_id.clone());
    git.cancel = cancel;
    git.checkpoint = checkpoint;
    let handle = app.clone();
    let owner = workspace_id.clone();
    git.journal = Some(Box::new(move |value| {
        crate::persistence::runtime::git_journal(&handle, &owner, value)
    }));
    if let Some(id) = on_event {
        let channel: tauri::ipc::Channel<String> = id.channel_on(webview);
        let _ = channel.send(
            if mutation {
                "Updating repository…"
            } else {
                "Reading repository…"
            }
            .into(),
        );
    }
    let result = match query {
        Query::Status => serde_json::to_value(git.status().await?)
            .map_err(|_| GitError::new("git", "Cannot read Git state.")),
        Query::Execute { action } => {
            let result = git.execute(action).await;
            drop(lease);
            // Consumers rescan through the existing persistence pipeline, also on failure.
            let _ = app.emit(
                "git-state-changed",
                serde_json::json!({"workspaceId":workspace_id}),
            );
            let _ = app.emit(
                "project-files-changed",
                serde_json::json!([{"id":workspace_id,"paths":["*"]}]),
            );
            result?;
            return serde_json::to_value(git.status().await?)
                .map_err(|_| GitError::new("git", "Cannot read Git state."));
        }
        Query::Diff { request } => serde_json::to_value(git.diff(request).await?)
            .map_err(|_| GitError::new("git", "Cannot read diff.")),
        Query::History { skip, path } => serde_json::to_value(git.history(skip, path).await?)
            .map_err(|_| GitError::new("git", "Cannot read history.")),
        Query::CommitFiles { commit } => serde_json::to_value(git.commit_files(&commit).await?)
            .map_err(|_| GitError::new("git", "Cannot read changes.")),
        Query::Stashes => serde_json::to_value(git.stashes().await?)
            .map_err(|_| GitError::new("git", "Cannot read stashes.")),
        Query::Conflicts => serde_json::to_value(git.conflicts().await?)
            .map_err(|_| GitError::new("git", "Cannot read conflicts.")),
    };
    drop(lease);
    result
}
pub fn git_cancel(app: tauri::AppHandle, operation_id: String) -> Result<()> {
    let state = app.state::<GitState>();
    let registry = state
        .0
        .lock()
        .map_err(|_| GitError::new("busy", "Git is busy."))?;
    if let Some((_, _, token)) = registry.get(&operation_id) {
        token.cancel();
    }
    Ok(())
}
pub async fn git_clone(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    operation_id: String,
    url: String,
    directory: String,
    on_event: Option<tauri::ipc::JavaScriptChannelId>,
) -> Result<String> {
    validate_url(&url)?;
    let target = PathBuf::from(&directory);
    let parent = target.parent().filter(|p| p.is_dir()).ok_or_else(|| {
        GitError::new("git", "Choose a directory with an existing parent folder.")
    })?;
    let parent = std::fs::canonicalize(parent)?;
    let name = target
        .file_name()
        .ok_or_else(|| GitError::new("git", "Choose a project directory."))?;
    let target = parent.join(name);
    if std::fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(GitError::new(
            "git",
            "The clone directory cannot be a symbolic link.",
        ));
    }
    if target.exists() && (!target.is_dir() || std::fs::read_dir(&target)?.next().is_some()) {
        return Err(GitError::new(
            "git",
            "Clone requires a new or empty directory.",
        ));
    }
    crate::persistence::runtime::check_project_destination(&app, &target)
        .map_err(GitError::from)?;
    let state = app.state::<GitState>();
    let (_lease, cancel) =
        state.acquire(&operation_id, &format!("clone:{}", target.display()), true)?;
    let staging = tempfile::Builder::new()
        .prefix(".purr-clone-")
        .tempdir_in(&parent)?;
    let project = staging.path().join("project");
    let mut git = Git::new(parent.clone(), String::new());
    git.cancel = cancel;
    if let Some(id) = on_event {
        let channel: tauri::ipc::Channel<String> = id.channel_on(webview);
        let _ = channel.send("Cloning repository…".into());
    }
    git.run(&[
        "clone",
        "--",
        &url,
        project
            .to_str()
            .ok_or_else(|| GitError::new("git", "Project paths must use UTF-8."))?,
    ])
    .await?;
    git.root = project.clone();
    git.repository().await?;
    let files = FilesystemWorkspaceStore {
        directory: project.clone(),
    }
    .load()
    .map_err(GitError::from)?;
    let manifest=files.get("purr.yaml").ok_or_else(||GitError::new("invalid-project","This repository is not a valid Purr workspace: purr.yaml is missing. Use New workspace and Add remote for an empty repository."))?;
    let value: Value = serde_yaml::from_str(&manifest.content).map_err(|_| {
        GitError::new(
            "invalid-project",
            "The cloned workspace manifest is invalid.",
        )
    })?;
    git.workspace = value["workspace"]["id"]
        .as_str()
        .ok_or_else(|| {
            GitError::new(
                "invalid-project",
                "The cloned workspace identity is missing.",
            )
        })?
        .into();
    git.validate_files(&files)?;
    crate::persistence::runtime::check_clone_identity(&app, &git.workspace, &target)
        .map_err(|message| GitError::new("identity", message))?;
    if target.exists() {
        std::fs::remove_dir(&target).map_err(|_| {
            GitError::new(
                "stale",
                "The clone destination changed. Existing files were preserved.",
            )
        })?;
    }
    std::fs::rename(project, &target)?;
    Ok(target.to_string_lossy().into())
}
