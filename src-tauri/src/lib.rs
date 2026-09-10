mod downloads;
mod http;
mod oauth;
mod workspaces;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg(target_os = "macos")]
fn set_macos_app_icon() {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let mtm = unsafe { MainThreadMarker::new_unchecked() };
    let app = NSApplication::sharedApplication(mtm);
    let data = NSData::with_bytes(include_bytes!("../icons/icon.png"));

    if let Some(app_icon) = NSImage::initWithData(NSImage::alloc(), &data) {
        unsafe { app.setApplicationIconImage(Some(&app_icon)) };
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(http::HttpClient::default())
        .manage(oauth::OAuthCallbacks::default())
        .manage(workspaces::WorkspaceStorage::default())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            set_macos_app_icon();

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            downloads::save_response_body,
            http::send_http,
            oauth::authorize_oauth,
            oauth::cancel_oauth,
            workspaces::load_workspace_store,
            workspaces::save_workspace,
            workspaces::set_active_workspace,
            workspaces::open_workspace_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
