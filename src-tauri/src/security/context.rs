//! One profile resolver and key manager for every native storage consumer.
use super::{manager::KeyManager, ProtectedError, RootCiphers};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::Manager;

#[derive(Default)]
pub struct NativeKeyState(Mutex<Option<Arc<KeyManager>>>);

/// Tauri already scopes this directory by the host bundle identifier. Build
/// optimization must not select a different vault for the same application.
pub fn data_directory(app: &tauri::AppHandle) -> Result<PathBuf, ProtectedError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| ProtectedError::unavailable("storage-directory-unavailable"))?;
    super::layout::prepare(&base)
}

impl NativeKeyState {
    fn manager(&self, app: &tauri::AppHandle) -> Result<Arc<KeyManager>, ProtectedError> {
        let mut manager = self
            .0
            .lock()
            .map_err(|_| ProtectedError::unavailable("root-manager-unavailable"))?;
        if let Some(manager) = manager.as_ref() {
            return Ok(manager.clone());
        }
        let manager_value = Arc::new(KeyManager::new(
            data_directory(app)?,
            app.config().identifier.clone(),
            "application-v2".into(),
            false,
        ));
        *manager = Some(manager_value.clone());
        Ok(manager_value)
    }

    pub fn open(&self, app: &tauri::AppHandle) -> Result<Arc<RootCiphers>, ProtectedError> {
        self.manager(app)?.open_scoped()
    }

    pub fn retry(&self, app: &tauri::AppHandle) -> Result<Arc<RootCiphers>, ProtectedError> {
        self.manager(app)?.retry_scoped()
    }
}
