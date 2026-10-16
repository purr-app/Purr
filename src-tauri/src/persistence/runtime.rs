use crate::{
    persistence::{
        commit_coordinator,
        local_records::{LocalAttachment, LocalRecord, LocalStateStore},
        project_files::{FileChange, FilesystemWorkspaceStore, ProjectFile},
        secret_commits::{OperationStatus, SecretBatch, SecretSnapshot},
        workspace_cleanup::{self, WorkspaceDeletionResult},
    },
    security::{
        context::{data_directory, NativeKeyState},
        ProtectedError, ProtectedStatus,
    },
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{mpsc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use zeroize::Zeroizing;

#[derive(Default)]
pub struct PersistenceState(
    Mutex<Option<RuntimeStorage>>,
    Mutex<Option<ProtectedError>>,
    Mutex<HashMap<String, PathBuf>>,
    Mutex<HashSet<String>>,
);
struct RuntimeStorage {
    local: LocalStateStore,
    roots: HashMap<String, PathBuf>,
    watcher: RecommendedWatcher,
    projects: PathBuf,
    data: PathBuf,
}

const PROJECT_RESOURCE_ROOTS: [&str; 8] = [
    "requests",
    "graphql",
    "documents",
    "schemas",
    "environments",
    "folders",
    "integrations",
    "assets",
];

fn project_change_paths(root: &Path, paths: &[PathBuf], rescan: bool) -> Vec<String> {
    if rescan {
        return vec!["*".into()];
    }
    let mut changes = BTreeSet::new();
    for path in paths {
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        if relative.is_empty() {
            changes.insert("*".into());
            continue;
        }
        if relative == "purr.yaml" {
            changes.insert(relative);
            continue;
        }
        let resource_root = relative.split('/').next().unwrap_or("");
        if !PROJECT_RESOURCE_ROOTS.contains(&resource_root) {
            continue;
        }
        // The documents directory is itself the canonical folder hierarchy.
        // Any event inside it may represent a nested directory create, move,
        // rename or removal, so rescan the complete workspace snapshot instead
        // of trying to infer a tree mutation from platform-specific event pairs.
        if resource_root == "documents" {
            changes.clear();
            changes.insert("*".into());
            break;
        }
        if relative.ends_with(".yaml")
            || relative.ends_with(".graphql")
            || relative.ends_with(".openapi")
            || relative.ends_with(".bin")
        {
            changes.insert(relative);
        } else if !relative.split('/').any(|part| part.starts_with('.')) {
            changes.clear();
            changes.insert("*".into());
            break;
        }
    }
    changes.into_iter().collect()
}

// A pending commit suppresses partial reads, but retains unrelated external
// events as one wildcard rescan that can be delivered without another OS event.
fn ready_watcher_rescan(deferred: &mut bool, pending: bool, rescan: bool) -> Option<bool> {
    if pending {
        *deferred = true;
        None
    } else {
        Some(rescan | std::mem::take(deferred))
    }
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || matches!(id, "global" | "__global__")
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        Err("Invalid workspace identifier".into())
    } else {
        Ok(())
    }
}
impl RuntimeStorage {
    fn open(app: &tauri::AppHandle) -> Result<Self, ProtectedError> {
        let data = data_directory(app)?;
        fs::create_dir_all(&data).map_err(|_| "Cannot create application storage")?;
        let ciphers = app
            .state::<NativeKeyState>()
            .open(app)
            .unwrap_or_else(|_| std::sync::Arc::new(crate::security::RootCiphers::unavailable()));
        let local =
            LocalStateStore::open_with_ciphers(&data.join("local-state.sqlite3"), &ciphers)?;
        let (sender, receiver) = mpsc::channel();
        let watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })
        .map_err(|_| "Cannot watch project directory")?;
        let handle = app.clone();
        std::thread::spawn(move || {
            let mut deferred_rescan = false;
            loop {
                let first = if deferred_rescan {
                    match receiver.recv_timeout(Duration::from_millis(180)) {
                        Ok(event) => Some(event),
                        Err(mpsc::RecvTimeoutError::Timeout) => None,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                } else {
                    match receiver.recv() {
                        Ok(event) => Some(event),
                        Err(_) => break,
                    }
                };
                let mut paths = Vec::new();
                let mut rescan = deferred_rescan;
                match first {
                    Some(Ok(event)) if !matches!(event.kind, notify::EventKind::Access(_)) => {
                        rescan |= event.need_rescan();
                        paths.extend(event.paths);
                    }
                    Some(Err(_)) => rescan = true,
                    _ => {}
                }
                while let Ok(event) = receiver.recv_timeout(Duration::from_millis(180)) {
                    match event {
                        Ok(event) if !matches!(event.kind, notify::EventKind::Access(_)) => {
                            rescan |= event.need_rescan();
                            paths.extend(event.paths);
                        }
                        Err(_) => rescan = true,
                        _ => {}
                    }
                }
                if rescan || !paths.is_empty() {
                    let state = handle.state::<PersistenceState>();
                    if let Ok(guard) = state.0.lock() {
                        if let Some(storage) = guard.as_ref() {
                            // Never rehydrate a partially applied or conflicted commit.
                            let Some(rescan) = ready_watcher_rescan(
                                &mut deferred_rescan,
                                storage.local.has_pending_commit().unwrap_or(true),
                                rescan,
                            ) else {
                                continue;
                            };
                            let changes: Vec<Value> = storage
                                .roots
                                .iter()
                                .filter_map(|(id, root)| {
                                    if crate::git::native::ensure_idle(&handle, id).is_err() { return None; }
                                    let relevant_git = rescan || paths.iter().any(|path| path.strip_prefix(root).is_ok_and(|p| { let text = p.to_string_lossy(); !text.starts_with(".git/objects/") && !text.starts_with(".git/logs/") }));
                                    if relevant_git { let _ = handle.emit("git-state-changed", json!({"workspaceId":id})); }
                                    let relative = project_change_paths(root, &paths, rescan);
                                    if relative.is_empty() {
                                        None
                                    } else {
                                        Some(json!({"id":id,"paths":relative}))
                                    }
                                })
                                .collect();
                            if !changes.is_empty() {
                                let _ = handle.emit("project-files-changed", changes);
                            }
                        }
                    };
                }
            }
        });
        let mut result = Self {
            local,
            roots: HashMap::new(),
            watcher,
            projects: data.join("projects"),
            data,
        };
        // Cleanup is independent of commit recovery and never blocks startup.
        if let Ok(workspaces) = result.local.cleanup_workspaces() {
            for id in workspaces {
                if workspace_cleanup::retry(&result.local, &id).is_err() {
                    let _ = app.emit("project-cleanup-pending", json!({"workspaceId":id}));
                }
            }
        }
        // These registrations already existed before cleanup was queued. Do not
        // decrypt unrelated cleanup jobs while restoring their watches; guards
        // belong to new save/attach operations, where path reuse is possible.
        for (id, directory) in result.local.workspaces()? {
            result.watch(&id, PathBuf::from(directory))?;
        }
        // Keep operation-status/recovery APIs reachable when external edits
        // prevent rollback. Workspace reads and writes still enforce recovery.
        let _ = result.recover();
        result.local.cleanup_attachment_staging()?;
        Ok(result)
    }
    fn recover(&mut self) -> Result<(), String> {
        for (id, pending) in self.local.pending()? {
            let store = self.files(&id)?;
            commit_coordinator::recover(&mut self.local, &store, &id, pending)
                .map_err(|error| format!("Commit recovery-required; {error}"))?;
        }
        Ok(())
    }
    fn recover_before_commit(&mut self) -> Result<(), String> {
        // No part of this incoming request has been attempted yet. In
        // particular, an unrelated recovery failure cannot acknowledge an old
        // receipt for a reused ID before request-fingerprint validation runs.
        self.recover()
            .map_err(|error| format!("commit-rejected: {error}"))
    }
    fn watch(&mut self, id: &str, directory: PathBuf) -> Result<(), String> {
        if !self.roots.contains_key(id) {
            fs::create_dir_all(&directory).map_err(|_| "Cannot open project directory")?;
            self.watcher
                .watch(&directory, RecursiveMode::Recursive)
                .map_err(|_| "Cannot watch project directory")?;
            self.roots.insert(id.into(), directory);
        }
        Ok(())
    }
    fn files(&self, id: &str) -> Result<FilesystemWorkspaceStore, String> {
        valid_id(id)?;
        Ok(FilesystemWorkspaceStore {
            directory: self
                .roots
                .get(id)
                .cloned()
                .unwrap_or_else(|| self.projects.join(id)),
        })
    }
    fn workspace(&mut self, id: &str) -> Result<Value, String> {
        self.recover()?;
        let mut files = self.files(id)?.load()?;
        let (local, unavailable) = self.local.read_partial(id)?;
        let git_checkpoint = local.iter().find(|record| record.table == "workspace_local_state" && record.id == "git-operation");
        if let Some(original) = git_checkpoint.and_then(|record| record.value.get("projectFiles")) {
            files = serde_json::from_value(original.clone()).map_err(|_| "The Git recovery snapshot is unreadable")?;
        }
        let state = if git_checkpoint.is_some() {
            json!({"status":"recovery-required","code":"git-operation-pending"})
        } else if self.local.validate_owner_keys(id).is_ok() {
            json!({"status":"available"})
        } else {
            json!({"status":"unavailable","code":"protected-storage-unavailable"})
        };
        let runtime_state = if self.local.runtime_cipher(id).is_ok() {
            json!({"status":"available"})
        } else {
            json!({"status":"unavailable","code":"runtime-storage-unavailable"})
        };
        Ok(
            json!({"id":id,"files":files,"local":local,"unavailableLocal":unavailable,"protectedState":state,"runtimeProtectedState":runtime_state}),
        )
    }
}

