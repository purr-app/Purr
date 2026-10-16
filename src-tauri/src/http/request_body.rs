use super::upload_stream::{stream_reader, CHUNK_BYTES};
use crate::{persistence::attachments::AttachmentSource, security::LocalCipher};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};
use tauri::Manager;

const MAX_REQUEST_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
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

struct EncryptedFile {
    path: PathBuf,
    cipher: LocalCipher,
    context: String,
}
impl Drop for EncryptedFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
#[derive(Clone)]
enum Source {
    Temporary(Arc<EncryptedFile>),
    Attachment(AttachmentSource),
}
struct RequestFileEntry {
    reference: RequestFileRef,
    source: Source,
    written: u64,
    chunks: u64,
    complete: bool,
    created_at: SystemTime,
    owner: String,
    workspace: Option<String>,
}
struct RequestFileStore {
    directory: PathBuf,
    entries: HashMap<String, RequestFileEntry>,
}
fn file_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options
}
impl RequestFileStore {
    fn open(directory: PathBuf) -> Result<Self, String> {
        if let Ok(meta) = fs::symlink_metadata(&directory) {
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err("Invalid request body storage".into());
            }
        }
        fs::create_dir_all(&directory).map_err(|_| "Cannot create request body storage")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                .map_err(|_| "Cannot protect request body storage")?;
        }
        for entry in fs::read_dir(&directory).map_err(|_| "Cannot inspect request body storage")? {
            let entry = entry.map_err(|_| "Cannot inspect request body storage")?;
            if !entry
                .file_type()
                .map_err(|_| "Cannot inspect request body storage")?
                .is_dir()
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
        self.entries
            .retain(|_, e| e.created_at.elapsed().is_ok_and(|age| age <= STAGING_TTL));
    }
    fn create(
        &mut self,
        owner: &str,
        name: String,
        size: u64,
        media_type: String,
    ) -> Result<RequestFileRef, String> {
        self.cleanup();
        if size > MAX_REQUEST_FILE_BYTES {
            return Err("Request file exceeds the 4 GiB limit.".into());
        }
        if self.entries.len() >= 128 {
            return Err("Too many pending request files.".into());
        }
        let name: String = name.chars().filter(|c| !c.is_control()).take(255).collect();
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
        getrandom::fill(&mut random).map_err(|_| "Cannot generate request file ID")?;
        let id = format!(
            "request-file-{}",
            random
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        let path = self.directory.join(&id);
        let cipher = LocalCipher::ephemeral()?;
        let mut options = file_options();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(&path)
            .map_err(|_| "Cannot create request file")?;
        let reference = RequestFileRef {
            id: id.clone(),
            name,
            size,
            media_type,
        };
        self.entries.insert(
            id.clone(),
            RequestFileEntry {
                reference: reference.clone(),
                source: Source::Temporary(Arc::new(EncryptedFile {
                    path,
                    cipher,
                    context: format!("purr:upload:v1|{id}|{size}"),
                })),
                written: 0,
                chunks: 0,
                complete: false,
                created_at: SystemTime::now(),
                owner: owner.into(),
                workspace: None,
            },
        );
        Ok(reference)
    }
    fn entry(&mut self, owner: &str, id: &str) -> Result<&mut RequestFileEntry, String> {
        let entry = self
            .entries
            .get_mut(id)
            .ok_or("Request file handle is stale.")?;
        if entry.owner != owner {
            return Err("Request file belongs to another window.".into());
        }
        Ok(entry)
    }
    fn append(&mut self, owner: &str, id: &str, offset: u64, bytes: &[u8]) -> Result<(), String> {
        let entry = self.entry(owner, id)?;
        if entry.complete
            || offset != entry.written
            || bytes.is_empty()
            || bytes.len() > CHUNK_BYTES
            || entry.written + bytes.len() as u64 > entry.reference.size
        {
            return Err("Invalid request file chunk.".into());
        }
        let Source::Temporary(file) = &entry.source else {
            return Err("Request file is read-only.".into());
        };
        let encrypted = file
            .cipher
            .encrypt(bytes, &format!("{}|{}", file.context, entry.chunks))?;
        let mut output = file_options()
            .append(true)
            .open(&file.path)
            .map_err(|_| "Cannot open request file")?;
        output
            .write_all(&(encrypted.len() as u32).to_le_bytes())
            .and_then(|_| output.write_all(&encrypted))
            .map_err(|_| "Cannot stage request file")?;
        entry.written += bytes.len() as u64;
        entry.chunks += 1;
        Ok(())
    }
    fn finish(
        &mut self,
        owner: &str,
        reference: &RequestFileRef,
    ) -> Result<RequestFileRef, String> {
        let entry = self.entry(owner, &reference.id)?;
        if &entry.reference != reference || entry.written != reference.size {
            return Err("Request file is incomplete or invalid.".into());
        }
        entry.complete = true;
        Ok(entry.reference.clone())
    }
    fn attachment(
        &mut self,
        owner: &str,
        workspace: &str,
        source: AttachmentSource,
    ) -> Result<RequestFileRef, String> {
        // Allocate only an opaque registry ID, never a plaintext transport file.
        let reference = self.create(
            owner,
            source.name.clone(),
            source.byte_length,
            source.media_type.clone(),
        )?;
        let entry = self.entry(owner, &reference.id)?;
        entry.source = Source::Attachment(source);
        entry.written = reference.size;
        entry.complete = true;
        entry.workspace = Some(workspace.into());
        Ok(reference)
    }
    fn reader(
        &mut self,
        owner: &str,
        workspace: &str,
        reference: &RequestFileRef,
    ) -> Result<Box<dyn Read + Send>, String> {
        self.cleanup();
        let entry = self.entry(owner, &reference.id)?;
        if !entry.complete
            || &entry.reference != reference
            || entry.workspace.as_deref().is_some_and(|w| w != workspace)
        {
            return Err("Request file handle is incomplete or invalid.".into());
        }
        entry.workspace = Some(workspace.into());
        match &entry.source {
            Source::Attachment(source) => Ok(Box::new(source.open()?)),
            Source::Temporary(file) => {
                let input = file_options()
                    .read(true)
                    .open(&file.path)
                    .map_err(|_| "Request file is unavailable.")?;
                Ok(Box::new(EncryptedReader {
                    input,
                    lease: file.clone(),
                    buffer: zeroize::Zeroizing::new(Vec::new()),
                    position: 0,
                    index: 0,
                    chunks: entry.chunks,
                    remaining: reference.size,
                    ended: false,
                }))
            }
        }
    }
    fn release(&mut self, owner: &str, reference: &RequestFileRef) -> Result<(), String> {
        if let Some(entry) = self.entries.get(&reference.id) {
            if entry.owner != owner || &entry.reference != reference {
                return Err("Invalid request file owner or metadata.".into());
            }
        }
        self.entries.remove(&reference.id);
        Ok(())
    }
    fn clear_owner(&mut self, owner: &str) {
        self.entries.retain(|_, e| e.owner != owner);
    }
}

