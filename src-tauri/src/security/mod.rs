pub mod availability;
pub mod caller;
pub mod context;
pub mod inventory;
pub mod layout;
pub mod manager;
pub mod scoped;
pub use scoped::{decrypt_recovery_secret, CredentialRecoveryKey, ProtectionScope};
#[cfg(all(test, target_os = "macos"))]
mod os_store_smoke;
mod platform;
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
pub use availability::{ProtectedError, ProtectedStatus};
#[cfg(test)]
use base64::{engine::general_purpose::STANDARD, Engine};
use hkdf::Hkdf;
use sha2::Sha256;
#[cfg(test)]
use std::fs;
#[cfg(test)]
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    fs::OpenOptions,
    io::{ErrorKind, Read},
    path::Path,
    sync::Arc,
};
use zeroize::Zeroizing;

#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "app.purr.credentials";
pub const ROOT_KEY_REF: &str = "purr/local-storage/master-key-v1";
const DATABASE_KEY_INFO: &[u8] = b"purr:database:v1";
const SECRETS_KEY_INFO: &[u8] = b"purr:secrets:v1";
const RESPONSE_CONTENT_KEY_INFO: &[u8] = b"purr:response-content:v1";

// Application storage owns one root key only. SecretRef values are handled by
// the encrypted SQLite vault and never become individual files or Keychain items.
#[cfg(test)]
pub trait RootKeyStore: Send + Sync {
    fn get_root_key(&self) -> Result<Option<String>, String>;
    fn set_root_key(&self, value: &str) -> Result<(), String>;
    fn get_root_key_typed(&self) -> Result<Option<String>, ProtectedError> {
        self.get_root_key()
            .map_err(|_| ProtectedError::unavailable("root-provider-unavailable"))
    }
    fn set_root_key_typed(&self, value: &str) -> Result<(), ProtectedError> {
        self.set_root_key(value)
            .map_err(|_| ProtectedError::unavailable("root-provider-unavailable"))
    }
}
pub fn validate_ref(reference: &str) -> Result<(), String> {
    if !reference.starts_with("purr/")
        || reference.len() > 512
        || reference.contains("..")
        || !reference
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_-".contains(&b))
    {
        return Err("Invalid secure reference".into());
    }
    Ok(())
}
pub fn validate_secret_ref(reference: &str) -> Result<(), String> {
    validate_ref(reference)?;
    if reference == ROOT_KEY_REF {
        return Err("Internal encryption keys are not accessible as credentials".into());
    }
    Ok(())
}

const ROOT_KEY_FILE: &str = "root-key-v1";

#[cfg(test)]
fn read_root_key_file(path: &Path) -> Result<Option<String>, String> {
    read_root_key_file_typed(path).map_err(|error| error.to_string())
}
fn read_root_key_file_typed(path: &Path) -> Result<Option<String>, ProtectedError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() => {
            return Err(ProtectedError::corrupt("root-key-invalid"))
        }
        Err(error) if error.kind() != ErrorKind::NotFound => {
            return Err(ProtectedError::unavailable("root-key-metadata-unavailable"))
        }
        _ => {}
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {
            return Err(ProtectedError::denied("root-key-read-denied"))
        }
        Err(_) => return Err(ProtectedError::unavailable("root-key-read-unavailable")),
    };
    let metadata = file
        .metadata()
        .map_err(|_| ProtectedError::unavailable("root-key-metadata-unavailable"))?;
    if !metadata.is_file() || metadata.len() > 1024 {
        return Err(ProtectedError::corrupt("root-key-invalid"));
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(ProtectedError::denied("root-key-unsafe-permissions"));
    }
    let mut value = Zeroizing::new(String::new());
    file.read_to_string(&mut value)
        .map_err(|error| match error.kind() {
            ErrorKind::InvalidData => ProtectedError::corrupt("root-key-invalid"),
            ErrorKind::PermissionDenied => ProtectedError::denied("root-key-read-denied"),
            _ => ProtectedError::unavailable("root-key-read-unavailable"),
        })?;
    Ok(Some(value.trim().into()))
}

#[cfg(test)]
fn write_root_key_file(path: &Path, value: &str) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(path)
        .map_err(|_| "Cannot create the local encryption key")?;
    file.write_all(value.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot save the local encryption key".into())
}