fn access_typed<T>(
    app: &tauri::AppHandle,
    state: &PersistenceState,
    call: impl FnOnce(&mut RuntimeStorage) -> Result<T, ProtectedError>,
) -> Result<T, ProtectedError> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| ProtectedError::unavailable("persistence-lock-unavailable"))?;
    if guard.is_none() {
        let mut failure = state
            .1
            .lock()
            .map_err(|_| ProtectedError::unavailable("persistence-lock-unavailable"))?;
        if let Some(error) = failure.as_ref() {
            return Err(error.clone());
        }
        match RuntimeStorage::open(app) {
            Ok(storage) => *guard = Some(storage),
            Err(error) => {
                *failure = Some(error.clone());
                return Err(error);
            }
        }
    }
    call(
        guard
            .as_mut()
            .ok_or_else(|| ProtectedError::unavailable("persistence-unavailable"))?,
    )
}
fn access<T>(
    app: &tauri::AppHandle,
    state: &PersistenceState,
    call: impl FnOnce(&mut RuntimeStorage) -> Result<T, String>,
) -> Result<T, String> {
    // Existing mutation error markers are part of S01 reconciliation. Preserve
    // them rather than flattening them into a generic availability failure.
    access_typed(app, state, |storage| Ok(call(storage))).map_err(|error| error.to_string())?
}
fn degraded_snapshot(
    app: &tauri::AppHandle,
    state: &PersistenceState,
    error: &ProtectedError,
) -> Result<Value, String> {
    let data = data_directory(app).map_err(|error| error.to_string())?;
    let attached = state
        .2
        .lock()
        .map_err(|_| "Project catalogue is unavailable")?;
    super::catalogue::load(&data, error, &attached)
}
fn snapshot(
    storage: &mut RuntimeStorage,
    attached: &HashMap<String, PathBuf>,
) -> Result<Value, ProtectedError> {
    storage.recover().map_err(|_| {
        ProtectedError::new(
            ProtectedStatus::RecoveryRequired,
            "project-recovery-required",
            true,
        )
    })?;
    let mut ids = storage
        .local
        .workspaces()?
        .into_iter()
        .map(|(id, _)| id)
        .collect::<BTreeSet<_>>();
    for (id, directory) in attached {
        if !ids.contains(id) {
            workspace_cleanup::ensure_available(&storage.local, id, directory)?;
            let _ = storage.local.prepare_workspace_keys(id);
            storage.watch(id, directory.clone())?;
            ids.insert(id.clone());
        }
    }
    let workspaces = ids
        .iter()
        .map(|id| storage.workspace(id))
        .collect::<Result<Vec<_>, _>>()?;
    let (global, global_unavailable) = storage.local.read_partial("__global__")?;
    let global_state = if storage.local.validate_owner_keys("__global__").is_ok() {
        json!({"status":"available"})
    } else {
        json!({"status":"unavailable","code":"protected-storage-unavailable"})
    };
    let old = crate::security::layout::deprecated_directory(&storage.data);
    Ok(
        json!({"activeWorkspaceId":storage.local.app("active-workspace")?.unwrap_or_default(),"workspaces":workspaces,"global":global,"globalUnavailableLocal":global_unavailable,"globalProtectedState":global_state,"protectedState":{"status":"available"},"storageNotice":old.map(|directory| json!({"legacyDirectory":directory.to_string_lossy()}))}),
    )
}

/// Transfer operations share the normal storage lock and recovery boundary.
pub(crate) fn transfer_access<T>(
    app: &tauri::AppHandle,
    workspace: &str,
    call: impl FnOnce(&mut LocalStateStore, &FilesystemWorkspaceStore) -> Result<T, String>,
) -> Result<T, String> {
    valid_id(workspace)?;
    access(app, &app.state::<PersistenceState>(), |storage| {
        storage.recover_before_commit()?;
        let files = storage.files(workspace)?;
        call(&mut storage.local, &files)
    })
}

pub fn secure_get(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    reference: String,
) -> Result<Option<String>, String> {
    access(&app, &state, |storage| storage.local.get_secret(&reference))
}

pub fn observability_integrations(
    app: &tauri::AppHandle,
    state: &PersistenceState,
    workspace: &str,
) -> crate::observability::domain::Result<Vec<crate::observability::service::Integration>> {
    access(app, state, |storage| {
        super::observability::integrations(&storage.files(workspace)?)
    })
    .map_err(|_| crate::observability::domain::ObservabilityError::StorageUnavailable)
}

