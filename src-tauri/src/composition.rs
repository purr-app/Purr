use crate::{commands, content::actor::ResponseContentState, http, oauth, persistence};

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
        .manage(http::HttpOperationState::default())
        .manage(oauth::OAuthCallbacks::default())
        .manage(persistence::PersistenceState::default())
        .manage(ResponseContentState::default())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            set_macos_app_icon();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::exit_app,
            commands::response::save_response_body,
            commands::response::response_content_inspect,
            commands::response::response_content_read_range,
            commands::response::response_content_read_lines,
            commands::response::response_content_release,
            commands::http::start_http,
            commands::http::cancel_http,
            commands::importing::import_collection,
            oauth::authorize_oauth,
            oauth::cancel_oauth,
            commands::persistence::load_persistence,
            commands::persistence::load_project,
            commands::persistence::list_request_history,
            commands::persistence::reload_project_file,
            commands::persistence::commit_project,
            commands::persistence::set_local_active_workspace,
            commands::persistence::write_global_state,
            commands::persistence::delete_project,
            commands::persistence::finish_legacy_migration,
            commands::persistence::open_project_folder,
            commands::persistence::attach_project_directory,
            commands::persistence::secure_get,
            commands::persistence::secure_set,
            commands::persistence::secure_delete,
            commands::persistence::secure_exists
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