#[derive(Clone)]
pub struct LocalCipher(CipherBackend);
#[derive(Clone)]
enum CipherBackend {
    Unavailable,
    Raw(Arc<Aes256Gcm>),
    Scoped {
        registry: Arc<scoped::ScopeRegistry>,
        purpose: scoped::CipherPurpose,
        scope: Option<ProtectionScope>,
    },
}
pub struct RootCiphers {
    pub(crate) storage_initialization: std::sync::Mutex<()>,
    pub database: LocalCipher,
    pub secrets: LocalCipher,
    pub response_content: LocalCipher,
    pub legacy_database: Option<LocalCipher>,
    wrapping: LocalCipher,
    journal_seed: Arc<Zeroizing<[u8; 32]>>,
}

fn derive_key(root: &[u8], info: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    let hkdf = Hkdf::<Sha256>::new(Some(b"purr:root-key:v1"), root);
    let mut derived = Zeroizing::new([0_u8; 32]);
    hkdf.expand(info, &mut *derived)
        .map_err(|_| "Cannot derive local encryption key")?;
    Ok(derived)
}

impl RootCiphers {
    /// A public-storage handle. Every cryptographic operation fails closed.
    pub fn unavailable() -> Self {
        let cipher = LocalCipher(CipherBackend::Unavailable);
        Self {
            storage_initialization: std::sync::Mutex::new(()),
            database: cipher.clone(),
            secrets: cipher.clone(),
            response_content: cipher.clone(),
            legacy_database: None,
            wrapping: cipher,
            journal_seed: Arc::new(Zeroizing::new([0; 32])),
        }
    }
    #[cfg(test)]
    pub fn open(
        store: &dyn RootKeyStore,
        existing_encrypted_data: bool,
        needs_legacy_database_key: bool,
    ) -> Result<Self, String> {
        Self::open_typed(store, existing_encrypted_data, needs_legacy_database_key)
            .map_err(|error| error.to_string())
    }
    #[cfg(test)]
    pub fn open_typed(
        store: &dyn RootKeyStore,
        existing_encrypted_data: bool,
        needs_legacy_database_key: bool,
    ) -> Result<Self, ProtectedError> {
        // RuntimeStorage owns the derived ciphers until process exit.
        let root = match store.get_root_key_typed()? {
            Some(value) => {
                let encoded = Zeroizing::new(value);
                Zeroizing::new(
                    STANDARD
                        .decode(encoded.as_bytes())
                        .map_err(|_| ProtectedError::corrupt("root-key-invalid"))?,
                )
            }
            None if existing_encrypted_data => {
                return Err(ProtectedError::new(
                    ProtectedStatus::Unavailable,
                    "root-key-missing",
                    false,
                ))
            }
            None => {
                let mut key = Zeroizing::new([0_u8; 32]);
                getrandom::fill(&mut *key).map_err(|_| "Cannot generate local encryption key")?;
                let encoded = Zeroizing::new(STANDARD.encode(key.as_slice()));
                store.set_root_key_typed(&encoded)?;
                Zeroizing::new(key.to_vec())
            }
        };
        if root.len() != 32 {
            return Err(ProtectedError::corrupt("root-key-invalid"));
        }
        Self::from_root(&root, needs_legacy_database_key)
    }
    pub(crate) fn from_root(
        root: &[u8],
        needs_legacy_database_key: bool,
    ) -> Result<Self, ProtectedError> {
        if root.len() != 32 {
            return Err(ProtectedError::corrupt("root-key-invalid"));
        }
        let database_key = derive_key(root, DATABASE_KEY_INFO)?;
        let secrets_key = derive_key(root, SECRETS_KEY_INFO)?;
        let response_content_key = derive_key(root, RESPONSE_CONTENT_KEY_INFO)?;
        let wrapping = derive_key(root, b"purr:installation-wrapping:v2")?;
        Ok(Self {
            wrapping: LocalCipher::from_key(wrapping.as_slice())?,
            journal_seed: Arc::new(derive_key(root, b"purr:installation-journal:v2")?),
            storage_initialization: std::sync::Mutex::new(()),
            database: LocalCipher::from_key(&database_key[..])?,
            secrets: LocalCipher::from_key(&secrets_key[..])?,
            response_content: LocalCipher::from_key(&response_content_key[..])?,
            legacy_database: needs_legacy_database_key
                .then(|| LocalCipher::from_key(root))
                .transpose()?,
        })
    }
    #[cfg(test)]
    pub(crate) fn with_scope_keys(&self, path: &Path, vault_id: &str) -> Result<Self, String> {
        self.with_scope_keys_policy(path, vault_id, true)
    }
    pub(crate) fn with_scope_keys_policy(
        &self,
        path: &Path,
        vault_id: &str,
        allow_initialize: bool,
    ) -> Result<Self, String> {
        let registry = scoped::ScopeRegistry::open(
            path,
            vault_id,
            self.wrapping.clone(),
            self.journal_seed.clone(),
            allow_initialize,
        )?;
        let routed = |purpose| {
            LocalCipher(CipherBackend::Scoped {
                registry: registry.clone(),
                purpose,
                scope: None,
            })
        };
        Ok(Self {
            storage_initialization: std::sync::Mutex::new(()),
            database: routed(scoped::CipherPurpose::Database),
            secrets: routed(scoped::CipherPurpose::Secrets),
            response_content: routed(scoped::CipherPurpose::ResponseContent),
            legacy_database: None,
            wrapping: self.wrapping.clone(),
            journal_seed: self.journal_seed.clone(),
        })
    }
    pub fn is_scoped(&self) -> bool {
        self.database.is_scoped()
    }
    #[cfg(test)]
    pub fn provision_scope(&self, scope: ProtectionScope) -> Result<(), String> {
        self.database.provision_scope(scope)
    }
}

