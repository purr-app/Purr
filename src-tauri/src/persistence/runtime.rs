use crate::{
    persistence::{
        local_records::{LocalAttachment, LocalRecord, LocalStateStore},
        project_files::{FileChange, FilesystemWorkspaceStore, ProjectFile},
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
        let local =
            LocalStateStore::open(&data.join("local-state.sqlite3"), &PlatformRootKeyStore)?;
        let (sender, receiver) = mpsc::channel();
        let watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })
        .map_err(|_| "Cannot watch project directory")?;
        let handle = app.clone();
        std::thread::spawn(move || {
            while let Ok(first) = receiver.recv() {
                let mut paths = Vec::new();
                let mut rescan = false;
                match first {
                    Ok(event) if !matches!(event.kind, notify::EventKind::Access(_)) => {
                        rescan |= event.need_rescan();
                        paths.extend(event.paths);
                    }
                    Err(_) => rescan = true,
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
        for (id, directory) in result.local.workspaces()? {
            result.watch(&id, PathBuf::from(directory))?;
        }
        result.recover()?;
        Ok(result)
    }
    fn recover(&mut self) -> Result<(), String> {
        for (id, pending) in self.local.pending()? {
            let files: Vec<FileChange> = serde_json::from_value(pending["files"].clone())
                .map_err(|_| "Damaged pending project commit")?;
            let local: Vec<LocalRecord> = serde_json::from_value(pending["local"].clone())
                .map_err(|_| "Damaged pending project commit")?;
            let store = self.files(&id)?;
            store.preflight(&files, true)?;
            store.apply(&files)?;
            self.local.write(&id, &local)?;
        }
        Ok(())
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
    fn workspace(&self, id: &str) -> Result<Value, String> {
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
        storage.local.set_secret(&reference, &value)
    })
}

pub fn secure_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    reference: String,
) -> Result<(), String> {
    access(&app, &state, |storage| {
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
) -> Result<BTreeMap<String, Option<ProjectFile>>, String> {
    access(&app, &state, |storage| {
        storage.recover()?;
        let store = storage.files(&id)?;
        store.preflight(&files, false)?;
        storage.local.register(&id, &store.directory)?;
        storage.watch(&id, store.directory.clone())?;
        if !files.is_empty() {
            storage
                .local
                .journal(&id, &json!({ "files":files, "local":local }))?;
        }
        store.apply(&files)?;
        storage.local.write(&id, &local)?;
        files
            .iter()
            .map(|change| Ok((change.path.clone(), store.read(&change.path)?)))
            .collect()
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
) -> Result<(), String> {
    access(&app, &state, |storage| {
        storage.local.write("__global__", &local)
    })
}

pub fn delete_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    id: String,
) -> Result<(), String> {
    valid_id(&id)?;
    access(&app, &state, |storage| {
        let directory = storage
            .roots
            .remove(&id)
            .unwrap_or_else(|| storage.projects.join(&id));
        let managed_directory = directory == storage.projects.join(&id);
        let _ = storage.watcher.unwatch(&directory);
        storage.local.delete_workspace(&id)?;
        if managed_directory && directory.exists() {
            fs::remove_dir_all(&directory).map_err(|_| "Cannot delete workspace directory")?;
        }
        Ok(())
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
        // Registration follows successful frontend validation via a separate commit.
        storage.watch(&id, path)?;
        storage.workspace(&id)
    })
}

#[cfg(test)]
mod watcher_tests {
    use super::project_change_paths;
    use std::path::PathBuf;

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
