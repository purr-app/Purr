use crate::{
    content::actor::ResponseContentState,
    http::{
        perform_http_with_files, request_body::RequestFileRef, HttpEvent, HttpRequest,
        HttpResponse, HttpRuntimeState,
    },
    persistence::{runtime as persistence_runtime, PersistenceState},
};
use std::time::Instant;
use tauri::{ipc::Channel, Manager};

fn header<'a>(request: &'a tauri::ipc::Request<'_>, name: &str) -> Result<&'a str, String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| format!("Missing {name} header"))
}

#[tauri::command(async)]
pub fn request_file_create(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, HttpRuntimeState>,
    name: String,
    size: u64,
    media_type: String,
) -> Result<RequestFileRef, String> {
    state.request_files.create(
        &app,
        &super::attachment::upload_owner(&app, &window),
        name,
        size,
        media_type,
    )
}

#[tauri::command(async)]
pub fn request_file_append(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, HttpRuntimeState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let id = header(&request, "x-purr-file-id")?.to_string();
    let offset = header(&request, "x-purr-file-offset")?
        .parse::<u64>()
        .map_err(|_| "Invalid request file offset")?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        _ => return Err("Request file chunks must use binary IPC.".into()),
    };
    state
        .request_files
        .append(&app, window.label(), &id, offset, bytes)
}

#[tauri::command(async)]
pub fn request_file_finish(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, HttpRuntimeState>,
    reference: RequestFileRef,
) -> Result<RequestFileRef, String> {
    state.request_files.finish(&app, window.label(), &reference)
}

#[tauri::command(async)]
pub fn request_file_release(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, HttpRuntimeState>,
    reference: RequestFileRef,
) -> Result<(), String> {
    state
        .request_files
        .release(&app, window.label(), &reference)
}

#[tauri::command(async)]
pub fn request_file_from_attachment(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    http: tauri::State<'_, HttpRuntimeState>,
    persistence: tauri::State<'_, PersistenceState>,
    workspace_id: String,
    attachment_id: String,
) -> Result<RequestFileRef, String> {
    let owner = super::attachment::upload_owner(&app, &window);
    let attachment =
        persistence_runtime::prepare_attachment(&app, &persistence, &workspace_id, &attachment_id)?;
    http.request_files
        .attachment(&app, &owner, &workspace_id, attachment)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn start_http(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    operation_id: String,
    mut request: HttpRequest,
    on_event: Channel<HttpEvent>,
    http: tauri::State<'_, HttpRuntimeState>,
    content: tauri::State<'_, ResponseContentState>,
    observability: tauri::State<'_, crate::observability::ObservabilityState>,
) -> Result<HttpResponse, String> {
    let command_started = Instant::now();
    let owner = super::attachment::upload_owner(&app, &window);
    request.prepare_trace(observability.service.propagators())?;
    let cancellation = http.request_files.while_open(&owner, || {
        if app.get_webview_window(&owner).is_none() {
            return Err("Request window closed".into());
        }
        http.operations.register(&operation_id)
    })?;
    let content = match content.handle(&app) {
        Ok(content) => content,
        Err(error) => {
            http.operations.finish(&operation_id);
            return Err(error);
        }
    };
    let setup = command_started.elapsed();
    let app_for_files = app.clone();
    let workspace = request.workspace_id().to_string();
    let mut result = perform_http_with_files(
        request,
        &http.client.0,
        &content,
        &|reference| {
            http.request_files
                .body(&app_for_files, &owner, &workspace, reference)
        },
        cancellation,
        |event| {
            let _ = on_event.send(event);
        },
    )
    .await;
    if let Ok(response) = &mut result {
        response.include_setup_timing(setup);
    }
    http.operations.finish(&operation_id);
    result
}

#[tauri::command]
pub fn cancel_http(
    operation_id: String,
    http: tauri::State<'_, HttpRuntimeState>,
) -> Result<(), String> {
    http.operations.cancel(&operation_id)
}
