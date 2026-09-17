use aes_gcm::aead::rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime},
};
use tauri::Manager;

const MAX_REQUEST_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_APPEND_BYTES: usize = 1024 * 1024;
const STAGING_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequestFileRef {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub media_type: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RequestBodySource {
    File { reference: RequestFileRef },
    Multipart { parts: Vec<RequestBodyPart> },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RequestBodyPart {
    Text {
        name: String,
        value: String,
        media_type: String,
    },
    File {
        name: String,
        reference: RequestFileRef,
    },
}

#[derive(Clone)]
struct RequestFileEntry {
    reference: RequestFileRef,
    path: PathBuf,
    written: u64,
    complete: bool,
    created_at: SystemTime,
}

struct RequestFileStore {
    directory: PathBuf,
    entries: HashMap<String, RequestFileEntry>,
}

impl RequestFileStore {
    fn open(directory: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&directory).map_err(|_| "Cannot create request body storage")?;
        for entry in fs::read_dir(&directory).map_err(|_| "Cannot inspect request body storage")? {
            let entry = entry.map_err(|_| "Cannot inspect request body storage")?;
            let file_type = entry
                .file_type()
                .map_err(|_| "Cannot inspect request body storage")?;
            if !file_type.is_dir()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("request-file-")
            {
                fs::remove_file(entry.path())
                    .map_err(|_| "Cannot clean abandoned request body storage")?;
            }
        }
        Ok(Self {
            directory,
            entries: HashMap::new(),
        })
    }

    fn cleanup(&mut self) {
        let expired: Vec<String> = self
            .entries
            .iter()
            .filter_map(|(id, entry)| {
                entry
                    .created_at
                    .elapsed()
                    .ok()
                    .filter(|age| *age > STAGING_TTL)
                    .map(|_| id.clone())
            })
            .collect();
        for id in expired {
            self.release(&id);
        }
    }

    fn create(
        &mut self,
        name: String,
        size: u64,
        media_type: String,
    ) -> Result<RequestFileRef, String> {
        self.cleanup();
        if size > MAX_REQUEST_FILE_BYTES {
            return Err("Request file exceeds the 4 GiB staging limit.".into());
        }
        let name: String = name
            .chars()
            .filter(|character| !character.is_control())
            .take(255)
            .collect();
        if name.trim().is_empty() {
            return Err("Request file name is empty.".into());
        }
        let media_type =
            if media_type.is_empty() || media_type.len() > 255 || media_type.contains(['\r', '\n'])
            {
                "application/octet-stream".into()
            } else {
                media_type
            };
        let mut random = [0_u8; 16];
        OsRng.fill_bytes(&mut random);
        let id = format!(
            "request-file-{}",
            random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        let path = self.directory.join(&id);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(&path)
            .map_err(|_| "Cannot create staged request file")?;
        let reference = RequestFileRef {
            id: id.clone(),
            name,
            size,
            media_type,
        };
        self.entries.insert(
            id,
            RequestFileEntry {
                reference: reference.clone(),
                path,
                written: 0,
                complete: false,
                created_at: SystemTime::now(),
            },
        );
        Ok(reference)
    }

    fn append(&mut self, id: &str, offset: u64, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > MAX_APPEND_BYTES {
            return Err("Request file chunk exceeds the 1 MiB limit.".into());
        }
        let entry = self
            .entries
            .get_mut(id)
            .ok_or("Request file handle is stale.")?;
        if entry.complete {
            return Err("Request file is already complete.".into());
        }
        if entry.written != offset {
            return Err("Request file chunks are out of order.".into());
        }
        let next = entry
            .written
            .checked_add(bytes.len() as u64)
            .ok_or("Request file is too large.")?;
        if next > entry.reference.size {
            return Err("Request file contains more bytes than declared.".into());
        }
        let mut file = OpenOptions::new()
            .append(true)
            .open(&entry.path)
            .map_err(|_| "Cannot open staged request file")?;
        file.write_all(bytes)
            .map_err(|_| "Cannot stage request file")?;
        entry.written = next;
        Ok(())
    }

    fn finish(&mut self, reference: &RequestFileRef) -> Result<RequestFileRef, String> {
        let entry = self
            .entries
            .get_mut(&reference.id)
            .ok_or("Request file handle is stale.")?;
        if &entry.reference != reference {
            return Err("Request file metadata does not match its handle.".into());
        }
        if entry.written != entry.reference.size {
            return Err("Request file is incomplete.".into());
        }
        entry.complete = true;
        Ok(entry.reference.clone())
    }

    fn resolve(&mut self, reference: &RequestFileRef) -> Result<PathBuf, String> {
        self.cleanup();
        let entry = self
            .entries
            .get(reference.id.as_str())
            .ok_or("Request file handle is stale.")?;
        if !entry.complete || &entry.reference != reference {
            return Err("Request file handle is incomplete or invalid.".into());
        }
        let actual =
            fs::metadata(&entry.path).map_err(|_| "Staged request file is unavailable.")?;
        if !actual.is_file() || actual.len() != reference.size {
            return Err("Staged request file changed unexpectedly.".into());
        }
        Ok(entry.path.clone())
    }

    fn release(&mut self, id: &str) {
        if let Some(entry) = self.entries.remove(id) {
            let _ = fs::remove_file(entry.path);
        }
    }
}

#[derive(Default)]
pub struct RequestFileState(Mutex<Option<RequestFileStore>>);

impl RequestFileState {
    fn access<T>(
        &self,
        app: &tauri::AppHandle,
        operation: impl FnOnce(&mut RequestFileStore) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self
            .0
            .lock()
            .map_err(|_| "Request file storage is unavailable")?;
        if guard.is_none() {
            let cache = app
                .path()
                .app_cache_dir()
                .map_err(|_| "Cannot locate request body storage")?;
            *guard = Some(RequestFileStore::open(cache.join("request-bodies"))?);
        }
        operation(
            guard
                .as_mut()
                .ok_or("Request file storage is unavailable")?,
        )
    }

    pub fn resolve(
        &self,
        app: &tauri::AppHandle,
        reference: &RequestFileRef,
    ) -> Result<PathBuf, String> {
        self.access(app, |store| store.resolve(reference))
    }

    pub fn create(
        &self,
        app: &tauri::AppHandle,
        name: String,
        size: u64,
        media_type: String,
    ) -> Result<RequestFileRef, String> {
        self.access(app, |store| store.create(name, size, media_type))
    }

    pub fn stage(
        &self,
        app: &tauri::AppHandle,
        name: String,
        media_type: String,
        bytes: &[u8],
    ) -> Result<RequestFileRef, String> {
        self.access(app, |store| {
            let reference = store.create(name, bytes.len() as u64, media_type)?;
            let result = (|| {
                for (index, chunk) in bytes.chunks(MAX_APPEND_BYTES).enumerate() {
                    store.append(&reference.id, (index * MAX_APPEND_BYTES) as u64, chunk)?;
                }
                store.finish(&reference)
            })();
            if result.is_err() {
                store.release(&reference.id);
            }
            result
        })
    }

    pub fn append(
        &self,
        app: &tauri::AppHandle,
        id: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<(), String> {
        self.access(app, |store| store.append(id, offset, bytes))
    }

    pub fn finish(
        &self,
        app: &tauri::AppHandle,
        reference: &RequestFileRef,
    ) -> Result<RequestFileRef, String> {
        self.access(app, |store| store.finish(reference))
    }

    pub fn release(
        &self,
        app: &tauri::AppHandle,
        reference: &RequestFileRef,
    ) -> Result<(), String> {
        self.access(app, |store| {
            store.release(&reference.id);
            Ok(())
        })
    }
}

pub fn stream_file(path: &Path) -> Result<reqwest::Body, String> {
    let file = std::fs::File::open(path).map_err(|_| "Cannot open staged request file")?;
    let stream = tokio_util::io::ReaderStream::new(tokio::fs::File::from_std(file));
    Ok(reqwest::Body::wrap_stream(stream))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typescript_multipart_contract_accepts_camel_case_part_fields() {
        let source: RequestBodySource = serde_json::from_value(serde_json::json!({
            "kind": "multipart",
            "parts": [
                { "kind": "text", "name": "name", "value": "test", "mediaType": "text/plain" },
                { "kind": "file", "name": "file", "reference": {
                    "id": "request-file-1", "name": "payload.bin", "size": 4,
                    "mediaType": "application/octet-stream"
                }}
            ]
        }))
        .unwrap();
        let RequestBodySource::Multipart { parts } = source else {
            panic!("expected multipart source")
        };
        assert!(matches!(
            &parts[0],
            RequestBodyPart::Text { media_type, .. } if media_type == "text/plain"
        ));
    }

    #[test]
    fn staged_files_are_byte_exact_repeatable_and_released() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RequestFileStore::open(directory.path().into()).unwrap();
        let reference = store
            .create("payload.bin".into(), 6, "application/octet-stream".into())
            .unwrap();
        store.append(&reference.id, 0, &[0, 1, 2]).unwrap();
        assert!(store.append(&reference.id, 2, &[3]).is_err());
        store.append(&reference.id, 3, &[3, 254, 255]).unwrap();
        store.finish(&reference).unwrap();
        let first = store.resolve(&reference).unwrap();
        let second = store.resolve(&reference).unwrap();
        assert_eq!(first, second);
        assert_eq!(fs::read(&first).unwrap(), [0, 1, 2, 3, 254, 255]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&first).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        store.release(&reference.id);
        assert!(!first.exists());
        assert!(store.resolve(&reference).is_err());
    }

    #[test]
    fn incomplete_and_mismatched_handles_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RequestFileStore::open(directory.path().into()).unwrap();
        let reference = store
            .create("payload.bin".into(), 2, "application/octet-stream".into())
            .unwrap();
        store.append(&reference.id, 0, &[1]).unwrap();
        assert!(store.finish(&reference).is_err());
        assert!(store.resolve(&reference).is_err());
        let mut changed = reference.clone();
        changed.name = "other.bin".into();
        assert!(store.finish(&changed).is_err());
    }

    #[test]
    fn startup_removes_abandoned_request_files() {
        let directory = tempfile::tempdir().unwrap();
        let orphan = directory.path().join("request-file-abandoned");
        fs::write(&orphan, b"synthetic").unwrap();
        let _store = RequestFileStore::open(directory.path().into()).unwrap();
        assert!(!orphan.exists());
    }
}
