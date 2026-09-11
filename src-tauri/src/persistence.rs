use crate::{
    local_state::{LocalRecord, LocalStateStore},
    project_files::{FileChange, FilesystemWorkspaceStore, ProjectFile},
    secure_store::PlatformRootKeyStore,
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::PathBuf,
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
                if let Ok(event) = first {
                    if !matches!(event.kind, notify::EventKind::Access(_)) {
                        paths.extend(event.paths);
                    }
                }
                while let Ok(event) = receiver.recv_timeout(Duration::from_millis(180)) {
                    if let Ok(event) = event {
                        if !matches!(event.kind, notify::EventKind::Access(_)) {
                            paths.extend(event.paths);
                        }
                    }
                }
                if !paths.is_empty() {
                    let state = handle.state::<PersistenceState>();
                    if let Ok(guard) = state.0.lock() {
                        if let Some(storage) = guard.as_ref() {
                            let changes: Vec<Value> = storage
                                .roots
                                .iter()
                                .filter_map(|(id, root)| {
                                    let relative: Vec<String> = paths
                                        .iter()
                                        .filter_map(|path| {
                                            path.strip_prefix(root).ok().map(|path| {
                                                path.to_string_lossy().replace('\\', "/")
                                            })
                                        })
                                        .filter_map(|path| {
                                            if path == "purr.yaml"
                                                || [
                                                    "requests",
                                                    "graphql",
                                                    "schemas",
                                                    "environments",
                                                    "folders",
                                                    "integrations",
                                                    "assets",
                                                ]
                                                .contains(&path.split('/').next().unwrap_or(""))
                                            {
                                                if path.ends_with(".yaml")
                                                    || path.ends_with(".graphql")
                                                    || path.ends_with(".bin")
                                                {
                                                    Some(path)
                                                } else if !path
                                                    .split('/')
                                                    .any(|part| part.starts_with('.'))
                                                    && !path.contains('.')
                                                {
                                                    Some("*".into())
                                                } else {
                                                    None
                                                }
                                            } else {
                                                None
                                            }
                                        })
                                        .collect();
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

#[tauri::command]
pub fn secure_get(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    reference: String,
) -> Result<Option<String>, String> {
    access(&app, &state, |storage| storage.local.get_secret(&reference))
}

#[tauri::command]
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

#[tauri::command]
pub fn secure_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    reference: String,
) -> Result<(), String> {
    access(&app, &state, |storage| {
        storage.local.delete_secret(&reference)
    })
}

#[tauri::command]
pub fn secure_exists(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    reference: String,
) -> Result<bool, String> {
    access(&app, &state, |storage| {
        storage.local.secret_exists(&reference)
    })
}
#[tauri::command]
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
            crate::workspaces::load_legacy(&storage.data.join("workspaces"))?
        } else {
            Value::Null
        };
        storage.migration_snapshot = (!legacy.is_null()).then(|| legacy.clone());
        Ok(
            json!({ "activeWorkspaceId": storage.local.app("active-workspace")?.unwrap_or_default(), "workspaces": workspaces, "legacy": legacy }),
        )
    })
}
#[tauri::command]
pub fn load_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    id: String,
) -> Result<Value, String> {
    access(&app, &state, |storage| storage.workspace(&id))
}

#[tauri::command]
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
#[tauri::command]
pub fn reload_project_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    id: String,
    path: String,
) -> Result<Option<ProjectFile>, String> {
    access(&app, &state, |storage| storage.files(&id)?.read(&path))
}
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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
            crate::workspaces::archive_and_retire(
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
#[tauri::command]
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
#[tauri::command]
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