pub fn observability_exchange(
    app: &tauri::AppHandle,
    state: &PersistenceState,
    query: &crate::observability::domain::TraceQuery,
) -> crate::observability::domain::Result<crate::observability::correlation::ExchangeInput> {
    use crate::observability::domain::ObservabilityError;
    let value = access(app, state, |storage| {
        storage.local.execution_metadata(
            &query.workspace_id,
            &query.document_id,
            query.started_at_ms,
        )
    })
    .map_err(|_| ObservabilityError::StorageUnavailable)?
    .ok_or(ObservabilityError::ResponsePending)?;
    super::observability::exchange(value)
}

pub fn secure_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    reference: String,
    value: String,
) -> Result<(), String> {
    let value = Zeroizing::new(value);
    access(&app, &state, |storage| {
        storage.recover()?;
        storage.local.set_secret(&reference, &value)
    })
}

pub fn secure_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    reference: String,
) -> Result<(), String> {
    access(&app, &state, |storage| {
        storage.recover()?;
        storage.local.delete_secret(&reference)
    })
}

pub fn secure_exists(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    reference: String,
) -> Result<bool, String> {
    access(&app, &state, |storage| {
        storage.local.secret_exists(&reference)
    })
}
pub fn load_persistence(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
) -> Result<Value, String> {
    match access_typed(&app, &state, |storage| {
        let attached = state
            .2
            .lock()
            .map_err(|_| ProtectedError::unavailable("project-catalogue-unavailable"))?;
        snapshot(storage, &attached)
    }) {
        Ok(value) => Ok(value),
        Err(error) => degraded_snapshot(&app, &state, &error),
    }
}

pub fn load_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    id: String,
) -> Result<Value, String> {
    match access_typed(&app, &state, |storage| {
        storage.recover().map_err(|_| {
            ProtectedError::new(
                ProtectedStatus::RecoveryRequired,
                "project-recovery-required",
                true,
            )
        })?;
        storage.workspace(&id).map_err(ProtectedError::from)
    }) {
        Ok(value) => Ok(value),
        Err(error) => degraded_snapshot(&app, &state, &error)?["workspaces"]
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["id"] == id))
            .cloned()
            .ok_or_else(|| "Workspace is not in the readable catalogue".into()),
    }
}

pub fn begin_attachment(
    app: &tauri::AppHandle,
    state: &PersistenceState,
    workspace: &str,
    owner: &str,
    stage: &str,
    metadata: super::attachments::AttachmentMetadata,
) -> Result<(), String> {
    valid_id(workspace)?;
    access(app, state, |storage| {
        if state
            .3
            .lock()
            .map_err(|_| "Upload owner is unavailable")?
            .contains(owner)
            || app.get_webview_window(owner).is_none()
        {
            return Err("Upload owner is unavailable".into());
        }
        storage
            .local
            .begin_attachment(workspace, owner, stage, metadata)
    })
}
pub fn append_attachment(
    app: &tauri::AppHandle,
    state: &PersistenceState,
    workspace: &str,
    owner: &str,
    stage: &str,
    index: u64,
    bytes: &[u8],
) -> Result<(), String> {
    valid_id(workspace)?;
    access(app, state, |storage| {
        if state
            .3
            .lock()
            .map_err(|_| "Upload owner is unavailable")?
            .contains(owner)
            || app.get_webview_window(owner).is_none()
        {
            return Err("Upload owner is unavailable".into());
        }
        storage
            .local
            .append_attachment(workspace, owner, stage, index, bytes)
    })
}
pub fn finish_attachment(
    app: &tauri::AppHandle,
    state: &PersistenceState,
    workspace: &str,
    owner: &str,
    stage: &str,
) -> Result<super::attachments::PreparedAttachment, String> {
    valid_id(workspace)?;
    access(app, state, |storage| {
        if state
            .3
            .lock()
            .map_err(|_| "Upload owner is unavailable")?
            .contains(owner)
            || app.get_webview_window(owner).is_none()
        {
            return Err("Upload owner is unavailable".into());
        }
        storage.local.finish_attachment(workspace, owner, stage)
    })
}
pub fn abort_attachment(
    app: &tauri::AppHandle,
    state: &PersistenceState,
    workspace: &str,
    owner: &str,
    stage: &str,
) -> Result<(), String> {
    valid_id(workspace)?;
    access(app, state, |storage| {
        storage.local.abort_attachment(workspace, owner, stage)
    })
}
pub fn release_attachment_owner(app: &tauri::AppHandle, owner: &str) -> Result<(), String> {
    let state = app.state::<PersistenceState>();
    // Cleanup must not initialize protected storage solely because a window closes.
    let guard = state
        .0
        .lock()
        .map_err(|_| "Persistence lock is unavailable")?;
    state
        .3
        .lock()
        .map_err(|_| "Upload owner is unavailable")?
        .insert(owner.to_string());
    if let Some(storage) = guard.as_ref() {
        storage.local.release_attachment_owner(owner)?;
    }
    Ok(())
}
pub fn prepare_attachment(
    app: &tauri::AppHandle,
    state: &PersistenceState,
    workspace: &str,
    id: &str,
) -> Result<super::attachments::AttachmentSource, String> {
    valid_id(workspace)?;
    access(app, state, |storage| {
        storage.local.prepare_attachment(workspace, id)
    })
}

pub fn read_attachment(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    workspace_id: String,
    attachment_id: String,
) -> Result<LocalAttachment, String> {
    valid_id(&workspace_id)?;
    if attachment_id.is_empty() || attachment_id.len() > 160 {
        return Err("Invalid local attachment identifier".into());
    }
    access(&app, &state, |storage| {
        storage.local.read_attachment(&workspace_id, &attachment_id)
    })
}

pub fn list_request_history(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    id: String,
    document: String,
    before: i64,
    limit: u32,
) -> Result<Vec<Value>, String> {
    access(&app, &state, |storage| {
        storage.local.history(&id, &document, before, limit)
    })
}
pub fn reload_project_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    id: String,
    path: String,
) -> Result<Option<ProjectFile>, String> {
    match access_typed(&app, &state, |storage| Ok(storage.files(&id)?.read(&path))) {
        Ok(value) => value,
        Err(_) => {
            let workspace = load_project(app, state, id)?;
            workspace["files"]
                .get(&path)
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|_| "Invalid project resource".into())
        }
    }
}
pub fn commit_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    id: String,
    files: Vec<FileChange>,
    local: Vec<LocalRecord>,
    secrets: Option<SecretBatch>,
) -> Result<BTreeMap<String, Option<ProjectFile>>, String> {
    valid_id(&id)?;
    crate::git::native::ensure_idle(&app, &id)?;
    let batch = secrets
        .map(Ok)
        .unwrap_or_else(|| SecretBatch::fresh(vec![]))?;
    access(&app, &state, |storage| {
        storage.recover_before_commit()?;
        let store = storage.files(&id)?;
        if !files.is_empty() && storage.local.read_partial(&id)?.0.iter().any(|record| record.table == "workspace_local_state" && record.id == "git-operation") {
            return Err("Finish or abort the pending Git operation before saving project files".into());
        }
        workspace_cleanup::ensure_available(&storage.local, &id, &store.directory)?;
        let protected = !batch.mutations.is_empty()
            || local.iter().any(|record| {
                record.protection == super::local_records::RecordProtection::Encrypted
            });
        let prepared = storage.local.prepare_workspace_keys(&id);
        if protected {
            prepared?;
        }
        storage.watch(&id, store.directory.clone())?;
        commit_coordinator::commit(&mut storage.local, &store, &id, &files, &local, &batch)
    })
}
pub fn set_local_active_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    id: String,
) -> Result<(), String> {
    valid_id(&id)?;
    access(&app, &state, |storage| {
        storage.local.set_app("active-workspace", &id)
    })
}

