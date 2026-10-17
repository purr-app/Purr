use crate::git::{native, Result};
use serde_json::Value;

#[tauri::command]
pub async fn git_workspace(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    workspace_id: String,
    operation_id: String,
    query: native::Query,
    on_event: Option<tauri::ipc::JavaScriptChannelId>,
) -> Result<Value> {
    native::git_workspace(webview, app, workspace_id, operation_id, query, on_event).await
}
#[tauri::command]
pub fn git_cancel(app: tauri::AppHandle, operation_id: String) -> Result<()> {
    native::git_cancel(app, operation_id)
}
#[tauri::command]
pub async fn git_clone(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    operation_id: String,
    url: String,
    directory: String,
    on_event: Option<tauri::ipc::JavaScriptChannelId>,
) -> Result<String> {
    native::git_clone(webview, app, operation_id, url, directory, on_event).await
}