struct EncryptedReader {
    input: fs::File,
    lease: Arc<EncryptedFile>,
    buffer: zeroize::Zeroizing<Vec<u8>>,
    position: usize,
    index: u64,
    chunks: u64,
    remaining: u64,
    ended: bool,
}
impl Read for EncryptedReader {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() || self.ended {
            return Ok(0);
        }
        if self.position == self.buffer.len() {
            if self.index == self.chunks {
                let mut extra = [0];
                if self.remaining != 0 || self.input.read(&mut extra)? != 0 {
                    return Err(io::Error::other("Damaged upload"));
                }
                self.ended = true;
                return Ok(0);
            }
            let mut length = [0; 4];
            self.input.read_exact(&mut length)?;
            let length = u32::from_le_bytes(length) as usize;
            if !(29..=CHUNK_BYTES + 29).contains(&length) {
                return Err(io::Error::other("Damaged upload"));
            }
            let mut encrypted = Vec::with_capacity(length);
            Read::by_ref(&mut self.input)
                .take(length as u64)
                .read_to_end(&mut encrypted)?;
            if encrypted.len() != length {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Damaged upload",
                ));
            }
            self.buffer = zeroize::Zeroizing::new(
                self.lease
                    .cipher
                    .decrypt(
                        &encrypted,
                        &format!("{}|{}", self.lease.context, self.index),
                    )
                    .map_err(|_| io::Error::other("Damaged upload"))?,
            );
            if self.buffer.is_empty() || self.buffer.len() as u64 > self.remaining {
                return Err(io::Error::other("Damaged upload"));
            }
            if self.index + 1 == self.chunks {
                let mut extra = [0];
                if self.buffer.len() as u64 != self.remaining || self.input.read(&mut extra)? != 0 {
                    return Err(io::Error::other("Damaged upload"));
                }
            }
            self.index += 1;
            self.position = 0;
        }
        let size = output.len().min(self.buffer.len() - self.position);
        output[..size].copy_from_slice(&self.buffer[self.position..self.position + size]);
        self.position += size;
        self.remaining -= size as u64;
        Ok(size)
    }
}