pub struct SealedValue {
    pub version: i64,
    pub nonce: [u8; 12],
    pub ciphertext: Vec<u8>,
}

impl LocalCipher {
    pub fn export_credential_recovery_keys(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<CredentialRecoveryKey>, String> {
        match &self.0 {
            CipherBackend::Scoped {
                registry,
                purpose: scoped::CipherPurpose::Secrets,
                ..
            } => registry.export_credential_recovery_keys(workspace_id),
            _ => Err("credential-scope-registry-required".into()),
        }
    }
    /// Disposable transport key. It is never persisted or exported.
    pub(crate) fn ephemeral() -> Result<Self, String> {
        let mut key = Zeroizing::new([0_u8; 32]);
        getrandom::fill(key.as_mut()).map_err(|_| "Cannot generate upload key")?;
        Self::from_key(key.as_ref())
    }

    fn from_key(key: &[u8]) -> Result<Self, String> {
        Ok(Self(CipherBackend::Raw(Arc::new(
            Aes256Gcm::new_from_slice(key).map_err(|_| "Invalid local encryption key")?,
        ))))
    }
    pub fn is_scoped(&self) -> bool {
        !matches!(self.0, CipherBackend::Raw(_))
    }
    pub fn is_available(&self) -> bool {
        !matches!(self.0, CipherBackend::Unavailable)
    }
    pub fn for_scope(&self, scope: ProtectionScope) -> Result<Self, String> {
        match &self.0 {
            CipherBackend::Unavailable => Err("protected-storage-unavailable".into()),
            CipherBackend::Scoped {
                registry, purpose, ..
            } => {
                registry.ensure_scope(&scope)?;
                Ok(Self(CipherBackend::Scoped {
                    registry: registry.clone(),
                    purpose: *purpose,
                    scope: Some(scope),
                }))
            }
            CipherBackend::Raw(_) => {
                #[cfg(test)]
                {
                    let _ = scope;
                    Ok(self.clone())
                }
                #[cfg(not(test))]
                {
                    let _ = scope;
                    Err("scope-key-registry-required".into())
                }
            }
        }
    }
    pub fn provision_scope(&self, scope: ProtectionScope) -> Result<(), String> {
        match &self.0 {
            CipherBackend::Unavailable => Err("protected-storage-unavailable".into()),
            CipherBackend::Scoped { registry, .. } => registry.provision(scope),
            CipherBackend::Raw(_) => {
                #[cfg(test)]
                {
                    let _ = scope;
                    Ok(())
                }
                #[cfg(not(test))]
                {
                    let _ = scope;
                    Err("scope-key-registry-required".into())
                }
            }
        }
    }
    pub fn seal(&self, bytes: &[u8], aad: &str) -> Result<SealedValue, String> {
        let cipher = match &self.0 {
            CipherBackend::Unavailable => return Err("protected-storage-unavailable".into()),
            CipherBackend::Raw(cipher) => cipher,
            CipherBackend::Scoped {
                registry,
                purpose,
                scope,
            } => {
                return registry.seal(
                    scope.as_ref().ok_or("scope-selection-required")?,
                    *purpose,
                    bytes,
                    aad,
                )
            }
        };
        let mut nonce = [0_u8; 12];
        getrandom::fill(&mut nonce).map_err(|_| "Cannot generate local encryption nonce")?;
        let ciphertext = cipher
            .encrypt(
                &nonce.into(),
                Payload {
                    msg: bytes,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| "Local encryption failed")?;
        Ok(SealedValue {
            version: 1,
            nonce,
            ciphertext,
        })
    }
    pub fn open_sealed(
        &self,
        version: i64,
        nonce: &[u8],
        ciphertext: &[u8],
        aad: &str,
    ) -> Result<Zeroizing<Vec<u8>>, String> {
        let cipher = match &self.0 {
            CipherBackend::Unavailable => return Err("protected-storage-unavailable".into()),
            CipherBackend::Raw(cipher) => cipher,
            CipherBackend::Scoped {
                registry,
                purpose,
                scope,
            } => {
                return registry.open_sealed(
                    scope.as_ref().ok_or("scope-selection-required")?,
                    *purpose,
                    version,
                    nonce,
                    ciphertext,
                    aad,
                )
            }
        };
        if version != 1 || nonce.len() != 12 {
            return Err("Invalid encrypted local data".into());
        }
        cipher
            .decrypt(
                &Nonce::try_from(nonce).map_err(|_| "Invalid encrypted local data")?,
                Payload {
                    msg: ciphertext,
                    aad: aad.as_bytes(),
                },
            )
            .map(Zeroizing::new)
            .map_err(|_| "Cannot decrypt local data; the value or its context was changed".into())
    }
    pub fn encrypt(&self, bytes: &[u8], context: &str) -> Result<Vec<u8>, String> {
        let value = self.seal(bytes, context)?;
        let mut envelope = vec![value.version as u8];
        envelope.extend_from_slice(&value.nonce);
        envelope.extend(value.ciphertext);
        Ok(envelope)
    }
    pub fn decrypt(&self, bytes: &[u8], context: &str) -> Result<Vec<u8>, String> {
        if bytes.len() < 29 || ![1, 2].contains(&bytes[0]) {
            return Err("Invalid encrypted local data".into());
        }
        Ok(self
            .open_sealed(bytes[0] as i64, &bytes[1..13], &bytes[13..], context)?
            .to_vec())
    }
}

#[cfg(test)]
pub(crate) fn test_key() -> [u8; 32] {
    let mut bytes = [std::mem::MaybeUninit::uninit(); 32];
    getrandom::fill_uninit(&mut bytes)
        .expect("OS random source for test key")
        .try_into()
        .expect("fixed key length")
}

#[cfg(test)]
pub(crate) fn test_password() -> String {
    STANDARD.encode(test_key())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryRootState {
        value: Option<String>,
        reads: usize,
        writes: usize,
    }
    #[derive(Default)]
    pub struct MemoryRootKeyStore(Mutex<MemoryRootState>);
    impl MemoryRootKeyStore {
        pub fn reads(&self) -> usize {
            self.0.lock().unwrap().reads
        }
        pub fn writes(&self) -> usize {
            self.0.lock().unwrap().writes
        }
        pub fn remove_key(&self) {
            self.0.lock().unwrap().value = None;
        }
        pub fn has_key(&self) -> bool {
            self.0.lock().unwrap().value.is_some()
        }
    }
    impl RootKeyStore for MemoryRootKeyStore {
        fn get_root_key(&self) -> Result<Option<String>, String> {
            let mut state = self.0.lock().unwrap();
            state.reads += 1;
            Ok(state.value.clone())
        }
        fn set_root_key(&self, value: &str) -> Result<(), String> {
            let mut state = self.0.lock().unwrap();
            state.writes += 1;
            state.value = Some(value.into());
            Ok(())
        }
    }

    #[test]
    fn root_key_reference_is_not_a_credential_reference() {
        assert!(validate_secret_ref(ROOT_KEY_REF).is_err());
        assert!(validate_secret_ref("purr/workspace/auth/token").is_ok());
    }

    #[test]
    fn encryption_authenticates_context_and_tampering() {
        let store = MemoryRootKeyStore::default();
        let ciphers = RootCiphers::open(&store, false, false).unwrap();
        let ciphertext = ciphers
            .database
            .encrypt(b"test-payload", "ws/cookie/1")
            .unwrap();
        assert!(!ciphertext.windows(12).any(|v| v == b"test-payload"));
        assert_eq!(
            ciphers
                .database
                .decrypt(&ciphertext, "ws/cookie/1")
                .unwrap(),
            b"test-payload"
        );
        assert!(ciphers
            .database
            .decrypt(&ciphertext, "other/cookie/1")
            .is_err());
        let mut damaged = ciphertext;
        damaged[15] ^= 1;
        assert!(ciphers.database.decrypt(&damaged, "ws/cookie/1").is_err());
        assert!(store.has_key());
        assert_eq!(store.reads(), 1);
        assert_eq!(store.writes(), 1);
    }

    #[test]
    fn opens_existing_aes256_gcm_ciphertext() {
        // AES-256-GCM, zero key/nonce, empty plaintext and AAD (NIST vector).
        let cipher = LocalCipher::from_key(&[0_u8; 32]).unwrap();
        let tag = [
            0x53, 0x0f, 0x8a, 0xfb, 0xc7, 0x45, 0x36, 0xb9, 0xa9, 0x63, 0xb4, 0xf1, 0xc4, 0xcb,
            0x73, 0x8b,
        ];
        assert_eq!(
            cipher
                .open_sealed(1, &[0_u8; 12], &tag, "")
                .unwrap()
                .as_slice(),
            b""
        );
    }

    #[test]
    fn typed_provider_failures_never_generate_keys_and_can_be_retried() {
        struct Provider {
            reason: ProtectedError,
            writes: std::sync::atomic::AtomicUsize,
        }
        impl RootKeyStore for Provider {
            fn get_root_key(&self) -> Result<Option<String>, String> {
                Err("untrusted platform diagnostic containing private data".into())
            }
            fn get_root_key_typed(&self) -> Result<Option<String>, ProtectedError> {
                Err(self.reason.clone())
            }
            fn set_root_key(&self, _: &str) -> Result<(), String> {
                self.writes
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                Ok(())
            }
        }
        for status in [
            ProtectedStatus::Locked,
            ProtectedStatus::Denied,
            ProtectedStatus::Unavailable,
            ProtectedStatus::Corrupt,
        ] {
            let provider = Provider {
                reason: ProtectedError::new(status, "safe-provider-code", true),
                writes: Default::default(),
            };
            for _ in 0..2 {
                let error = RootCiphers::open_typed(&provider, true, false)
                    .err()
                    .unwrap();
                assert_eq!(error.status, status);
                assert_eq!(error.to_string(), "safe-provider-code");
            }
            assert_eq!(
                provider.writes.load(std::sync::atomic::Ordering::Relaxed),
                0
            );
        }
        let provider = MemoryRootKeyStore::default();
        provider
            .set_root_key("invalid-base64-private-marker")
            .unwrap();
        let error = RootCiphers::open_typed(&provider, true, false)
            .err()
            .unwrap();
        assert_eq!(error.status, ProtectedStatus::Corrupt);
        assert_eq!(error.code, "root-key-invalid");
        assert!(!error.to_string().contains("private-marker"));
    }

    #[test]
    fn encrypted_data_never_creates_a_replacement_for_a_missing_master_key() {
        let store = MemoryRootKeyStore::default();
        let error = RootCiphers::open(&store, true, false).err().unwrap();
        assert_eq!(error, "root-key-missing");
        assert!(!store.has_key());
        assert_eq!(store.reads(), 1);
        assert_eq!(store.writes(), 0);
    }

    #[test]
    fn database_and_secret_keys_are_domain_separated() {
        let root = [7_u8; 32];
        let database = derive_key(&root, DATABASE_KEY_INFO).unwrap();
        let secrets = derive_key(&root, SECRETS_KEY_INFO).unwrap();
        let response_content = derive_key(&root, RESPONSE_CONTENT_KEY_INFO).unwrap();
        assert_ne!(&*database, &*secrets);
        assert_ne!(&*database, &*response_content);
        assert_ne!(&*secrets, &*response_content);
    }

    #[test]
    fn derived_database_key_matches_existing_sha256_hkdf_format() {
        let root: [u8; 32] = std::array::from_fn(|index| index as u8);
        let key = derive_key(&root, DATABASE_KEY_INFO).unwrap();
        let encoded = key
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(
            encoded,
            "d69330ea806cdc19613eb56efbbfc17d8efe819d64f8ea533662ae264c70de91"
        );
    }

    #[test]
    fn local_root_key_file_is_private_and_round_trips() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(ROOT_KEY_FILE);
        write_root_key_file(&path, "private-root").unwrap();
        assert_eq!(
            read_root_key_file(&path).unwrap().as_deref(),
            Some("private-root")
        );
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
