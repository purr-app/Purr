use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

#[derive(Default)]
pub struct WorkspaceStorage(Mutex<()>);

fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("workspaces"))
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Invalid workspace identifier".into());
    }
    Ok(())
}

fn read_json(path: &Path) -> Result<Value, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "Cannot parse {}: {error}. The original file has not been changed.",
            path.display()
        )
    })
}

fn atomic_json(path: &Path, value: &Value) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("Invalid workspace path")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())?;
    Ok(())
}

fn load(root: &Path) -> Result<Value, String> {
    if !root.exists() {
        return Ok(json!({ "activeWorkspaceId": "", "workspaces": [] }));
    }
    let mut workspaces = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        let path = entry.path().join("workspace.json");
        if path.exists() {
            let workspace = read_json(&path)?;
            if workspace["id"].as_str() != entry.file_name().to_str() {
                return Err("Workspace folder and identifier do not match".into());
            }
            workspaces.push(workspace);
        }
    }
    workspaces.sort_by_key(|workspace| workspace["name"].as_str().unwrap_or("").to_lowercase());
    let index = root.join("index.json");
    let active = if index.exists() {
        read_json(&index)?["activeWorkspaceId"].clone()
    } else {
        Value::Null
    };
    Ok(json!({ "activeWorkspaceId": active, "workspaces": workspaces }))
}

#[tauri::command]
pub fn load_workspace_store(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceStorage>,
) -> Result<Value, String> {
    let _guard = state.0.lock().map_err(|error| error.to_string())?;
    load(&root(&app)?)
}

#[tauri::command]
pub fn save_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceStorage>,
    workspace: Value,
) -> Result<(), String> {
    let _guard = state.0.lock().map_err(|error| error.to_string())?;
    let id = workspace["id"]
        .as_str()
        .ok_or("Workspace identifier is required")?;
    valid_id(id)?;
    if workspace["schemaVersion"] != 1
        || !workspace["documents"].is_array()
        || !workspace["environments"].is_array()
        || !workspace["ui"].is_object()
    {
        return Err("Unsupported workspace format".into());
    }
    atomic_json(&root(&app)?.join(id).join("workspace.json"), &workspace)
}

#[tauri::command]
pub fn set_active_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceStorage>,
    id: String,
) -> Result<(), String> {
    let _guard = state.0.lock().map_err(|error| error.to_string())?;
    valid_id(&id)?;
    let root = root(&app)?;
    if !root.join(&id).join("workspace.json").exists() {
        return Err("Workspace does not exist".into());
    }
    atomic_json(
        &root.join("index.json"),
        &json!({ "schemaVersion": 1, "activeWorkspaceId": id }),
    )
}

#[tauri::command]
pub fn open_workspace_folder(app: tauri::AppHandle, id: String) -> Result<(), String> {
    valid_id(&id)?;
    let path = root(&app)?.join(id);
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifiers_cannot_escape_workspace_root() {
        for id in ["", "..", "../other", "/tmp", "a/b", "a\\b"] {
            assert!(valid_id(id).is_err());
        }
        assert!(valid_id("personal").is_ok());
    }
    #[test]
    fn disk_roundtrip_keeps_workspaces_separate() {
        let root = std::env::temp_dir().join(format!(
            "purr-workspace-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for id in ["personal", "team"] {
            atomic_json(&root.join(id).join("workspace.json"), &json!({"id":id,"name":id,"schemaVersion":1,"documents":[],"environments":[],"ui":{}})).unwrap();
        }
        atomic_json(
            &root.join("index.json"),
            &json!({"activeWorkspaceId":"team"}),
        )
        .unwrap();
        let restored = load(&root).unwrap();
        assert_eq!(restored["activeWorkspaceId"], "team");
        assert_eq!(restored["workspaces"].as_array().unwrap().len(), 2);
        atomic_json(&root.join("personal").join("workspace.json"), &json!({"id":"personal","name":"Renamed","schemaVersion":1,"documents":[{"id":"request"}],"environments":[],"ui":{}})).unwrap();
        let updated = load(&root).unwrap();
        let personal = updated["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .find(|workspace| workspace["id"] == "personal")
            .unwrap();
        assert_eq!(personal["name"], "Renamed");
        assert_eq!(personal["documents"][0]["id"], "request");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(root.join("personal/workspace.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
}
