use crate::persistence::{
    local_records::LocalRecord,
    project_files::{FileChange, ProjectFile},
    runtime, PersistenceState,
};
use serde_json::Value;
use std::collections::BTreeMap;

#[tauri::command]
pub fn secure_get(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    reference: String,
) -> Result<Option<String>, String> {
    runtime::secure_get(app, state, reference)
}
#[tauri::command]
pub fn secure_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    reference: String,
    value: String,
) -> Result<(), String> {
    runtime::secure_set(app, state, reference, value)
}
#[tauri::command]
pub fn secure_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    reference: String,
) -> Result<(), String> {
    runtime::secure_delete(app, state, reference)
}
#[tauri::command]
pub fn secure_exists(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    reference: String,
) -> Result<bool, String> {
    runtime::secure_exists(app, state, reference)
}
#[tauri::command]
pub fn load_persistence(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
) -> Result<Value, String> {
    runtime::load_persistence(app, state)
}
#[tauri::command]
pub fn load_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    id: String,
) -> Result<Value, String> {
    runtime::load_project(app, state, id)
}

#[tauri::command]
pub fn read_local_attachment(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    workspace_id: String,
    attachment_id: String,
) -> Result<tauri::ipc::Response, String> {
    let attachment = runtime::read_attachment(app, state, workspace_id, attachment_id)?;
    Ok(tauri::ipc::Response::new(attachment.bytes))
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
    runtime::list_request_history(app, state, id, document, before, limit)
}
#[tauri::command]
pub fn reload_project_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    id: String,
    path: String,
) -> Result<Option<ProjectFile>, String> {
    runtime::reload_project_file(app, state, id, path)
}
#[tauri::command]
pub fn commit_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    id: String,
    files: Vec<FileChange>,
    local: Vec<LocalRecord>,
) -> Result<BTreeMap<String, Option<ProjectFile>>, String> {
    runtime::commit_project(app, state, id, files, local)
}
#[tauri::command]
pub fn set_local_active_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    id: String,
) -> Result<(), String> {
    runtime::set_local_active_workspace(app, state, id)
}
#[tauri::command]
pub fn write_global_state(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    local: Vec<LocalRecord>,
) -> Result<(), String> {
    runtime::write_global_state(app, state, local)
}
#[tauri::command]
pub fn delete_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    id: String,
) -> Result<(), String> {
    runtime::delete_project(app, state, id)
}
#[tauri::command]
pub fn finish_legacy_migration(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
) -> Result<(), String> {
    runtime::finish_legacy_migration(app, state)
}
#[tauri::command]
pub fn open_project_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    id: String,
) -> Result<(), String> {
    runtime::open_project_folder(app, state, id)
}
#[tauri::command]
pub fn attach_project_directory(
    app: tauri::AppHandle,
    state: tauri::State<'_, PersistenceState>,
    id: String,
    directory: String,
) -> Result<Value, String> {
    runtime::attach_project_directory(app, state, id, directory)
}
