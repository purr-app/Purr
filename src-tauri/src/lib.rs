mod downloads;
mod http;
mod local_state;
mod oauth;
mod persistence;
mod project_files;
mod secure_store;
mod workspaces;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
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
        .manage(persistence::PersistenceState::default())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            set_macos_app_icon();

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            exit_app,
            downloads::save_response_body,
            http::send_http,
            oauth::authorize_oauth,
            oauth::cancel_oauth,
            persistence::load_persistence,
            persistence::load_project,
            persistence::list_request_history,
            persistence::reload_project_file,
            persistence::commit_project,
            persistence::set_local_active_workspace,
            persistence::finish_legacy_migration,
            persistence::open_project_folder,
            persistence::attach_project_directory,
            persistence::secure_get,
            persistence::secure_set,
            persistence::secure_delete,
            persistence::secure_exists
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