pub fn write_global_state(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    local: Vec<LocalRecord>,
    secrets: Option<SecretBatch>,
) -> Result<(), String> {
    let batch = secrets
        .map(Ok)
        .unwrap_or_else(|| SecretBatch::fresh(vec![]))?;
    access(&app, &state, |storage| {
        storage.recover_before_commit()?;
        let store = FilesystemWorkspaceStore {
            directory: PathBuf::new(),
        };
        commit_coordinator::commit(
            &mut storage.local,
            &store,
            "__global__",
            &[],
            &local,
            &batch,
        )
        .map(|_| ())
    })
}

pub fn secure_read(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    reference: String,
) -> Result<SecretSnapshot, String> {
    access(&app, &state, |storage| {
        storage.local.read_secret(&reference)
    })
}
pub fn secure_resolve(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    reference: String,
) -> Value {
    let result = access_typed(&app, &state, |storage| {
        storage.local.read_secret_typed(&reference)
    });
    secret_resolution(result)
}
pub fn secure_inspect(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    references: Vec<String>,
) -> Result<Vec<Value>, String> {
    if references.len() > 10_000 {
        return Err("Too many secret references".into());
    }
    Ok(references.into_iter().map(|reference| {
        let result = access_typed(&app, &state, |storage| storage.local.read_secret_typed(&reference));
        match result {
            Ok(snapshot) => match snapshot.value {
                Some(value) => json!({"ref":reference,"status":"available","revision":snapshot.revision,"empty":value.is_empty()}),
                None => json!({"ref":reference,"status":"missing","revision":snapshot.revision}),
            },
            Err(error) => json!({"ref":reference,"status":if error.status==ProtectedStatus::RecoveryRequired {ProtectedStatus::Unavailable}else{error.status},"code":error.code,"retryable":error.retryable}),
        }
    }).collect())
}
fn secret_resolution(result: Result<SecretSnapshot, ProtectedError>) -> Value {
    match result {
        Ok(value) => match value.value {
            Some(text) => json!({"status":"available","value":text,"revision":value.revision}),
            None => json!({"status":"missing","revision":value.revision}),
        },
        Err(error) => {
            json!({"status":if error.status==ProtectedStatus::RecoveryRequired {ProtectedStatus::Unavailable}else{error.status},"code":error.code,"retryable":error.retryable})
        }
    }
}
pub fn retry_protected_storage(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
) -> Result<Value, String> {
    let _ = app.state::<NativeKeyState>().retry(&app);
    {
        let mut current = state.0.lock().map_err(|_| "Persistence is unavailable")?;
        // Re-read repaired local state, but retain successful key handles shared
        // with active response workers. Concurrent key retries coalesce above.
        *current = None;
        // Resolve the latest manager state during load, rather than publishing
        // a delayed failed retry over a newer successful attempt.
        *state.1.lock().map_err(|_| "Persistence is unavailable")? = None;
    }
    load_persistence(app, state)
}

pub fn secure_commit(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    batch: SecretBatch,
) -> Result<(), String> {
    access(&app, &state, |storage| {
        storage.recover_before_commit()?;
        storage.local.commit_secrets(&batch)
    })
}
pub fn secure_operation_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    operation_id: String,
) -> Result<OperationStatus, String> {
    access(&app, &state, |storage| {
        let _ = storage.recover();
        storage.local.operation_status(&operation_id)
    })
}

pub fn delete_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    id: String,
    operation_id: Option<String>,
) -> Result<WorkspaceDeletionResult, String> {
    valid_id(&id)?;
    let batch = match operation_id {
        Some(operation_id) => SecretBatch {
            operation_id,
            mutations: vec![],
        },
        None => SecretBatch::fresh(vec![])?,
    };
    access(&app, &state, |storage| {
        storage.recover_before_commit()?;
        let directory = storage
            .roots
            .get(&id)
            .cloned()
            .unwrap_or_else(|| storage.projects.join(&id));
        let managed = (directory == storage.projects.join(&id)).then_some(directory.as_path());
        let replay = storage.local.operation(&batch.operation_id)?.is_some();
        let result = workspace_cleanup::delete(&mut storage.local, &id, managed, &batch)?;
        if !replay {
            if let Ok(mut attached) = state.2.lock() {
                attached.remove(&id);
            }
            storage.roots.remove(&id);
            let _ = storage.watcher.unwatch(&directory);
        }
        if result.cleanup_pending {
            let _ = app.emit("project-cleanup-pending", json!({"workspaceId":id}));
        }
        Ok(result)
    })
}
pub fn finish_legacy_migration(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
) -> Result<(), String> {
    access(&app, &state, |_storage| Ok(()))
}

pub fn open_project_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    id: String,
) -> Result<(), String> {
    access(&app, &state, |storage| {
        app.opener()
            .open_path(
                storage.files(&id)?.directory.to_string_lossy(),
                None::<&str>,
            )
            .map_err(|_| "Cannot open project folder".into())
    })
}
pub fn attach_project_directory(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    id: String,
    directory: String,
) -> Result<Value, String> {
    valid_id(&id)?;
    let data = data_directory(&app).map_err(|error| error.to_string())?;
    let path = fs::canonicalize(directory).map_err(|_| "Project directory does not exist")?;
    if data.starts_with(&path) {
        return Err("A project directory cannot contain Purr's private application storage".into());
    }
    if !path.join("purr.yaml").is_file() {
        return Err("The directory does not contain purr.yaml".into());
    }
    match access_typed(&app, &state, |storage| {
        Ok((|| {
            let path = path.clone();
            if storage.data.starts_with(&path) {
                return Err(
                    "A project directory cannot contain Purr's private application storage".into(),
                );
            }
            if !path.join("purr.yaml").is_file() {
                return Err("The directory does not contain purr.yaml".into());
            }
            if storage.roots.get(&id).is_some_and(|root| root != &path) {
                return Err("A workspace with this ID is already open".into());
            }
            if storage
                .roots
                .iter()
                .any(|(other, root)| other != &id && root == &path)
            {
                return Err(
                    "This directory is already registered with a different workspace ID".into(),
                );
            }
            workspace_cleanup::ensure_available(&storage.local, &id, &path)?;
            // Registration follows successful frontend validation via a separate commit.
            let _ = storage.local.prepare_workspace_keys(&id);
            storage.watch(&id, path)?;
            storage.workspace(&id)
        })())
    }) {
        Ok(result) => result,
        Err(error) => {
            let mut attached = state
                .2
                .lock()
                .map_err(|_| "Project catalogue is unavailable")?;
            super::catalogue::check_attachment(&data, &id, &path, &attached)?;
            let files = FilesystemWorkspaceStore {
                directory: path.clone(),
            }
            .load()?;
            attached.insert(id.clone(), path);
            Ok(
                json!({"id":id,"files":files,"local":[],"protectedState":super::catalogue::protected_state(&error)}),
            )
        }
    }
}