#[derive(Default)]
pub struct RequestFileState {
    store: Mutex<Option<RequestFileStore>>,
    watched: Mutex<HashSet<String>>,
    closed: Mutex<HashSet<String>>,
}
impl RequestFileState {
    fn access<T>(
        &self,
        app: &tauri::AppHandle,
        operation: impl FnOnce(&mut RequestFileStore) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut store = self
            .store
            .lock()
            .map_err(|_| "Request file storage is unavailable")?;
        if store.is_none() {
            let cache = app
                .path()
                .app_cache_dir()
                .map_err(|_| "Cannot locate request body storage")?;
            *store = Some(RequestFileStore::open(cache.join("request-bodies"))?);
        }
        operation(
            store
                .as_mut()
                .ok_or("Request file storage is unavailable")?,
        )
    }
    pub fn while_open<T>(
        &self,
        owner: &str,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let closed = self.closed.lock().map_err(|_| "Upload owner unavailable")?;
        if closed.contains(owner) {
            return Err("Upload window closed".into());
        }
        operation()
    }
    fn owned<T>(
        &self,
        app: &tauri::AppHandle,
        owner: &str,
        operation: impl FnOnce(&mut RequestFileStore) -> Result<T, String>,
    ) -> Result<T, String> {
        let closed = self.closed.lock().map_err(|_| "Upload owner unavailable")?;
        if closed.contains(owner) {
            return Err("Upload window closed".into());
        }
        if app.get_webview_window(owner).is_none() {
            return Err("Upload window closed".into());
        }
        self.access(app, operation)
    }
    pub fn initialize(&self, app: &tauri::AppHandle) -> Result<(), String> {
        self.access(app, |_| Ok(()))
    }
    pub fn watch_window(&self, owner: &str) -> bool {
        self.watched
            .lock()
            .is_ok_and(|mut v| v.insert(owner.into()))
    }
    pub fn clear_window(&self, owner: &str) {
        let Ok(mut closed) = self.closed.lock() else {
            return;
        };
        closed.insert(owner.into());
        if let Ok(mut s) = self.store.lock() {
            if let Some(s) = s.as_mut() {
                s.clear_owner(owner);
            }
        }
        if let Ok(mut w) = self.watched.lock() {
            w.remove(owner);
        }
    }
    pub fn create(
        &self,
        app: &tauri::AppHandle,
        owner: &str,
        name: String,
        size: u64,
        media_type: String,
    ) -> Result<RequestFileRef, String> {
        self.owned(app, owner, |s| s.create(owner, name, size, media_type))
    }
    pub fn append(
        &self,
        app: &tauri::AppHandle,
        owner: &str,
        id: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<(), String> {
        self.owned(app, owner, |s| s.append(owner, id, offset, bytes))
    }
    pub fn finish(
        &self,
        app: &tauri::AppHandle,
        owner: &str,
        reference: &RequestFileRef,
    ) -> Result<RequestFileRef, String> {
        self.owned(app, owner, |s| s.finish(owner, reference))
    }
    pub fn release(
        &self,
        app: &tauri::AppHandle,
        owner: &str,
        reference: &RequestFileRef,
    ) -> Result<(), String> {
        self.owned(app, owner, |s| s.release(owner, reference))
    }
    pub fn attachment(
        &self,
        app: &tauri::AppHandle,
        owner: &str,
        workspace: &str,
        source: AttachmentSource,
    ) -> Result<RequestFileRef, String> {
        self.owned(app, owner, |s| s.attachment(owner, workspace, source))
    }
    pub fn body(
        &self,
        app: &tauri::AppHandle,
        owner: &str,
        workspace: &str,
        reference: &RequestFileRef,
    ) -> Result<reqwest::Body, String> {
        self.owned(app, owner, |s| s.reader(owner, workspace, reference))
            .map(stream_reader)
    }
}

#[cfg(test)]
pub fn stream_file(path: &std::path::Path) -> Result<reqwest::Body, String> {
    let file = fs::File::open(path).map_err(|_| "Cannot read test file")?;
    Ok(stream_reader(Box::new(file)))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn staged(store: &mut RequestFileStore, bytes: &[u8]) -> RequestFileRef {
        let reference = store
            .create(
                "main",
                "payload.bin".into(),
                bytes.len() as u64,
                "application/octet-stream".into(),
            )
            .unwrap();
        for (i, chunk) in bytes.chunks(CHUNK_BYTES).enumerate() {
            store
                .append("main", &reference.id, (i * CHUNK_BYTES) as u64, chunk)
                .unwrap();
        }
        store.finish("main", &reference).unwrap()
    }
    #[test]
    fn encrypted_upload_is_byte_exact_repeatable_and_never_plaintext_on_disk() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RequestFileStore::open(directory.path().into()).unwrap();
        let marker = b"synthetic-secret-upload-marker";
        let bytes = marker.repeat(CHUNK_BYTES / marker.len() + 2);
        let reference = staged(&mut store, &bytes);
        let path = directory.path().join(&reference.id);
        let disk = fs::read(&path).unwrap();
        assert!(!disk.windows(marker.len()).any(|v| v == marker));
        for _ in 0..2 {
            let mut got = Vec::new();
            store
                .reader("main", "workspace", &reference)
                .unwrap()
                .read_to_end(&mut got)
                .unwrap();
            assert_eq!(got, bytes);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(directory.path()).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        store.release("main", &reference).unwrap();
        assert!(!path.exists());
    }
    #[test]
    fn owner_workspace_metadata_and_incomplete_uploads_are_checked() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RequestFileStore::open(directory.path().into()).unwrap();
        let reference = store
            .create("main", "test".into(), 2, "text/plain".into())
            .unwrap();
        assert!(store.append("other", &reference.id, 0, b"ab").is_err());
        assert!(store.finish("main", &reference).is_err());
        assert!(store.reader("main", "workspace", &reference).is_err());
        store.append("main", &reference.id, 0, b"ab").unwrap();
        assert!(store.append("main", &reference.id, 0, b"ab").is_err());
        store.finish("main", &reference).unwrap();
        assert!(store.reader("other", "workspace", &reference).is_err());
        let _reader = store.reader("main", "workspace", &reference).unwrap();
        assert!(store.reader("main", "other-workspace", &reference).is_err());
        let mut fake = reference.clone();
        fake.size = 1;
        assert!(store.reader("main", "workspace", &fake).is_err());
        assert!(store.release("other", &reference).is_err());
    }
    #[test]
    fn active_reader_holds_lease_and_window_cleanup_releases_registry() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RequestFileStore::open(directory.path().into()).unwrap();
        let reference = staged(&mut store, b"private upload");
        let path = directory.path().join(&reference.id);
        let mut reader = store.reader("main", "workspace", &reference).unwrap();
        store.clear_owner("main");
        assert!(path.exists());
        assert!(store.reader("main", "workspace", &reference).is_err());
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"private upload");
        drop(reader);
        assert!(!path.exists());
    }
    #[test]
    fn tampered_truncated_and_appended_ciphertext_fail_before_last_plaintext() {
        for mode in 0..3 {
            let directory = tempfile::tempdir().unwrap();
            let mut store = RequestFileStore::open(directory.path().into()).unwrap();
            let reference = staged(&mut store, b"secret");
            let path = directory.path().join(&reference.id);
            let mut disk = fs::read(&path).unwrap();
            match mode {
                0 => disk[20] ^= 1,
                1 => {
                    disk.pop();
                }
                _ => disk.push(0),
            };
            fs::write(&path, disk).unwrap();
            let mut bytes = Vec::new();
            assert!(store
                .reader("main", "workspace", &reference)
                .unwrap()
                .read_to_end(&mut bytes)
                .is_err());
            assert!(bytes.is_empty());
        }
    }
    #[test]
    fn startup_cleans_orphans_without_touching_unrelated_files() {
        let directory = tempfile::tempdir().unwrap();
        let orphan = directory.path().join("request-file-orphan");
        let keep = directory.path().join("other");
        fs::write(&orphan, b"old legacy plaintext").unwrap();
        fs::write(&keep, b"keep").unwrap();
        let _store = RequestFileStore::open(directory.path().into()).unwrap();
        assert!(!orphan.exists());
        assert!(keep.exists());
    }
    #[test]
    fn empty_upload_is_valid_and_drop_cleans_files() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RequestFileStore::open(directory.path().into()).unwrap();
        let reference = staged(&mut store, b"");
        let mut bytes = Vec::new();
        store
            .reader("main", "workspace", &reference)
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert!(bytes.is_empty());
        drop(store);
        assert!(!directory.path().join(reference.id).exists());
    }
    #[test]
    fn crash_fixture_child() {
        let Some(path) = std::env::var_os("PURR_S07_UPLOAD_CRASH_DIRECTORY") else {
            return;
        };
        let mut store = RequestFileStore::open(PathBuf::from(path)).unwrap();
        let _reference = staged(&mut store, b"synthetic-crash-secret-marker");
        std::process::exit(0); // deliberately bypass Drop, like abrupt process loss
    }
    #[test]
    fn crash_leaves_only_ciphertext_and_next_start_removes_it() {
        let dir = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "http::request_body::tests::crash_fixture_child"])
            .env("PURR_S07_UPLOAD_CRASH_DIRECTORY", dir.path())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        let entries = fs::read_dir(dir.path())
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(entries.len(), 1);
        let bytes = fs::read(entries[0].path()).unwrap();
        let marker = b"synthetic-crash-secret-marker";
        assert!(!bytes.windows(marker.len()).any(|w| w == marker));
        let _store = RequestFileStore::open(dir.path().into()).unwrap();
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }
    #[test]
    fn closed_window_rejects_late_operation_registration() {
        let files = RequestFileState::default();
        let operations = crate::http::HttpOperationState::default();
        files.clear_window("main");
        assert!(files
            .while_open("main", || operations.register("late-request"))
            .is_err());
    }
}
