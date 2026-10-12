//! One serialized, process-lifetime owner of installation keys and root migration.
use super::{
    inventory::EncryptedInventory,
    platform::{OsKeyStore, PlatformKeyStore},
    read_root_key_file_typed, ProtectedError, ProtectedStatus, RootCiphers, ROOT_KEY_FILE,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use zeroize::Zeroizing;

const METADATA: &str = "root-key-metadata-v1.json";
const LOCK: &str = "root-key-manager.lock";
const CHECK: &[u8] = b"purr-root-key-check-v1";
type ResultCiphers = Result<Arc<RootCiphers>, ProtectedError>;
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Phase {
    Prepared,
    DestinationVerified,
    RetirementPending,
    Complete,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Metadata {
    version: u8,
    app_id: String,
    profile: String,
    vault_id: String,
    fingerprint: String,
    keycheck: String,
    phase: Phase,
    new_vault: bool,
}
impl Metadata {
    fn aad(&self) -> String {
        format!(
            "purr:root-check:v1:{}:{}:{}",
            self.app_id, self.profile, self.vault_id
        )
    }
}
#[derive(Default)]
struct State {
    result: Option<ResultCiphers>,
    lock: Option<File>,
}
pub struct KeyManager {
    directory: PathBuf,
    app_id: String,
    profile: String,
    allow_legacy: bool,
    provider: Arc<dyn OsKeyStore>,
    state: Mutex<State>,
    generation: AtomicU64,
    #[cfg(test)]
    fail_at: Mutex<Option<&'static str>>,
}
impl KeyManager {
    pub fn new(
        directory: PathBuf,
        app_id: String,
        profile: String,
        allow_legacy_entry: bool,
    ) -> Self {
        Self::with_provider(
            directory,
            app_id,
            profile,
            allow_legacy_entry,
            Arc::new(PlatformKeyStore),
        )
    }
    fn with_provider(
        directory: PathBuf,
        app_id: String,
        profile: String,
        allow_legacy: bool,
        provider: Arc<dyn OsKeyStore>,
    ) -> Self {
        Self {
            directory,
            app_id,
            profile,
            allow_legacy,
            provider,
            state: Mutex::new(State::default()),
            generation: AtomicU64::new(0),
            #[cfg(test)]
            fail_at: Mutex::new(None),
        }
    }
    pub fn open(&self) -> ResultCiphers {
        self.initialize(None)
    }
    pub fn retry(&self) -> ResultCiphers {
        self.initialize(Some(self.generation.load(Ordering::Acquire)))
    }
    fn initialize(&self, retry_generation: Option<u64>) -> ResultCiphers {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ProtectedError::unavailable("root-manager-unavailable"))?;
        if let Some(result) = &state.result {
            if result.is_ok() || retry_generation != Some(self.generation.load(Ordering::Acquire)) {
                return result.clone();
            }
        }
        let result = self.initialize_locked(&mut state).map(Arc::new);
        state.result = Some(result.clone());
        self.generation.fetch_add(1, Ordering::Release);
        result
    }
    fn initialize_locked(&self, state: &mut State) -> Result<RootCiphers, ProtectedError> {
        if self.app_id.is_empty()
            || self.profile.is_empty()
            || self.app_id.len() > 200
            || self.profile.len() > 40
        {
            return Err(recovery("root-identity-invalid"));
        }
        fs::create_dir_all(&self.directory)
            .map_err(|_| ProtectedError::unavailable("root-directory-unavailable"))?;
        if state.lock.is_none() {
            let mut options = OpenOptions::new();
            options.read(true).write(true).create(true).truncate(false);
            #[cfg(unix)]
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            let lock = options
                .open(self.directory.join(LOCK))
                .map_err(|_| ProtectedError::unavailable("root-lock-unavailable"))?;
            if !lock
                .metadata()
                .map_err(|_| ProtectedError::unavailable("root-lock-unavailable"))?
                .is_file()
            {
                return Err(ProtectedError::unavailable("root-lock-unavailable"));
            }
            lock.try_lock()
                .map_err(|_| ProtectedError::unavailable("root-vault-in-use"))?;
            state.lock = Some(lock); // retained until the manager and all owners exit
        }
        let inventory = EncryptedInventory::inspect(&self.directory)?;
        let mut metadata = self.read_metadata()?;
        let source_path = self.directory.join(ROOT_KEY_FILE);
        if metadata
            .as_ref()
            .is_some_and(|m| m.phase == Phase::Complete)
        {
            match fs::symlink_metadata(&source_path) {
                Ok(_) => return Err(recovery("root-key-reappeared")),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(ProtectedError::unavailable("root-key-read-unavailable")),
            }
        }
        let file = read_root_key_file_typed(&source_path)?.map(Zeroizing::new);
        let file_key = file.as_deref().map(|v| decode(v)).transpose()?;
        let known_database = match fs::symlink_metadata(self.directory.join("local-state.sqlite3"))
        {
            Ok(_) => true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => return Err(ProtectedError::unavailable("root-inventory-unavailable")),
        };
        let legacy = if self.allow_legacy
            && metadata
                .as_ref()
                .is_none_or(|m| m.phase != Phase::Complete && !m.new_vault)
            && (file.is_some() || inventory.has_encrypted_data() || known_database)
        {
            self.provider.read_legacy()?
        } else {
            None
        };
        let legacy_key = legacy.as_deref().map(|v| decode(v)).transpose()?;
        if let (Some(a), Some(b)) = (&file_key, &legacy_key) {
            if a.as_slice() != b.as_slice() {
                return Err(recovery("root-key-conflict"));
            }
        }
        // Preserve the OS identity and authenticated AAD of pre-release S03
        // metadata. Switching build mode must never generate or move its key.
        let identity_profile = metadata
            .as_ref()
            .map_or(self.profile.as_str(), |m| &m.profile);
        let service = format!("{}.root-keys.{}", self.app_id, identity_profile);
        let mut destination = match &metadata {
            Some(m) => self
                .provider
                .read(&service, &m.vault_id)?
                .map(|v| decode(&v))
                .transpose()?,
            None => None,
        };
        let mut generated = false;
        let root = match (&destination, &file_key, &legacy_key) {
            (Some(root), _, _) => Zeroizing::new(root.to_vec()),
            (None, Some(root), _) | (None, None, Some(root))
                if metadata.as_ref().is_none_or(|m| m.phase == Phase::Prepared) =>
            {
                Zeroizing::new(root.to_vec())
            }
            (None, None, None)
                if !inventory.has_encrypted_data()
                    && !known_database
                    && metadata
                        .as_ref()
                        .is_none_or(|m| m.phase == Phase::Prepared && m.new_vault) =>
            {
                let mut root = Zeroizing::new(vec![0; 32]);
                getrandom::fill(&mut root)
                    .map_err(|_| ProtectedError::unavailable("root-random-unavailable"))?;
                generated = true;
                root
            }
            _ => return Err(recovery("root-key-missing")),
        };
        for source in [&file_key, &legacy_key].into_iter().flatten() {
            if source.as_slice() != root.as_slice() {
                return Err(recovery("root-key-conflict"));
            }
        }
        let ciphers = RootCiphers::from_root(&root, true)?;
        if let Some(m) = &metadata {
            if !generated {
                verify_metadata(m, &root, &ciphers)?;
            }
            if m.phase == Phase::Complete {
                return Ok(ciphers);
            }
        }
        // No SQLite mutation, backfill, journal replay or old-key deletion precedes this.
        inventory.verify(&ciphers)?;
        if metadata.is_none() {
            let mut id = [0_u8; 16];
            getrandom::fill(&mut id)
                .map_err(|_| ProtectedError::unavailable("root-random-unavailable"))?;
            let mut m = Metadata {
                version: 1,
                app_id: self.app_id.clone(),
                profile: self.profile.clone(),
                vault_id: hex(&id),
                fingerprint: fingerprint(&root),
                keycheck: String::new(),
                phase: Phase::Prepared,
                new_vault: generated,
            };
            m.keycheck = STANDARD.encode(ciphers.database.encrypt(CHECK, &m.aad())?);
            self.write_metadata(&m)?;
            metadata = Some(m);
        }
        let mut m = metadata.ok_or_else(|| recovery("root-metadata-invalid"))?;
        if generated {
            m.fingerprint = fingerprint(&root);
            m.keycheck = STANDARD.encode(ciphers.database.encrypt(CHECK, &m.aad())?);
            self.write_metadata(&m)?;
        }
        if destination.is_none() {
            // Metadata durably records the selected source before OS mutation. A crash
            // creating a brand-new, still unused vault may regenerate only before
            // destination verification, when inventory proves it is still empty.
            let encoded = Zeroizing::new(STANDARD.encode(root.as_slice()));
            self.provider.create(&service, &m.vault_id, &encoded)?;
            self.checkpoint("after-os-create")?;
            destination = self
                .provider
                .read(&service, &m.vault_id)?
                .map(|v| decode(&v))
                .transpose()?;
            if destination
                .as_ref()
                .is_none_or(|value| value.as_slice() != root.as_slice())
            {
                return Err(recovery("root-key-readback-mismatch"));
            }
        }
        // Even resumed destinations have already been compared with the durable keycheck.
        m.phase = Phase::DestinationVerified;
        self.write_metadata(&m)?;
        m.phase = Phase::RetirementPending;
        self.write_metadata(&m)?;
        if file.is_some() {
            // Recheck the source immediately before retirement. Do not erase external changes.
            let current = read_root_key_file_typed(&source_path)?.map(Zeroizing::new);
            if current
                .as_deref()
                .map(|v| decode(v))
                .transpose()?
                .as_ref()
                .map(|v| v.as_slice())
                != Some(root.as_slice())
            {
                return Err(recovery("root-key-conflict"));
            }
            self.checkpoint("retire").map_err(|_| retirement())?;
            fs::remove_file(&source_path).map_err(|_| retirement())?;
        }
        match fs::symlink_metadata(&source_path) {
            Ok(_) => return Err(retirement()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(retirement()),
        }
        self.checkpoint("retirement-sync")
            .map_err(|_| retirement())?;
        sync_directory(&self.directory).map_err(|_| retirement())?;
        m.phase = Phase::Complete;
        self.write_metadata(&m).map_err(|_| retirement())?;
        Ok(ciphers)
    }
    fn read_metadata(&self) -> Result<Option<Metadata>, ProtectedError> {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        let file = match options.open(self.directory.join(METADATA)) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(ProtectedError::unavailable("root-metadata-unavailable")),
        };
        if !file
            .metadata()
            .map_err(|_| recovery("root-metadata-invalid"))?
            .is_file()
        {
            return Err(recovery("root-metadata-invalid"));
        }
        let mut bytes = Vec::new();
        file.take(8193)
            .read_to_end(&mut bytes)
            .map_err(|_| ProtectedError::unavailable("root-metadata-unavailable"))?;
        if bytes.len() > 8192 {
            return Err(recovery("root-metadata-invalid"));
        }
        let m: Metadata =
            serde_json::from_slice(&bytes).map_err(|_| recovery("root-metadata-invalid"))?;
        if m.version != 1
            || m.vault_id.len() != 32
            || !m.vault_id.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(recovery("root-metadata-invalid"));
        }
        let compatible_profile = m.profile == self.profile
            || (self.profile == "application"
                && matches!(m.profile.as_str(), "development" | "release"));
        if m.app_id != self.app_id || !compatible_profile {
            return Err(recovery("root-identity-mismatch"));
        }
        Ok(Some(m))
    }
    fn checkpoint(&self, label: &'static str) -> Result<(), ProtectedError> {
        #[cfg(test)]
        {
            let mut fail_at = self.fail_at.lock().unwrap();
            if *fail_at == Some(label) {
                *fail_at = None;
                return Err(ProtectedError::unavailable("root-metadata-write-failed"));
            }
        }
        let _ = label;
        Ok(())
    }
    fn write_metadata(&self, m: &Metadata) -> Result<(), ProtectedError> {
        let (before, after) = match m.phase {
            Phase::Prepared => ("before-prepared", "after-prepared"),
            Phase::DestinationVerified => ("before-verified", "after-verified"),
            Phase::RetirementPending => ("before-retirement", "after-retirement"),
            Phase::Complete => ("before-complete", "after-complete"),
        };
        self.checkpoint(before)?;
        let mut file = tempfile::Builder::new()
            .prefix(".purr-root-metadata-")
            .tempfile_in(&self.directory)
            .map_err(|_| ProtectedError::unavailable("root-metadata-write-failed"))?;
        serde_json::to_writer(&mut file, m)
            .map_err(|_| ProtectedError::unavailable("root-metadata-write-failed"))?;
        file.flush()
            .and_then(|_| file.as_file().sync_all())
            .map_err(|_| ProtectedError::unavailable("root-metadata-write-failed"))?;
        file.persist(self.directory.join(METADATA))
            .map_err(|_| ProtectedError::unavailable("root-metadata-write-failed"))?;
        sync_directory(&self.directory)
            .map_err(|_| ProtectedError::unavailable("root-metadata-write-failed"))?;
        self.checkpoint(after)
    }
}
fn decode(value: &str) -> Result<Zeroizing<Vec<u8>>, ProtectedError> {
    let bytes = Zeroizing::new(
        STANDARD
            .decode(value)
            .map_err(|_| ProtectedError::corrupt("root-key-invalid"))?,
    );
    if bytes.len() != 32 {
        return Err(ProtectedError::corrupt("root-key-invalid"));
    }
    Ok(bytes)
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn fingerprint(root: &[u8]) -> String {
    hex(&Sha256::digest(root))
}
fn verify_metadata(m: &Metadata, root: &[u8], ciphers: &RootCiphers) -> Result<(), ProtectedError> {
    if fingerprint(root) != m.fingerprint {
        return Err(recovery("root-key-conflict"));
    }
    let envelope = STANDARD
        .decode(&m.keycheck)
        .map_err(|_| recovery("root-metadata-invalid"))?;
    let plain = ciphers
        .database
        .decrypt(&envelope, &m.aad())
        .map_err(|_| recovery("root-key-conflict"))?;
    if plain != CHECK {
        return Err(recovery("root-key-conflict"));
    }
    Ok(())
}
fn sync_directory(directory: &Path) -> std::io::Result<()> {
    File::open(directory)?.sync_all()
}
fn recovery(code: &'static str) -> ProtectedError {
    ProtectedError::new(ProtectedStatus::RecoveryRequired, code, false)
}
fn retirement() -> ProtectedError {
    ProtectedError::new(
        ProtectedStatus::RecoveryRequired,
        "root-retirement-pending",
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        sync::atomic::{AtomicBool, AtomicUsize},
        thread,
    };
    #[derive(Default)]
    struct Provider {
        entries: Mutex<HashMap<(String, String), String>>,
        legacy: Mutex<Option<String>>,
        failure: Mutex<Option<ProtectedError>>,
        reads: AtomicUsize,
        writes: AtomicUsize,
        legacy_reads: AtomicUsize,
        bad_readback: AtomicBool,
        slow_reads: AtomicBool,
    }
    impl OsKeyStore for Provider {
        fn read(
            &self,
            service: &str,
            account: &str,
        ) -> Result<Option<Zeroizing<String>>, ProtectedError> {
            self.reads.fetch_add(1, Ordering::Relaxed);
            if self.slow_reads.load(Ordering::Relaxed) {
                thread::sleep(std::time::Duration::from_millis(100));
            }
            if let Some(e) = &*self.failure.lock().unwrap() {
                return Err(e.clone());
            }
            Ok(self
                .entries
                .lock()
                .unwrap()
                .get(&(service.into(), account.into()))
                .map(|value| Zeroizing::new(value.clone())))
        }
        fn create(&self, service: &str, account: &str, value: &str) -> Result<(), ProtectedError> {
            self.writes.fetch_add(1, Ordering::Relaxed);
            if let Some(e) = &*self.failure.lock().unwrap() {
                return Err(e.clone());
            }
            let mut entries = self.entries.lock().unwrap();
            let identity = (service.to_owned(), account.to_owned());
            if entries.contains_key(&identity) {
                return Err(recovery("root-key-conflict"));
            }
            entries.insert(
                identity,
                if self.bad_readback.load(Ordering::Relaxed) {
                    STANDARD.encode([99; 32])
                } else {
                    value.into()
                },
            );
            Ok(())
        }
        fn read_legacy(&self) -> Result<Option<Zeroizing<String>>, ProtectedError> {
            self.legacy_reads.fetch_add(1, Ordering::Relaxed);
            if let Some(e) = &*self.failure.lock().unwrap() {
                return Err(e.clone());
            }
            Ok(self.legacy.lock().unwrap().clone().map(Zeroizing::new))
        }
    }
    fn manager(dir: &Path, provider: &Arc<Provider>) -> KeyManager {
        KeyManager::with_provider(
            dir.into(),
            "test.purr".into(),
            "test".into(),
            true,
            provider.clone(),
        )
    }
    fn legacy_file(dir: &Path, byte: u8) {
        super::super::write_root_key_file(&dir.join(ROOT_KEY_FILE), &STANDARD.encode([byte; 32]))
            .unwrap();
    }
    fn error(result: ResultCiphers) -> ProtectedError {
        result.err().expect("expected protected error")
    }
    #[test]
    fn concurrent_consumers_initialize_once_and_cached_cipher_handles_share() {
        let dir = tempfile::tempdir().unwrap();
        let provider = Arc::new(Provider::default());
        let manager = Arc::new(manager(dir.path(), &provider));
        let handles: Vec<_> = (0..16)
            .map(|_| {
                let m = manager.clone();
                thread::spawn(move || m.open().unwrap())
            })
            .collect();
        let ciphers: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert!(ciphers
            .iter()
            .all(|cipher| Arc::ptr_eq(cipher, &ciphers[0])));
        for _ in 0..10 {
            manager.open().unwrap();
            manager.retry().unwrap();
        }
        assert_eq!(provider.writes.load(Ordering::Relaxed), 1);
        assert_eq!(provider.reads.load(Ordering::Relaxed), 1);
        assert_eq!(provider.legacy_reads.load(Ordering::Relaxed), 0);
        assert!(!dir.path().join(ROOT_KEY_FILE).exists());
    }
    #[test]
    fn migrates_same_key_and_restarts_without_plaintext_sources() {
        let dir = tempfile::tempdir().unwrap();
        let provider = Arc::new(Provider::default());
        legacy_file(dir.path(), 7);
        *provider.legacy.lock().unwrap() = Some(STANDARD.encode([7; 32]));
        let ciphertext;
        {
            let m = manager(dir.path(), &provider);
            let keys = m.open().unwrap();
            ciphertext = keys.database.encrypt(b"synthetic", "test").unwrap();
            assert_eq!(
                m.read_metadata().unwrap().unwrap().phase as u8,
                Phase::Complete as u8
            );
        }
        assert!(!dir.path().join(ROOT_KEY_FILE).exists());
        let keys = manager(dir.path(), &provider).open().unwrap();
        assert_eq!(
            keys.database.decrypt(&ciphertext, "test").unwrap(),
            b"synthetic"
        );
        assert!(provider.legacy.lock().unwrap().is_some());
        let marker = STANDARD.encode([7; 32]);
        for entry in fs::read_dir(dir.path()).unwrap() {
            let bytes = fs::read(entry.unwrap().path()).unwrap();
            assert!(!bytes.windows(marker.len()).any(|b| b == marker.as_bytes()));
            assert!(!bytes.windows(32).any(|b| b == [7; 32]));
        }
    }
    #[test]
    fn failures_are_cached_until_explicit_retry_and_never_replace_existing_root() {
        for status in [
            ProtectedStatus::Locked,
            ProtectedStatus::Denied,
            ProtectedStatus::Unavailable,
            ProtectedStatus::Corrupt,
        ] {
            let dir = tempfile::tempdir().unwrap();
            let p = Arc::new(Provider::default());
            legacy_file(dir.path(), 8);
            *p.failure.lock().unwrap() = Some(ProtectedError::new(
                status,
                "synthetic-provider-failure",
                true,
            ));
            let m = manager(dir.path(), &p);
            for _ in 0..5 {
                assert_eq!(error(m.open()).status, status);
            }
            assert_eq!(p.legacy_reads.load(Ordering::Relaxed), 1);
            assert_eq!(p.writes.load(Ordering::Relaxed), 0);
            assert!(dir.path().join(ROOT_KEY_FILE).exists());
            *p.failure.lock().unwrap() = None;
            m.retry().unwrap();
            assert!(!dir.path().join(ROOT_KEY_FILE).exists());
        }
    }
    #[test]
    fn conflict_and_corrupt_file_preserve_all_sources() {
        let dir = tempfile::tempdir().unwrap();
        let p = Arc::new(Provider::default());
        legacy_file(dir.path(), 1);
        *p.legacy.lock().unwrap() = Some(STANDARD.encode([2; 32]));
        let m = manager(dir.path(), &p);
        assert_eq!(error(m.open()).code, "root-key-conflict");
        assert_eq!(p.writes.load(Ordering::Relaxed), 0);
        assert!(dir.path().join(ROOT_KEY_FILE).exists());
        fs::write(dir.path().join(ROOT_KEY_FILE), "partial").unwrap();
        assert_eq!(error(m.retry()).code, "root-key-invalid");
        assert_eq!(p.writes.load(Ordering::Relaxed), 0);
    }
    #[test]
    fn readback_mismatch_does_not_retire_source_or_overwrite_destination() {
        let dir = tempfile::tempdir().unwrap();
        let p = Arc::new(Provider::default());
        legacy_file(dir.path(), 4);
        p.bad_readback.store(true, Ordering::Relaxed);
        let m = manager(dir.path(), &p);
        assert_eq!(error(m.open()).code, "root-key-readback-mismatch");
        assert!(dir.path().join(ROOT_KEY_FILE).exists());
        assert_eq!(error(m.retry()).code, "root-key-conflict");
        assert_eq!(p.writes.load(Ordering::Relaxed), 1);
    }
    #[test]
    fn complete_empty_vault_never_replaces_lost_os_key_and_reappeared_file_is_not_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let p = Arc::new(Provider::default());
        {
            manager(dir.path(), &p).open().unwrap();
        }
        p.entries.lock().unwrap().clear();
        let m = manager(dir.path(), &p);
        assert_eq!(error(m.open()).code, "root-key-missing");
        assert_eq!(p.writes.load(Ordering::Relaxed), 1);
        legacy_file(dir.path(), 6);
        assert_eq!(error(m.retry()).code, "root-key-reappeared");
        assert!(dir.path().join(ROOT_KEY_FILE).exists());
    }
    #[test]
    fn process_lock_blocks_second_manager_until_first_exits() {
        let dir = tempfile::tempdir().unwrap();
        let p = Arc::new(Provider::default());
        let first = manager(dir.path(), &p);
        first.open().unwrap();
        let second = manager(dir.path(), &p);
        assert_eq!(error(second.open()).code, "root-vault-in-use");
        drop(first);
        second.retry().unwrap();
        assert_eq!(p.writes.load(Ordering::Relaxed), 1);
    }
    #[test]
    fn resumes_every_published_migration_state_without_changing_key() {
        for phase in [
            Phase::Prepared,
            Phase::DestinationVerified,
            Phase::RetirementPending,
            Phase::Complete,
        ] {
            for source_exists in [true, false] {
                if phase == Phase::Complete && source_exists {
                    continue;
                }
                let dir = tempfile::tempdir().unwrap();
                let p = Arc::new(Provider::default());
                {
                    manager(dir.path(), &p).open().unwrap();
                }
                let encoded = p.entries.lock().unwrap().values().next().unwrap().clone();
                let m = manager(dir.path(), &p);
                let mut meta = m.read_metadata().unwrap().unwrap();
                meta.phase = phase;
                meta.new_vault = false;
                m.write_metadata(&meta).unwrap();
                if source_exists {
                    super::super::write_root_key_file(&dir.path().join(ROOT_KEY_FILE), &encoded)
                        .unwrap();
                }
                m.open().unwrap();
                assert!(!dir.path().join(ROOT_KEY_FILE).exists());
                assert_eq!(p.writes.load(Ordering::Relaxed), 1);
            }
        }
    }
    #[test]
    fn prepared_source_can_resume_before_os_create_but_verified_missing_cannot() {
        for phase in [
            Phase::Prepared,
            Phase::DestinationVerified,
            Phase::RetirementPending,
        ] {
            let dir = tempfile::tempdir().unwrap();
            let p = Arc::new(Provider::default());
            legacy_file(dir.path(), 3);
            {
                manager(dir.path(), &p).open().unwrap();
            }
            p.entries.lock().unwrap().clear();
            legacy_file(dir.path(), 3);
            let m = manager(dir.path(), &p);
            let mut meta = m.read_metadata().unwrap().unwrap();
            meta.phase = phase;
            m.write_metadata(&meta).unwrap();
            if phase == Phase::Prepared {
                m.open().unwrap();
                assert_eq!(p.writes.load(Ordering::Relaxed), 2);
            } else {
                assert_eq!(error(m.open()).code, "root-key-missing");
                assert!(dir.path().join(ROOT_KEY_FILE).exists());
            }
        }
    }
    #[test]
    fn fresh_denied_creation_can_retry_without_exporting_root() {
        let dir = tempfile::tempdir().unwrap();
        let p = Arc::new(Provider::default());
        *p.failure.lock().unwrap() = Some(ProtectedError::denied("root-provider-access-denied"));
        let m = manager(dir.path(), &p);
        assert_eq!(error(m.open()).status, ProtectedStatus::Denied);
        assert!(!dir.path().join(ROOT_KEY_FILE).exists());
        *p.failure.lock().unwrap() = None;
        m.retry().unwrap();
    }
    #[test]
    fn metadata_identity_and_keycheck_cannot_be_silently_rebound() {
        let dir = tempfile::tempdir().unwrap();
        let p = Arc::new(Provider::default());
        {
            manager(dir.path(), &p).open().unwrap();
        }
        let m = KeyManager::with_provider(
            dir.path().into(),
            "different.application".into(),
            "test".into(),
            false,
            p.clone(),
        );
        assert_eq!(error(m.open()).code, "root-identity-mismatch");
        drop(m);
        let m = manager(dir.path(), &p);
        let mut meta = m.read_metadata().unwrap().unwrap();
        meta.keycheck = STANDARD.encode([0; 40]);
        m.write_metadata(&meta).unwrap();
        assert_eq!(error(m.open()).code, "root-key-conflict");
        assert_eq!(p.writes.load(Ordering::Relaxed), 1);
    }
    #[test]
    fn application_profile_reuses_existing_identity_without_rekeying() {
        for profile in ["development", "release", "application"] {
            let dir = tempfile::tempdir().unwrap();
            let p = Arc::new(Provider::default());
            let ciphertext = {
                let old = KeyManager::with_provider(
                    dir.path().into(),
                    "test.purr".into(),
                    profile.into(),
                    false,
                    p.clone(),
                );
                old.open()
                    .unwrap()
                    .secrets
                    .encrypt(b"synthetic-secret", "fixture")
                    .unwrap()
            };
            let before = fs::read(dir.path().join(METADATA)).unwrap();
            let current = KeyManager::with_provider(
                dir.path().into(),
                "test.purr".into(),
                "application".into(),
                true,
                p.clone(),
            );
            let ciphers = current.open().unwrap();
            assert_eq!(
                ciphers.secrets.decrypt(&ciphertext, "fixture").unwrap(),
                b"synthetic-secret"
            );
            assert_eq!(fs::read(dir.path().join(METADATA)).unwrap(), before);
            assert_eq!(p.writes.load(Ordering::Relaxed), 1);
            assert_eq!(p.legacy_reads.load(Ordering::Relaxed), 0);
            drop(current);
            let other_app = KeyManager::with_provider(
                dir.path().into(),
                "other.purr".into(),
                "application".into(),
                false,
                p.clone(),
            );
            assert_eq!(error(other_app.open()).code, "root-identity-mismatch");
        }
    }

    #[test]
    fn application_profile_resumes_incomplete_pre_release_migrations() {
        for profile in ["development", "release"] {
            for checkpoint in ["after-prepared", "after-os-create", "before-complete"] {
                let dir = tempfile::tempdir().unwrap();
                let p = Arc::new(Provider::default());
                legacy_file(dir.path(), 17);
                let ciphertext = RootCiphers::from_root(&[17; 32], false)
                    .unwrap()
                    .secrets
                    .encrypt(b"legacy-secret", "fixture")
                    .unwrap();
                {
                    let old = KeyManager::with_provider(
                        dir.path().into(),
                        "test.purr".into(),
                        profile.into(),
                        false,
                        p.clone(),
                    );
                    *old.fail_at.lock().unwrap() = Some(checkpoint);
                    assert!(old.open().is_err());
                }
                let current = KeyManager::with_provider(
                    dir.path().into(),
                    "test.purr".into(),
                    "application".into(),
                    false,
                    p.clone(),
                );
                let ciphers = current.open().unwrap();
                assert_eq!(
                    ciphers.secrets.decrypt(&ciphertext, "fixture").unwrap(),
                    b"legacy-secret"
                );
                let meta = current.read_metadata().unwrap().unwrap();
                assert_eq!(meta.profile, profile);
                assert!(meta.phase == Phase::Complete);
                assert_eq!(p.writes.load(Ordering::Relaxed), 1);
                assert!(!dir.path().join(ROOT_KEY_FILE).exists());
            }
        }
    }

    #[test]
    fn interruption_and_write_delete_sync_failures_resume_without_key_loss() {
        for checkpoint in [
            "before-prepared",
            "after-prepared",
            "after-os-create",
            "before-verified",
            "after-verified",
            "before-retirement",
            "after-retirement",
            "retire",
            "retirement-sync",
            "before-complete",
            "after-complete",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let p = Arc::new(Provider::default());
            legacy_file(dir.path(), 11);
            {
                let m = manager(dir.path(), &p);
                *m.fail_at.lock().unwrap() = Some(checkpoint);
                let failure = error(m.open());
                if [
                    "retire",
                    "retirement-sync",
                    "before-complete",
                    "after-complete",
                ]
                .contains(&checkpoint)
                {
                    assert_eq!(failure.code, "root-retirement-pending", "{checkpoint}");
                }
                // Failure cache blocks protected operations without retriggering prompts.
                assert_eq!(error(m.open()).code, failure.code);
            }
            let m = manager(dir.path(), &p);
            let keys = m.open().unwrap();
            assert!(!dir.path().join(ROOT_KEY_FILE).exists(), "{checkpoint}");
            let expected = RootCiphers::from_root(&[11; 32], true).unwrap();
            let envelope = expected
                .database
                .encrypt(b"after-interruption", "check")
                .unwrap();
            assert_eq!(
                keys.database.decrypt(&envelope, "check").unwrap(),
                b"after-interruption"
            );
            assert_eq!(p.writes.load(Ordering::Relaxed), 1, "{checkpoint}");
        }
    }
    #[test]
    fn legacy_empty_database_is_not_evidence_of_a_brand_new_vault() {
        let dir = tempfile::tempdir().unwrap();
        let p = Arc::new(Provider::default());
        rusqlite::Connection::open(dir.path().join("local-state.sqlite3")).unwrap();
        let m = manager(dir.path(), &p);
        assert_eq!(error(m.open()).code, "root-key-missing");
        assert_eq!(p.writes.load(Ordering::Relaxed), 0);
    }
    #[cfg(unix)]
    #[test]
    fn root_metadata_and_lock_symlinks_never_touch_external_files() {
        for name in [ROOT_KEY_FILE, METADATA, LOCK] {
            let dir = tempfile::tempdir().unwrap();
            let external = tempfile::tempdir().unwrap();
            let target = external.path().join("untouched");
            fs::write(&target, b"external-synthetic-marker").unwrap();
            std::os::unix::fs::symlink(&target, dir.path().join(name)).unwrap();
            let p = Arc::new(Provider::default());
            assert!(manager(dir.path(), &p).open().is_err(), "{name}");
            assert_eq!(fs::read(&target).unwrap(), b"external-synthetic-marker");
            assert_eq!(p.writes.load(Ordering::Relaxed), 0);
            assert_eq!(p.reads.load(Ordering::Relaxed), 0);
        }
    }
    #[test]
    fn concurrent_explicit_retries_share_one_attempt_including_denial() {
        let dir = tempfile::tempdir().unwrap();
        let p = Arc::new(Provider::default());
        {
            manager(dir.path(), &p).open().unwrap();
        }
        *p.failure.lock().unwrap() = Some(ProtectedError::denied("synthetic-denial"));
        let m = Arc::new(manager(dir.path(), &p));
        assert_eq!(error(m.open()).code, "synthetic-denial");
        let before = p.reads.load(Ordering::Relaxed);
        p.slow_reads.store(true, Ordering::Relaxed);
        let barrier = Arc::new(std::sync::Barrier::new(12));
        let threads: Vec<_> = (0..12)
            .map(|_| {
                let m = m.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    error(m.retry()).code
                })
            })
            .collect();
        for thread in threads {
            assert_eq!(thread.join().unwrap(), "synthetic-denial");
        }
        assert_eq!(p.reads.load(Ordering::Relaxed), before + 1);
        *p.failure.lock().unwrap() = None;
        m.retry().unwrap();
    }
}