/// Classify before parsing so ordinary collection imports can use their existing
/// importer, while an invalid Purr manifest always stays an explicit error.
fn project_directory_input(directory: &str, optional: bool) -> Result<Option<PathBuf>, String> {
    let input = Path::new(directory);
    let resolved = fs::canonicalize(input)
        .map_err(|_| "The selected file or workspace folder does not exist")?;
    let path = if resolved.is_dir() {
        resolved
    } else if resolved.is_file() && input.file_name().is_some_and(|name| name == "purr.yaml") {
        fs::canonicalize(
            input
                .parent()
                .filter(|path| !path.as_os_str().is_empty())
                .unwrap_or(Path::new(".")),
        )
        .map_err(|_| "The selected workspace folder does not exist")?
    } else if optional {
        return Ok(None);
    } else {
        return Err("Choose a Purr workspace folder or its purr.yaml file".into());
    };
    if optional {
        match fs::symlink_metadata(path.join("purr.yaml")) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("Cannot read the workspace purr.yaml".into()),
            Ok(_) => {}
        }
    }
    Ok(Some(path))
}

/// Inspect a portable project without registering it or touching protected state.
/// The application validates the canonical domain model before calling open.
fn directory_candidate(
    data: &Path,
    directory: &str,
) -> Result<(PathBuf, String, BTreeMap<String, ProjectFile>), String> {
    let path = project_directory_input(directory, false)?
        .ok_or("Choose a Purr workspace folder or its purr.yaml file")?;
    let data = fs::canonicalize(data).unwrap_or_else(|_| data.to_path_buf());
    if !path.is_dir() || data.starts_with(&path) || path.starts_with(&data) {
        return Err("Choose a workspace folder outside Purr's private application storage".into());
    }
    let store = FilesystemWorkspaceStore {
        directory: path.clone(),
    };
    let files = store.load()?;
    let manifest = files
        .get("purr.yaml")
        .ok_or("This folder is not a Purr workspace: purr.yaml is missing")?;
    let manifest: Value = serde_yaml::from_str(&manifest.content)
        .map_err(|_| "The workspace purr.yaml is invalid")?;
    if manifest["purr"] != 2 {
        return Err("This workspace uses an unsupported project format".into());
    }
    let id = manifest["workspace"]["id"]
        .as_str()
        .ok_or("The workspace identity is missing")?
        .to_string();
    valid_id(&id)?;
    crate::transfer::validate_project_files(&files, &id)?;
    Ok((path, id, files))
}

fn inspect_project_directory(
    data: &Path,
    directory: &str,
    optional: bool,
) -> Result<Value, String> {
    let Some(path) = project_directory_input(directory, optional)? else {
        return Ok(Value::Null);
    };
    let (_, id, files) = directory_candidate(data, &path.to_string_lossy())?;
    Ok(json!({"id":id,"files":files,"local":[]}))
}

pub fn read_project_directory(
    app: tauri::AppHandle,
    directory: String,
    optional: bool,
) -> Result<Value, String> {
    let data = data_directory(&app).map_err(|error| error.to_string())?;
    inspect_project_directory(&data, &directory, optional)
}

impl RuntimeStorage {
    fn open_directory(
        &mut self,
        path: PathBuf,
        id: &str,
        files: BTreeMap<String, ProjectFile>,
        expected: &BTreeMap<String, String>,
    ) -> Result<Value, String> {
        let revisions: BTreeMap<_, _> = files
            .iter()
            .map(|(path, file)| (path.clone(), file.revision.clone()))
            .collect();
        if &revisions != expected {
            return Err("The workspace files changed while opening. Please try again".into());
        }
        // Never use an upsert here: a copied folder must not replace the original
        // catalogue entry or inherit its drafts, history and local credentials.
        for (owner, directory) in self.local.workspaces()? {
            let directory =
                fs::canonicalize(&directory).unwrap_or_else(|_| PathBuf::from(directory));
            if owner == id {
                if directory == path {
                    return self.workspace(id);
                }
                return Err("A workspace with this identity is already open from another folder. Select the existing workspace; open this copy on another device or Purr profile.".into());
            }
            if directory == path {
                return Err("This folder is already open as another workspace".into());
            }
        }
        for (owner, directory) in &self.roots {
            if owner == id && directory != &path {
                return Err(
                    "A workspace with this identity is already open from another folder".into(),
                );
            }
            if owner != id && directory == &path {
                return Err("This folder is already open as another workspace".into());
            }
        }
        workspace_cleanup::ensure_available(&self.local, id, &path)?;
        self.recover_before_commit()?;
        self.watcher
            .watch(&path, RecursiveMode::Recursive)
            .map_err(|_| "Cannot watch project directory")?;
        if let Err(error) = self
            .local
            .prepare_workspace_keys(id)
            .and_then(|_| self.local.validate_owner_keys(id))
            .and_then(|_| self.local.register_new(id, &path))
        {
            let _ = self.watcher.unwatch(&path);
            return Err(error);
        }
        self.roots.insert(id.to_string(), path);
        Ok(
            json!({"id":id,"files":files,"local":[],"protectedState":{"status":"available"},"runtimeProtectedState":{"status":"available"}}),
        )
    }
}

pub fn open_project_directory(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    directory: String,
    expected_revisions: BTreeMap<String, String>,
) -> Result<Value, String> {
    let data = data_directory(&app).map_err(|error| error.to_string())?;
    let (path, id, files) = directory_candidate(&data, &directory)?;
    access(&app, &state, |storage| {
        storage.open_directory(path, &id, files, &expected_revisions)
    })
}

pub fn request_history(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    id: String,
    action: Value,
) -> Result<Value, String> {
    valid_id(&id)?;
    access(&app, &state, |storage| {
        storage.recover_before_commit()?;
        storage.local.request_history(&id, action)
    })
}

#[cfg(test)]
mod watcher_tests {
    use super::{project_change_paths, ready_watcher_rescan};

    #[test]
    fn pending_commit_defers_unrelated_changes_until_a_timer_rescan() {
        let mut deferred = false;
        assert_eq!(ready_watcher_rescan(&mut deferred, true, false), None);
        assert_eq!(ready_watcher_rescan(&mut deferred, true, true), None);
        let rescan = ready_watcher_rescan(&mut deferred, false, false).unwrap();
        for root in ["/committing-workspace", "/externally-edited-workspace"] {
            assert_eq!(
                project_change_paths(&PathBuf::from(root), &[], rescan),
                vec!["*"]
            );
        }
        assert!(!deferred);
        assert_eq!(
            ready_watcher_rescan(&mut deferred, false, false),
            Some(false)
        );
    }
    use std::path::PathBuf;

