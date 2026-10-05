use aes_gcm::{
    aead::{rand_core::RngCore, Aead, AeadCore, KeyInit, OsRng, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use hkdf::Hkdf;
use sha2::Sha256;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;

const KEYCHAIN_SERVICE: &str = "app.purr.credentials";
pub const ROOT_KEY_REF: &str = "purr/local-storage/master-key-v1";
const DATABASE_KEY_INFO: &[u8] = b"purr:database:v1";
const SECRETS_KEY_INFO: &[u8] = b"purr:secrets:v1";
const RESPONSE_CONTENT_KEY_INFO: &[u8] = b"purr:response-content:v1";

// Application storage owns one root key only. SecretRef values are handled by
// the encrypted SQLite vault and never become individual files or Keychain items.
pub trait RootKeyStore: Send + Sync {
    fn get_root_key(&self) -> Result<Option<String>, String>;
    fn set_root_key(&self, value: &str) -> Result<(), String>;
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

pub struct PlatformRootKeyStore {
    path: PathBuf,
}

impl PlatformRootKeyStore {
    pub fn new(data_directory: &Path) -> Self {
        Self {
            path: data_directory.join(ROOT_KEY_FILE),
        }
    }
}

fn read_root_key_file(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(value) => {
            #[cfg(unix)]
            if fs::metadata(path)
                .map_err(|_| "Cannot inspect the local encryption key")?
                .permissions()
                .mode()
                & 0o077
                != 0
            {
                return Err("The local encryption key has unsafe file permissions".into());
            }
            Ok(Some(value.trim().into()))
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Cannot read the local encryption key".into()),
    }
}

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

#[cfg(target_os = "macos")]
impl RootKeyStore for PlatformRootKeyStore {
    fn get_root_key(&self) -> Result<Option<String>, String> {
        if let Some(value) = read_root_key_file(&self.path)? {
            return Ok(Some(value));
        }
        // Versions before 0.1.2 stored this root in Keychain. Read it only
        // when no file key exists, then migrate so unsigned updates no longer
        // cause macOS to authorize each changed application binary.
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, ROOT_KEY_REF)
            .map_err(|_| "Secure store is unavailable")?;
        match entry.get_password() {
            Ok(value) => {
                write_root_key_file(&self.path, &value)?;
                Ok(Some(value))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Cannot read from secure store".into()),
        }
    }
    fn set_root_key(&self, value: &str) -> Result<(), String> {
        write_root_key_file(&self.path, value)
    }
}
// Other platforms deliberately fail closed until their native adapters are added.
#[cfg(not(target_os = "macos"))]
impl RootKeyStore for PlatformRootKeyStore {
    fn get_root_key(&self) -> Result<Option<String>, String> {
        Err("Native secure store is not configured for this platform".into())
    }
    fn set_root_key(&self, _: &str) -> Result<(), String> {
        Err("Native secure store is not configured for this platform".into())
    }
}

pub struct LocalCipher(Aes256Gcm);
pub struct RootCiphers {
    pub database: LocalCipher,
    pub secrets: LocalCipher,
    pub response_content: LocalCipher,
    pub legacy_database: Option<LocalCipher>,
}

fn derive_key(root: &[u8], info: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    let hkdf = Hkdf::<Sha256>::new(Some(b"purr:root-key:v1"), root);
    let mut derived = Zeroizing::new([0_u8; 32]);
    hkdf.expand(info, &mut *derived)
        .map_err(|_| "Cannot derive local encryption key")?;
    Ok(derived)
}

impl RootCiphers {
    pub fn open(
        store: &dyn RootKeyStore,
        existing_encrypted_data: bool,
        needs_legacy_database_key: bool,
    ) -> Result<Self, String> {
        // RuntimeStorage owns the derived ciphers until process exit.
        let root = match store.get_root_key()? {
            Some(value) => {
                let encoded = Zeroizing::new(value);
                Zeroizing::new(
                    STANDARD
                        .decode(encoded.as_bytes())
                        .map_err(|_| "Invalid local encryption key")?,
                )
            }
            None if existing_encrypted_data => return Err("The local encryption key is missing. Restore the key before opening this database; no replacement key was created.".into()),
            None => {
                let mut key = Zeroizing::new([0_u8; 32]);
                OsRng.fill_bytes(&mut *key);
                let encoded = Zeroizing::new(STANDARD.encode(key.as_slice()));
                store.set_root_key(&encoded)?;
                Zeroizing::new(key.to_vec())
            }
        };
        if root.len() != 32 {
            return Err("Invalid local encryption key".into());
        }
        let database_key = derive_key(&root, DATABASE_KEY_INFO)?;
        let secrets_key = derive_key(&root, SECRETS_KEY_INFO)?;
        let response_content_key = derive_key(&root, RESPONSE_CONTENT_KEY_INFO)?;
        Ok(Self {
            database: LocalCipher::from_key(&database_key[..])?,
            secrets: LocalCipher::from_key(&secrets_key[..])?,
            response_content: LocalCipher::from_key(&response_content_key[..])?,
            legacy_database: needs_legacy_database_key
                .then(|| LocalCipher::from_key(&root))
                .transpose()?,
        })
    }
}

pub struct SealedValue {
    pub version: i64,
    pub nonce: [u8; 12],
    pub ciphertext: Vec<u8>,
}

impl LocalCipher {
    fn from_key(key: &[u8]) -> Result<Self, String> {
        Ok(Self(
            Aes256Gcm::new_from_slice(key).map_err(|_| "Invalid local encryption key")?,
        ))
    }
    pub fn seal(&self, bytes: &[u8], aad: &str) -> Result<SealedValue, String> {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = self
            .0
            .encrypt(
                &nonce,
                Payload {
                    msg: bytes,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| "Local encryption failed")?;
        Ok(SealedValue {
            version: 1,
            nonce: nonce.into(),
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
        if version != 1 || nonce.len() != 12 {
            return Err("Invalid encrypted local data".into());
        }
        self.0
            .decrypt(
                Nonce::from_slice(nonce),
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
        if bytes.len() < 29 || bytes[0] != 1 {
            return Err("Invalid encrypted local data".into());
        }
        Ok(self
            .open_sealed(bytes[0] as i64, &bytes[1..13], &bytes[13..], context)?
            .to_vec())
    }
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
    fn encrypted_data_never_creates_a_replacement_for_a_missing_master_key() {
        let store = MemoryRootKeyStore::default();
        let error = RootCiphers::open(&store, true, false).err().unwrap();
        assert!(error.contains("local encryption key is missing"));
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
    fn platform_adapter_is_root_key_only() {
        fn accepts_root_store(_: &dyn RootKeyStore) {}
        let directory = tempfile::tempdir().unwrap();
        accepts_root_store(&PlatformRootKeyStore::new(directory.path()));
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
