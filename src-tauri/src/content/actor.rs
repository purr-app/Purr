use super::{
    contracts::{
        ByteRange, ContentInfo, ContentMetadata, ContentWindow, LinePage, ResponseContentRef,
    },
    store::ResponseContentStore,
};
use crate::security::PlatformRootKeyStore;
use std::{
    path::PathBuf,
    sync::{mpsc, Mutex},
};
use tauri::Manager;
use tokio::sync::oneshot;

type StoreJob = Box<dyn FnOnce(&mut ResponseContentStore) + Send>;

#[derive(Clone)]
pub struct ResponseContentHandle {
    sender: mpsc::Sender<StoreJob>,
}

impl ResponseContentHandle {
    fn start(path: PathBuf) -> Result<Self, String> {
        let mut store = ResponseContentStore::open(&path, &PlatformRootKeyStore)?;
        let (sender, receiver) = mpsc::channel::<StoreJob>();
        std::thread::Builder::new()
            .name("purr-response-content".into())
            .spawn(move || {
                while let Ok(job) = receiver.recv() {
                    job(&mut store);
                }
            })
            .map_err(|_| "Cannot start response storage worker")?;
        Ok(Self { sender })
    }

    async fn call<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut ResponseContentStore) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let (sender, receiver) = oneshot::channel();
        self.sender
            .send(Box::new(move |store| {
                let _ = sender.send(operation(store));
            }))
            .map_err(|_| "Response storage worker is unavailable")?;
        receiver
            .await
            .map_err(|_| "Response storage worker stopped")?
    }

    #[allow(dead_code)] // Native HTTP starts using the writer API in Phase 6.
    pub async fn create_staging(
        &self,
        metadata: ContentMetadata,
    ) -> Result<ResponseContentRef, String> {
        self.call(move |store| store.create_staging(metadata)).await
    }

    #[allow(dead_code)]
    pub async fn append(&self, id: String, bytes: Vec<u8>) -> Result<(), String> {
        self.call(move |store| store.append(&id, &bytes)).await
    }

    #[allow(dead_code)]
    pub async fn finish(&self, id: String) -> Result<ResponseContentRef, String> {
        self.call(move |store| store.finish(&id)).await
    }

    pub async fn inspect(&self, id: String) -> Result<ContentInfo, String> {
        self.call(move |store| store.inspect(&id)).await
    }

    pub async fn read_range(
        &self,
        id: String,
        range: ByteRange,
        mode: String,
    ) -> Result<ContentWindow, String> {
        self.call(move |store| store.read_range(&id, range, &mode))
            .await
    }

    pub async fn read_lines(
        &self,
        id: String,
        cursor: Option<String>,
        limit: usize,
    ) -> Result<LinePage, String> {
        self.call(move |store| store.read_lines(&id, cursor.as_deref(), limit))
            .await
    }

    pub async fn release(&self, id: String) -> Result<(), String> {
        self.call(move |store| store.release(&id)).await
    }
}

#[derive(Default)]
pub struct ResponseContentState(Mutex<Option<ResponseContentHandle>>);

impl ResponseContentState {
    pub fn handle(&self, app: &tauri::AppHandle) -> Result<ResponseContentHandle, String> {
        let mut guard = self
            .0
            .lock()
            .map_err(|_| "Response storage is unavailable")?;
        if guard.is_none() {
            let data = app
                .path()
                .app_data_dir()
                .map_err(|_| "Cannot locate application storage")?;
            std::fs::create_dir_all(&data).map_err(|_| "Cannot create application storage")?;
            *guard = Some(ResponseContentHandle::start(
                data.join("local-state.sqlite3"),
            )?);
        }
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| "Response storage is unavailable".into())
    }
}
