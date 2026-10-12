use crate::{
    persistence::{
        commit_coordinator,
        local_records::{LocalAttachment, LocalRecord, LocalStateStore},
        project_files::{FileChange, FilesystemWorkspaceStore, ProjectFile},
        secret_commits::{OperationStatus, SecretBatch, SecretSnapshot},
        workspace_cleanup::{self, WorkspaceDeletionResult},
    },
    security::PlatformRootKeyStore,
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::{mpsc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use zeroize::Zeroizing;

#[derive(Default)]
pub struct PersistenceState(Mutex<Option<RuntimeStorage>>);
struct RuntimeStorage {
    local: LocalStateStore,
    roots: HashMap<String, PathBuf>,
    watcher: RecommendedWatcher,
    projects: PathBuf,
    data: PathBuf,
    migration_snapshot: Option<Value>,
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
    fn open(app: &tauri::AppHandle) -> Result<Self, String> {
        let data = app
            .path()
            .app_data_dir()
            .map_err(|_| "Cannot locate application storage")?;
        fs::create_dir_all(&data).map_err(|_| "Cannot create application storage")?;
        let root_keys = PlatformRootKeyStore::new(&data);
        let local = LocalStateStore::open(&data.join("local-state.sqlite3"), &root_keys)?;
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
            migration_snapshot: None,
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
        self.local.prune_history(id)?;
        Ok(json!({ "id": id, "files": self.files(id)?.load()?, "local": self.local.read(id)? }))
    }
}

fn access<T>(
    app: &tauri::AppHandle,
    state: &PersistenceState,
    call: impl FnOnce(&mut RuntimeStorage) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(|_| "Persistence is unavailable")?;
    if guard.is_none() {
        *guard = Some(RuntimeStorage::open(app)?);
    }
    call(guard.as_mut().ok_or("Persistence is unavailable")?)
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
    access(&app, &state, |storage| {
        let workspaces = storage
            .local
            .workspaces()?
            .iter()
            .map(|(id, _)| storage.workspace(id))
            .collect::<Result<Vec<_>, _>>()?;
        let legacy = if storage.local.app("legacy-migrated")?.is_none() {
            crate::persistence::legacy::load_legacy(&storage.data.join("workspaces"))?
        } else {
            Value::Null
        };
        storage.migration_snapshot = (!legacy.is_null()).then(|| legacy.clone());
        Ok(
            json!({ "activeWorkspaceId": storage.local.app("active-workspace")?.unwrap_or_default(), "workspaces": workspaces, "global": storage.local.read("__global__")?, "legacy": legacy }),
        )
    })
}
pub fn load_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    id: String,
) -> Result<Value, String> {
    access(&app, &state, |storage| storage.workspace(&id))
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
    access(&app, &state, |storage| storage.files(&id)?.read(&path))
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
    let batch = secrets
        .map(Ok)
        .unwrap_or_else(|| SecretBatch::fresh(vec![]))?;
    access(&app, &state, |storage| {
        storage.recover_before_commit()?;
        let store = storage.files(&id)?;
        workspace_cleanup::ensure_available(&storage.local, &id, &store.directory)?;
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
    access(&app, &state, |storage| {
        if storage.local.app("legacy-migrated")?.is_some() {
            return Ok(());
        }
        let expected = storage
            .migration_snapshot
            .as_ref()
            .ok_or("Load legacy data before completing migration")?;
        for workspace in expected["workspaces"]
            .as_array()
            .ok_or("Invalid legacy snapshot")?
        {
            let id = workspace["id"]
                .as_str()
                .ok_or("Invalid legacy workspace ID")?;
            if !storage
                .local
                .workspaces()?
                .iter()
                .any(|(registered, _)| registered == id)
                || storage.files(id)?.read("purr.yaml")?.is_none()
            {
                return Err(
                    "Legacy workspace has not been persisted; original files are preserved".into(),
                );
            }
        }
        let legacy_root = storage.data.join("workspaces");
        if legacy_root.exists() {
            let archive = storage.data.join("legacy-workspaces.encrypted");
            crate::persistence::legacy::archive_and_retire(
                &legacy_root,
                &archive,
                storage.local.cipher(),
                expected,
            )?;
        }
        storage.local.set_app("legacy-migrated", "1")?;
        storage.migration_snapshot = None;
        Ok(())
    })
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
    access(&app, &state, |storage| {
        let path = fs::canonicalize(directory).map_err(|_| "Project directory does not exist")?;
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
        storage.watch(&id, path)?;
        storage.workspace(&id)
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
            migration_snapshot: None,
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