    #[test]
    fn recovery_failure_rejects_incoming_payload_before_old_receipt_can_acknowledge_it() {
        use super::RuntimeStorage;
        use crate::persistence::{
            local_records::LocalStateStore,
            secret_commits::{record_operation, SecretBatch, SecretMutation},
        };
        use crate::security::tests::MemoryRootKeyStore;
        use serde_json::json;
        let dir = tempfile::tempdir().unwrap();
        let local =
            LocalStateStore::open(&dir.path().join("state.db"), &MemoryRootKeyStore::default())
                .unwrap();
        let committed = SecretBatch {
            operation_id: "old-committed".into(),
            mutations: vec![SecretMutation {
                scope: None,
                reference: "purr/first/auth/token".into(),
                expected_revision: 0,
                value: Some("old-value".into()),
            }],
        };
        local.commit_secrets(&committed).unwrap();
        let project = dir.path().join("projects/blocked");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("purr.yaml"), "external edit").unwrap();
        let pending = SecretBatch {
            operation_id: "pending-own-operation".into(),
            mutations: vec![],
        };
        let request = json!({"synthetic":"pending request"});
        local.journal("blocked",&json!({"version":2,"directory":project,"files":[{"path":"purr.yaml","content":"desired","expectedRevision":null}],"previous":{"purr.yaml":null},"local":[],"secrets":pending,"request":request})).unwrap();
        record_operation(
            &local.db,
            &local.cipher,
            &pending.operation_id,
            "prepared",
            &json!({"request":request,"result":null}),
        )
        .unwrap();
        let mut storage = RuntimeStorage {
            local,
            roots: Default::default(),
            watcher: notify::recommended_watcher(|_| {}).unwrap(),
            projects: dir.path().join("projects"),
            data: dir.path().into(),
        };
        let mut differing = committed.clone();
        differing.mutations[0].value = Some("different attempted value".into());
        let incoming = storage
            .recover_before_commit()
            .and_then(|_| storage.local.commit_secrets(&differing));
        let error = incoming.unwrap_err();
        assert!(error.starts_with("commit-rejected:"));
        assert!(error.contains("recovery-required"));
        assert_eq!(
            storage
                .local
                .operation_status(&committed.operation_id)
                .unwrap()
                .status,
            "committed"
        );
        assert_eq!(
            storage
                .local
                .read_secret("purr/first/auth/token")
                .unwrap()
                .value
                .as_deref(),
            Some("old-value")
        );
        assert_eq!(
            storage
                .local
                .operation_status(&pending.operation_id)
                .unwrap()
                .status,
            "recovery-required"
        );
        let own_error = storage.recover_before_commit().unwrap_err();
        assert!(own_error.contains("recovery-required"));
        assert!(own_error.starts_with("commit-rejected:"));
    }

    #[test]
    fn resolution_preserves_missing_empty_corrupt_and_safe_provider_states_without_fake_revisions()
    {
        use super::{secret_resolution, ProtectedError, ProtectedStatus};
        use crate::{
            persistence::local_records::LocalStateStore, security::tests::MemoryRootKeyStore,
        };
        let dir = tempfile::tempdir().unwrap();
        let local =
            LocalStateStore::open(&dir.path().join("state.db"), &MemoryRootKeyStore::default())
                .unwrap();
        let reference = "purr/workspace/auth/token";
        assert_eq!(
            secret_resolution(local.read_secret_typed(reference)),
            serde_json::json!({"status":"missing","revision":0})
        );
        local.set_secret(reference, "").unwrap();
        assert_eq!(
            secret_resolution(local.read_secret_typed(reference)),
            serde_json::json!({"status":"available","revision":1,"value":""})
        );
        local.delete_secret(reference).unwrap();
        assert_eq!(
            secret_resolution(local.read_secret_typed(reference)),
            serde_json::json!({"status":"missing","revision":2})
        );
        local
            .set_secret(reference, "synthetic private value")
            .unwrap();
        local
            .db
            .execute(
                "UPDATE secret_values SET ciphertext=?1 WHERE reference=?2",
                rusqlite::params![b"broken".as_slice(), reference],
            )
            .unwrap();
        let corrupt = secret_resolution(local.read_secret_typed(reference));
        assert_eq!(corrupt["status"], "corrupt");
        assert_eq!(corrupt["code"], "secret-ciphertext-invalid");
        assert!(local.read_secret(reference).is_err());
        assert!(corrupt.get("revision").is_none());
        assert!(corrupt.get("value").is_none());
        for status in [
            ProtectedStatus::Locked,
            ProtectedStatus::Unavailable,
            ProtectedStatus::Denied,
        ] {
            let failure =
                secret_resolution(Err(ProtectedError::new(status, "safe-provider-code", true)));
            assert_eq!(failure["status"], serde_json::to_value(status).unwrap());
            assert!(failure.get("revision").is_none());
            assert!(failure.get("value").is_none());
        }
        let internal = secret_resolution(local.read_secret_typed(crate::security::ROOT_KEY_REF));
        assert_eq!(internal["status"], "denied");
    }

    #[test]
    fn recovered_snapshot_keeps_readonly_attached_project_without_registering_it_implicitly() {
        use super::{snapshot, RuntimeStorage};
        use crate::{
            persistence::local_records::LocalStateStore, security::tests::MemoryRootKeyStore,
        };
        let dir = tempfile::tempdir().unwrap();
        let local =
            LocalStateStore::open(&dir.path().join("state.db"), &MemoryRootKeyStore::default())
                .unwrap();
        local.set_app("legacy-migrated", "1").unwrap();
        let external = dir.path().join("external");
        std::fs::create_dir(&external).unwrap();
        std::fs::write(
            external.join("purr.yaml"),
            "purr: 1
id: external
",
        )
        .unwrap();
        let mut storage = RuntimeStorage {
            local,
            roots: Default::default(),
            watcher: notify::recommended_watcher(|_| {}).unwrap(),
            projects: dir.path().join("projects"),
            data: dir.path().into(),
        };
        let result = snapshot(
            &mut storage,
            &std::collections::HashMap::from([("external".into(), external.clone())]),
        )
        .unwrap();
        assert_eq!(result["protectedState"]["status"], "available");
        assert_eq!(result["workspaces"][0]["id"], "external");
        assert!(storage.local.workspaces().unwrap().is_empty());
        assert_eq!(storage.files("external").unwrap().directory, external);
    }

    #[test]
    fn documents_events_always_rescan_the_canonical_tree() {
        let root = PathBuf::from("/workspace");
        for paths in [
            vec![root.join("documents/request.yaml")],
            vec![root.join("documents/one/two/request.yaml")],
            vec![root.join("documents/one"), root.join("documents/renamed")],
            vec![root.join("documents/one/two")],
            vec![root.join("documents/one/.purr-folder.yaml")],
        ] {
            assert_eq!(project_change_paths(&root, &paths, false), vec!["*"]);
        }
    }

    #[test]
    fn watcher_rescans_after_backend_overflow_and_filters_unmanaged_paths() {
        let root = PathBuf::from("/workspace");
        assert_eq!(project_change_paths(&root, &[], true), vec!["*"]);
        assert!(project_change_paths(
            &root,
            &[root.join(".git/index"), root.join("notes.txt")],
            false
        )
        .is_empty());
        assert_eq!(
            project_change_paths(&root, &[root.join("schemas/api.yaml")], false),
            vec!["schemas/api.yaml"]
        );
        assert_eq!(
            project_change_paths(&root, &[root.join("schemas/api.openapi")], false),
            vec!["schemas/api.openapi"]
        );
    }
}

#[cfg(test)]
mod open_directory_tests {
    use super::*;
    use crate::security::tests::MemoryRootKeyStore;

