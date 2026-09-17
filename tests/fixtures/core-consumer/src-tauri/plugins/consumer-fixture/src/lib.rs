use tauri::{plugin::TauriPlugin, Runtime};

#[tauri::command]
fn ping() -> &'static str {
    "consumer native plugin ready"
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("consumer-fixture")
        .invoke_handler(tauri::generate_handler![ping])
        .build()
}
