use crate::{
    content::actor::ResponseContentState,
    http::{perform_http, HttpClient, HttpEvent, HttpOperationState, HttpRequest, HttpResponse},
};
use std::time::Instant;
use tauri::ipc::Channel;

#[tauri::command]
pub async fn start_http(
    app: tauri::AppHandle,
    operation_id: String,
    request: HttpRequest,
    on_event: Channel<HttpEvent>,
    client: tauri::State<'_, HttpClient>,
    operations: tauri::State<'_, HttpOperationState>,
    content: tauri::State<'_, ResponseContentState>,
) -> Result<HttpResponse, String> {
    let command_started = Instant::now();
    let cancellation = operations.register(&operation_id)?;
    let content = match content.handle(&app) {
        Ok(content) => content,
        Err(error) => {
            operations.finish(&operation_id);
            return Err(error);
        }
    };
    let setup = command_started.elapsed();
    let mut result = perform_http(request, &client.0, &content, cancellation, |event| {
        let _ = on_event.send(event);
    })
    .await;
    if let Ok(response) = &mut result {
        response.include_setup_timing(setup);
    }
    operations.finish(&operation_id);
    result
}

#[tauri::command]
pub fn cancel_http(
    operation_id: String,
    operations: tauri::State<'_, HttpOperationState>,
) -> Result<(), String> {
    operations.cancel(&operation_id)
}