    fn storage(data: &Path) -> RuntimeStorage {
        RuntimeStorage {
            local: LocalStateStore::open(
                &data.join("local-state.sqlite3"),
                &MemoryRootKeyStore::default(),
            )
            .unwrap(),
            roots: HashMap::new(),
            watcher: notify::recommended_watcher(|_| {}).unwrap(),
            projects: data.join("projects"),
            data: data.to_path_buf(),
        }
    }
    fn fixture(directory: &Path) {
        fs::create_dir_all(directory.join("documents")).unwrap();
        fs::write(directory.join("purr.yaml"), "purr: 2\nworkspace:\n  id: portable\n  name: Portable\n  variables:\n    - id: token\n      kind: static\n      name: TOKEN\n      sensitive: true\n      secretRef: purr/portable/credentials/variables/token\n").unwrap();
        fs::write(directory.join("documents/request.yaml"), "purr: 2\nkind: http\nid: request\nname: Request\nmethod: GET\nurl: https://example.test\nauth:\n  type: bearer\n  token: {kind: secret, ref: purr/portable/credentials/requests/request/saved/bearer}\n").unwrap();
    }
    fn revisions(files: &BTreeMap<String, ProjectFile>) -> BTreeMap<String, String> {
        files
            .iter()
            .map(|(path, file)| (path.clone(), file.revision.clone()))
            .collect()
    }
    #[test]
    fn git_checkpoint_keeps_conflicted_workspace_open_after_restart() {
        let data = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        fixture(project.path());
        let mut runtime = storage(data.path());
        let (path, id, files) = directory_candidate(data.path(), project.path().to_str().unwrap()).unwrap();
        runtime.open_directory(path, &id, files.clone(), &revisions(&files)).unwrap();
        runtime.local.write(&id, &[LocalRecord { table: "workspace_local_state".into(), id: "git-operation".into(), protection: super::super::local_records::RecordProtection::Encrypted,
            value: json!({"version":1,"kind":"merge","projectFiles":files}) }]).unwrap();
        fs::write(project.path().join("purr.yaml"), "<<<<<<< HEAD\ninvalid: [\n=======\n>>>>>>> incoming").unwrap();
        let snapshot = runtime.workspace(&id).unwrap();
        assert_eq!(snapshot["protectedState"]["code"], "git-operation-pending");
        assert_eq!(snapshot["files"]["purr.yaml"]["content"], files["purr.yaml"].content);
        assert!(fs::read_to_string(project.path().join("purr.yaml")).unwrap().contains("<<<<<<<"));
    }
    #[test]
    fn portable_directory_open_preserves_identity_and_refs_without_copying_runtime_or_secrets() {
        let data = tempfile::tempdir().unwrap();
        let exported = tempfile::tempdir().unwrap();
        fixture(exported.path());
        let mut storage = storage(data.path());
        let (path, id, files) =
            directory_candidate(data.path(), exported.path().to_str().unwrap()).unwrap();
        let before: BTreeMap<_, _> = files
            .iter()
            .map(|(path, file)| (path.clone(), file.content.clone()))
            .collect();
        assert!(storage.local.workspaces().unwrap().is_empty());
        let expected = revisions(&files);
        let result = storage
            .open_directory(path.clone(), &id, files, &expected)
            .unwrap();
        assert_eq!(result["id"], "portable");
        assert_eq!(result["local"], json!([]));
        assert!(result["files"]["purr.yaml"]["content"]
            .as_str()
            .unwrap()
            .contains("purr/portable/credentials/variables/token"));
        assert!(result["files"]["documents/request.yaml"]["content"]
            .as_str()
            .unwrap()
            .contains("purr/portable/credentials/requests/request/saved/bearer"));
        assert!(storage
            .local
            .get_secret_typed("purr/portable/credentials/variables/token")
            .unwrap()
            .is_none());
        assert_eq!(
            storage.local.workspaces().unwrap(),
            vec![(id.clone(), path.to_string_lossy().into_owned())]
        );
        let after = FilesystemWorkspaceStore {
            directory: path.clone(),
        }
        .load()
        .unwrap();
        assert_eq!(
            before,
            after
                .iter()
                .map(|(path, file)| (path.clone(), file.content.clone()))
                .collect()
        );
        let again = storage.open_directory(path, &id, after, &expected).unwrap();
        assert_eq!(again["id"], "portable");
        assert_eq!(storage.local.workspaces().unwrap().len(), 1);
    }
    #[test]
    fn duplicate_copy_and_changed_candidate_never_replace_registered_workspace() {
        let data = tempfile::tempdir().unwrap();
        let first = tempfile::tempdir().unwrap();
        let copy = tempfile::tempdir().unwrap();
        fixture(first.path());
        fixture(copy.path());
        let mut storage = storage(data.path());
        let (path, id, files) =
            directory_candidate(data.path(), first.path().to_str().unwrap()).unwrap();
        storage
            .open_directory(path.clone(), &id, files.clone(), &revisions(&files))
            .unwrap();
        let (copy_path, copy_id, copy_files) =
            directory_candidate(data.path(), copy.path().to_str().unwrap()).unwrap();
        assert!(storage
            .open_directory(
                copy_path,
                &copy_id,
                copy_files.clone(),
                &revisions(&copy_files)
            )
            .unwrap_err()
            .contains("already open"));
        assert_eq!(
            storage.local.workspaces().unwrap(),
            vec![(id, path.to_string_lossy().into_owned())]
        );
        assert_eq!(storage.roots.len(), 1);
        let fresh_data = tempfile::tempdir().unwrap();
        let mut fresh = self::storage(fresh_data.path());
        let (path, id, mut files) =
            directory_candidate(fresh_data.path(), copy.path().to_str().unwrap()).unwrap();
        let expected = revisions(&files);
        files.get_mut("purr.yaml").unwrap().revision = "changed".into();
        assert!(fresh
            .open_directory(path, &id, files, &expected)
            .unwrap_err()
            .contains("changed"));
        assert!(fresh.local.workspaces().unwrap().is_empty());
        assert!(fresh.roots.is_empty());
    }
    #[test]
    fn optional_import_distinguishes_collections_and_accepts_manifest_files() {
        let data = tempfile::tempdir().unwrap();
        let portable = tempfile::tempdir().unwrap();
        fixture(portable.path());
        let folder = portable.path().to_str().unwrap();
        let manifest = portable.path().join("purr.yaml");
        let by_folder = inspect_project_directory(data.path(), folder, true).unwrap();
        let by_file =
            inspect_project_directory(data.path(), manifest.to_str().unwrap(), true).unwrap();
        assert_eq!(by_folder, by_file);
        let (path, id, files) =
            directory_candidate(data.path(), manifest.to_str().unwrap()).unwrap();
        let mut storage = storage(data.path());
        storage
            .open_directory(path, &id, files.clone(), &revisions(&files))
            .unwrap();
        assert_eq!(storage.local.workspaces().unwrap().len(), 1);

        let ordinary = tempfile::tempdir().unwrap();
        fs::write(ordinary.path().join("collection.json"), "{}").unwrap();
        for input in [
            ordinary.path().to_path_buf(),
            ordinary.path().join("collection.json"),
        ] {
            assert_eq!(
                inspect_project_directory(data.path(), input.to_str().unwrap(), true).unwrap(),
                Value::Null
            );
            assert!(
                inspect_project_directory(data.path(), input.to_str().unwrap(), false).is_err()
            );
        }
        assert!(inspect_project_directory(
            data.path(),
            ordinary.path().join("missing.json").to_str().unwrap(),
            true
        )
        .is_err());
    }
    #[test]
    fn optional_import_never_falls_back_from_broken_purr_projects() {
        let data = tempfile::tempdir().unwrap();
        let portable = tempfile::tempdir().unwrap();
        fixture(portable.path());
        let manifest = portable.path().join("purr.yaml");
        fs::write(&manifest, "purr: [broken").unwrap();
        for input in [portable.path().to_path_buf(), manifest.clone()] {
            assert!(inspect_project_directory(data.path(), input.to_str().unwrap(), true).is_err());
        }
        fixture(portable.path());
        fs::write(
            portable.path().join("documents/request.yaml"),
            "purr: 999\nkind: http",
        )
        .unwrap();
        assert!(inspect_project_directory(data.path(), manifest.to_str().unwrap(), true).is_err());
    }
    #[test]
    fn invalid_folders_and_private_storage_are_rejected_without_registration() {
        let data = tempfile::tempdir().unwrap();
        let invalid = tempfile::tempdir().unwrap();
        let storage = storage(data.path());
        assert!(directory_candidate(data.path(), invalid.path().to_str().unwrap()).is_err());
        for manifest in [
            "not: [yaml",
            "purr: 999\nworkspace: {id: portable, name: Portable}",
            "purr: 2\nworkspace: {id: ../escape, name: Invalid}",
            "purr: 2\nworkspace: {id: portable, name: Portable}\ndefaults: {auth: invalid}",
        ] {
            fs::write(invalid.path().join("purr.yaml"), manifest).unwrap();
            assert!(directory_candidate(data.path(), invalid.path().to_str().unwrap()).is_err());
        }
        fixture(data.path());
        assert!(directory_candidate(data.path(), data.path().to_str().unwrap()).is_err());
        assert!(storage.local.workspaces().unwrap().is_empty());
    }
}

