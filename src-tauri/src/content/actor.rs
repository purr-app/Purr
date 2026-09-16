use super::{
    contracts::{
        ByteRange, ContentInfo, ContentMetadata, ContentOperationResult, ContentWindow,
        FormatRequest, JsonQueryRequest, LinePage, ResponseContentRef, SearchPage, SearchQuery,
    },
    store::{ContentWriteTiming, ResponseContentStore},
};
use crate::security::PlatformRootKeyStore;
use std::{
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Mutex},
};
use tauri::Manager;
use tokio::sync::{mpsc, oneshot};

type StoreJob = Box<dyn FnOnce(&mut ResponseContentStore) + Send>;

#[derive(Clone)]
pub struct ResponseContentHandle {
    sender: mpsc::Sender<StoreJob>,
}

pub struct PendingContentWrite(oneshot::Receiver<Result<ContentWriteTiming, String>>);

impl PendingContentWrite {
    pub async fn wait(self) -> Result<ContentWriteTiming, String> {
        self.0
            .await
            .map_err(|_| "Response storage worker stopped")?
    }
}

impl ResponseContentHandle {
    fn start(path: PathBuf) -> Result<Self, String> {
        Self::start_store(ResponseContentStore::open(&path, &PlatformRootKeyStore)?)
    }

    fn start_store(mut store: ResponseContentStore) -> Result<Self, String> {
        // The bounded queue is the backpressure boundary between async network
        // reads and blocking SQLite/encryption work.
        let (sender, mut receiver) = mpsc::channel::<StoreJob>(8);
        std::thread::Builder::new()
            .name("purr-response-content".into())
            .spawn(move || {
                while let Some(job) = receiver.blocking_recv() {
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
            .await
            .map_err(|_| "Response storage worker is unavailable")?;
        receiver
            .await
            .map_err(|_| "Response storage worker stopped")?
    }

    pub async fn create_staging(
        &self,
        metadata: ContentMetadata,
    ) -> Result<ResponseContentRef, String> {
        self.call(move |store| store.create_staging(metadata)).await
    }

    pub async fn enqueue_append(
        &self,
        id: String,
        bytes: Vec<u8>,
    ) -> Result<PendingContentWrite, String> {
        let (sender, receiver) = oneshot::channel();
        self.sender
            .send(Box::new(move |store| {
                let _ = sender.send(store.append(&id, &bytes));
            }))
            .await
            .map_err(|_| "Response storage worker is unavailable")?;
        Ok(PendingContentWrite(receiver))
    }

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

    pub async fn read_bytes_range(&self, id: String, range: ByteRange) -> Result<Vec<u8>, String> {
        self.call(move |store| store.read_bytes_range(&id, range))
            .await
    }

    pub async fn save_to_path(&self, id: String, path: &Path) -> Result<u64, String> {
        let path = path.to_path_buf();
        self.call(move |store| store.save_to_path(&id, &path)).await
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

    pub async fn search(
        &self,
        id: String,
        query: SearchQuery,
        cursor: Option<String>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<SearchPage, String> {
        self.call(move |store| store.search(&id, &query, cursor.as_deref(), &cancelled))
            .await
    }

    pub async fn format(
        &self,
        id: String,
        request: FormatRequest,
        cancelled: Arc<AtomicBool>,
    ) -> Result<ContentOperationResult, String> {
        self.call(move |store| store.format(&id, &request, &cancelled))
            .await
    }

    pub async fn query(
        &self,
        id: String,
        request: JsonQueryRequest,
        cancelled: Arc<AtomicBool>,
    ) -> Result<ContentOperationResult, String> {
        self.call(move |store| store.query(&id, &request, &cancelled))
            .await
    }

    pub async fn release(&self, id: String) -> Result<(), String> {
        self.call(move |store| store.release(&id)).await
    }
}

#[cfg(test)]
impl ResponseContentHandle {
    pub(crate) fn for_test(store: ResponseContentStore) -> Result<Self, String> {
        Self::start_store(store)
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
