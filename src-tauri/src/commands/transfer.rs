#[tauri::command]
pub async fn secret_transfer(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    action: crate::transfer::Action,
) -> Result<serde_json::Value, String> {
    let label = window.label().to_string();
    // Destroying the owner WebView drops all pending plaintext previews.
    let handle = app.clone();
    let owner = label.clone();
    use tauri::Manager;
    if app
        .state::<crate::transfer::TransferState>()
        .watch_window(&label)
    {
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                use tauri::Manager;
                handle
                    .state::<crate::transfer::TransferState>()
                    .clear_window(&owner);
            }
        });
    }
    tauri::async_runtime::spawn_blocking(move || crate::transfer::dispatch(&app, &label, action))
        .await
        .map_err(|_| "Secret transfer task failed".to_string())?
}
