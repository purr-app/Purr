use crate::persistence::{
    attachments::{AttachmentMetadata, PreparedAttachment},
    runtime, PersistenceState,
};
use tauri::{
    ipc::{InvokeBody, Request},
    Manager,
};

fn owner(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> String {
    let label = window.label().to_string();
    let state = app.state::<crate::http::HttpRuntimeState>();
    if state.request_files.watch_window(&label) {
        let app = app.clone();
        let owner = label.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                app.state::<crate::http::HttpRuntimeState>()
                    .request_files
                    .clear_window(&owner);
                app.state::<crate::http::HttpRuntimeState>()
                    .operations
                    .cancel_all();
                let _ = runtime::release_attachment_owner(&app, &owner);
            }
        });
    }
    label
}
pub(crate) fn upload_owner(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> String {
    owner(app, window)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn attachment_begin(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, PersistenceState>,
    workspace_id: String,
    stage_id: String,
    name: String,
    media_type: String,
    size: u64,
    last_modified: u64,
) -> Result<(), String> {
    runtime::begin_attachment(
        &app,
        &state,
        &workspace_id,
        &owner(&app, &window),
        &stage_id,
        AttachmentMetadata {
            name,
            media_type,
            size,
            last_modified,
        },
    )
}
#[tauri::command(async)]
pub fn attachment_append(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, PersistenceState>,
    request: Request<'_>,
) -> Result<(), String> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| "Invalid attachment upload headers".to_string())
    };
    let workspace = header("x-purr-workspace")?;
    let stage = header("x-purr-stage")?;
    let index = header("x-purr-index")?
        .parse::<u64>()
        .map_err(|_| "Invalid attachment chunk index")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Attachment chunks require binary IPC".into());
    };
    runtime::append_attachment(
        &app,
        &state,
        workspace,
        &owner(&app, &window),
        stage,
        index,
        bytes,
    )
}
#[tauri::command(async)]
pub fn attachment_finish(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, PersistenceState>,
    workspace_id: String,
    stage_id: String,
) -> Result<PreparedAttachment, String> {
    runtime::finish_attachment(
        &app,
        &state,
        &workspace_id,
        &owner(&app, &window),
        &stage_id,
    )
}
#[tauri::command(async)]
pub fn attachment_abort(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, PersistenceState>,
    workspace_id: String,
    stage_id: String,
) -> Result<(), String> {
    runtime::abort_attachment(&app, &state, &workspace_id, window.label(), &stage_id)
}