/// Resolve registered roots without holding the SQLite lock during Git/network I/O.
pub(crate) fn git_context(app:&tauri::AppHandle,id:&str)->Result<(PathBuf,Option<Value>),String>{
    valid_id(id)?;
    access(app,&app.state::<PersistenceState>(),|storage|{
        storage.recover_before_commit()?;
        let root=storage.roots.get(id).cloned().ok_or("The workspace project directory is not registered")?;
        if !root.is_dir(){return Err("The workspace directory is missing. Restore it before continuing.".into());}
        let checkpoint=storage.local.read_partial(id)?.0.into_iter().find(|r|r.table=="workspace_local_state"&&r.id=="git-operation").map(|r|r.value);
        Ok((root,checkpoint))
    })
}
pub(crate) fn git_journal(app:&tauri::AppHandle,id:&str,value:Option<Value>)->Result<(),String>{
    access(app,&app.state::<PersistenceState>(),|storage|{
        storage.recover_before_commit()?;
        storage.local.write(id,&[LocalRecord{table:"workspace_local_state".into(),id:"git-operation".into(),value:value.unwrap_or(Value::Null),protection:super::local_records::RecordProtection::Encrypted}])
    })
}
pub(crate) fn check_project_destination(app:&tauri::AppHandle,path:&Path)->Result<(),String>{
    let data=data_directory(app).map_err(|e|e.to_string())?;
    if path.starts_with(&data)||data.starts_with(path){return Err("Choose a project directory outside Purr's private application storage".into());}
    access(app,&app.state::<PersistenceState>(),|storage|{
        if storage.roots.values().any(|root|path.starts_with(root)||root.starts_with(path)){return Err("Choose a directory outside existing workspaces".into());}Ok(())
    })
}
pub(crate) fn check_clone_identity(app:&tauri::AppHandle,id:&str,path:&Path)->Result<(),String>{
    valid_id(id)?;
    access(app,&app.state::<PersistenceState>(),|storage|{
        if storage.local.workspaces()?.iter().any(|(owner,_)|owner==id)||storage.roots.contains_key(id){return Err("This workspace identity is already open. Select the existing workspace instead of cloning another copy.".into());}
        workspace_cleanup::ensure_available(&storage.local,id,path)
    })
}

#[derive(serde::Deserialize)]
#[serde(tag="type",rename_all="camelCase",deny_unknown_fields)]
pub enum DirectoryAction {
    Info,
    Create { directory:String, files:Vec<FileChange>, local:Vec<LocalRecord>, secrets:SecretBatch },
}
pub fn project_directory(app:tauri::AppHandle,id:String,action:DirectoryAction)->Result<Value,String>{
    valid_id(&id)?;crate::git::native::ensure_idle(&app,&id)?;
    access(&app,&app.state::<PersistenceState>(),|storage|match action {
        DirectoryAction::Info=>{let directory=storage.files(&id)?.directory;Ok(json!({"directory":directory,"managed":directory==storage.projects.join(&id)}))},
        DirectoryAction::Create{directory,files,local,secrets}=>{
            if storage.roots.contains_key(&id)||storage.local.workspaces()?.iter().any(|(owner,_)|owner==&id){return Err("This workspace already has a project directory".into());}
            let selected=PathBuf::from(directory);
            if selected==storage.projects.join(&id){fs::create_dir_all(&storage.projects).map_err(|_|"Cannot create projects directory")?;}
            let parent=selected.parent().filter(|p|p.is_dir()).ok_or("Choose a project directory with an existing parent folder")?;
            let parent=fs::canonicalize(parent).map_err(|_|"Cannot access the project directory")?;
            let name=selected.file_name().ok_or("Choose a project directory")?;
            let target=parent.join(name);
            let data=fs::canonicalize(&storage.data).unwrap_or(storage.data.clone());
            let managed=fs::canonicalize(&storage.projects).unwrap_or(storage.projects.clone()).join(&id);
            if (target.starts_with(&data)||data.starts_with(&target))&&target!=managed{return Err("Choose a project directory outside private application storage".into());}
            if storage.roots.values().any(|root|target.starts_with(root)||root.starts_with(&target)){return Err("Project directories cannot overlap another workspace".into());}
            if fs::symlink_metadata(&target).is_ok_and(|meta|meta.file_type().is_symlink())||target.exists()&&(!target.is_dir()||fs::read_dir(&target).map_err(|_|"Cannot read project directory")?.next().is_some()){return Err("Choose a new or empty project directory. Use Import to open an existing project.".into());}
            let contents:BTreeMap<String,ProjectFile>=files.iter().filter_map(|file|file.content.as_ref().map(|content|(file.path.clone(),ProjectFile{content:content.clone(),revision:String::new()}))).collect();
            crate::transfer::validate_project_files(&contents,&id)?;
            if files.iter().any(|file|file.expected_revision.is_some()){return Err("New project files cannot overwrite existing revisions".into());}
            storage.recover_before_commit()?;workspace_cleanup::ensure_available(&storage.local,&id,&target)?;
            storage.local.prepare_workspace_keys(&id)?;
            let store=FilesystemWorkspaceStore{directory:target.clone()};
            commit_coordinator::commit(&mut storage.local,&store,&id,&files,&local,&secrets)?;
            storage.watch(&id,target)?;storage.workspace(&id)
        }
    })
}
