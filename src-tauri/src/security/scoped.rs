//! Independent random protection scopes, wrapped by the fresh installation key.
use super::{derive_key, LocalCipher, SealedValue};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
};
use zeroize::Zeroizing;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum ProtectionScope {
    WorkspaceCredential { workspace_id: String },
    WorkspaceRuntime { workspace_id: String },
    GlobalCredential,
    GlobalRuntime,
    InstallationJournal,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireScope {
    owner: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_id: Option<String>,
    kind: String,
}
impl Serialize for ProtectionScope {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let (owner, workspace_id, kind) = match self {
            Self::WorkspaceCredential { workspace_id } => {
                ("workspace", Some(workspace_id.clone()), "credentials")
            }
            Self::WorkspaceRuntime { workspace_id } => {
                ("workspace", Some(workspace_id.clone()), "runtime")
            }
            Self::GlobalCredential => ("global", None, "credentials"),
            Self::GlobalRuntime => ("global", None, "runtime"),
            Self::InstallationJournal => ("installation", None, "journal"),
        };
        WireScope {
            owner: owner.into(),
            workspace_id,
            kind: kind.into(),
        }
        .serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for ProtectionScope {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = WireScope::deserialize(deserializer)?;
        let value = match (wire.owner.as_str(), wire.kind.as_str(), wire.workspace_id) {
            ("workspace", "credentials", Some(workspace_id)) => {
                Self::WorkspaceCredential { workspace_id }
            }
            ("workspace", "runtime", Some(workspace_id)) => Self::WorkspaceRuntime { workspace_id },
            ("global", "credentials", None) => Self::GlobalCredential,
            ("global", "runtime", None) => Self::GlobalRuntime,
            ("installation", "journal", None) => Self::InstallationJournal,
            _ => return Err(serde::de::Error::custom("invalid protection scope")),
        };
        value.validate().map_err(serde::de::Error::custom)?;
        Ok(value)
    }
}
impl ProtectionScope {
    pub fn runtime(workspace: &str) -> Self {
        if workspace == "__global__" {
            Self::GlobalRuntime
        } else {
            Self::WorkspaceRuntime {
                workspace_id: workspace.into(),
            }
        }
    }
    pub fn journal() -> Self {
        Self::InstallationJournal
    }
    pub fn from_secret_ref(reference: &str) -> Result<Self, String> {
        super::validate_secret_ref(reference)?;
        let mut parts = reference.split('/');
        if parts.next() != Some("purr") {
            return Err("secret-scope-invalid".into());
        }
        let owner = parts.next().ok_or("secret-scope-invalid")?;
        let kind = parts.next().ok_or("secret-scope-invalid")?;
        if parts.next().is_none_or(str::is_empty) {
            return Err("secret-scope-invalid".into());
        }
        let scope = match (owner, kind) {
            ("global", "credentials") => Self::GlobalCredential,
            ("global", "runtime") => Self::GlobalRuntime,
            (_, "credentials") => Self::WorkspaceCredential {
                workspace_id: owner.into(),
            },
            (_, "runtime") => Self::WorkspaceRuntime {
                workspace_id: owner.into(),
            },
            _ => return Err("secret-scope-invalid".into()),
        };
        scope.validate()?;
        Ok(scope)
    }
    fn validate(&self) -> Result<(), String> {
        if let Self::WorkspaceCredential { workspace_id }
        | Self::WorkspaceRuntime { workspace_id } = self
        {
            if workspace_id.is_empty()
                || workspace_id.len() > 200
                || (workspace_id == "__global__" || workspace_id == "global")
                || !workspace_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            {
                return Err("scope-identity-invalid".into());
            }
        }
        Ok(())
    }
    fn identity(&self) -> Result<String, String> {
        self.validate()?;
        serde_json::to_string(self).map_err(|_| "scope-identity-invalid".into())
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub(super) enum CipherPurpose {
    Database,
    Secrets,
    ResponseContent,
}
impl CipherPurpose {
    fn info(self) -> &'static [u8] {
        match self {
            Self::Database => b"purr:scope:database:v2",
            Self::Secrets => b"purr:scope:secrets:v2",
            Self::ResponseContent => b"purr:scope:response-content:v2",
        }
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct KeyIdentity {
    vault_id: String,
    key_id: String,
    generation: u32,
    scope: ProtectionScope,
}

/// Sensitive native-only recovery material. Never expose through IPC or logs.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CredentialRecoveryKey {
    identity: KeyIdentity,
    root: Zeroizing<Vec<u8>>,
    keycheck: Vec<u8>,
}
impl CredentialRecoveryKey {
    pub fn key_id(&self) -> &str {
        &self.identity.key_id
    }
    pub fn validate(&self, workspace_id: &str) -> Result<(), String> {
        let scope = ProtectionScope::WorkspaceCredential {
            workspace_id: workspace_id.into(),
        };
        scope.validate()?;
        if self.identity.scope != scope
            || self.identity.generation != 1
            || self.identity.vault_id.is_empty()
            || self.identity.vault_id.len() > 200
            || self.identity.key_id.len() != 32
            || !self.identity.key_id.bytes().all(|b| b.is_ascii_hexdigit())
            || self.root.len() != 32
            || self.keycheck.len() > 256
        {
            return Err("recovery-key-identity-invalid".into());
        }
        let check = Zeroizing::new(
            LocalCipher::from_key(&self.root)?
                .decrypt(&self.keycheck, &keycheck_aad(&self.identity)?)?,
        );
        if check.as_slice() != b"purr-scope-key-v2" {
            return Err("recovery-key-invalid".into());
        }
        Ok(())
    }
}

/// Opens a matching credential row without any source installation/runtime key.
pub fn decrypt_recovery_secret(
    keys: &[CredentialRecoveryKey],
    workspace_id: &str,
    reference: &str,
    version: i64,
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<Zeroizing<Vec<u8>>, String> {
    let scope = ProtectionScope::WorkspaceCredential {
        workspace_id: workspace_id.into(),
    };
    scope.validate()?;
    if ProtectionScope::from_secret_ref(reference)? != scope {
        return Err("recovery-secret-owner-mismatch".into());
    }
    if version != 2 || ciphertext.len() < 4 {
        return Err("scope-envelope-version-invalid".into());
    }
    let length = u32::from_be_bytes(
        ciphertext[..4]
            .try_into()
            .map_err(|_| "scope-envelope-invalid")?,
    ) as usize;
    if length > 4096 || ciphertext.len() < 4 + length + 16 {
        return Err("scope-envelope-invalid".into());
    }
    let header_bytes = &ciphertext[4..4 + length];
    let header: EnvelopeHeader =
        serde_json::from_slice(header_bytes).map_err(|_| "scope-envelope-invalid")?;
    if header.version != 2
        || header.algorithm != "aes-256-gcm"
        || header.purpose != CipherPurpose::Secrets
        || header.key.scope != scope
    {
        return Err("scope-envelope-owner-mismatch".into());
    }
    let mut matching = keys.iter().filter(|key| key.identity == header.key);
    let key = matching.next().ok_or("recovery-key-missing")?;
    if matching.next().is_some() {
        return Err("recovery-key-duplicate".into());
    }
    key.validate(workspace_id)?;
    let derived = derive_key(&key.root, CipherPurpose::Secrets.info())?;
    LocalCipher::from_key(derived.as_slice())?.open_sealed(
        1,
        nonce,
        &ciphertext[4 + length..],
        &envelope_aad(header_bytes, &format!("purr:secret:v1|{reference}")),
    )
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct EnvelopeHeader {
    version: u8,
    algorithm: String,
    key: KeyIdentity,
    purpose: CipherPurpose,
}
struct ScopeKey {
    identity: KeyIdentity,
    root: Zeroizing<Vec<u8>>,
    ciphers: Mutex<HashMap<CipherPurpose, LocalCipher>>,
}
impl ScopeKey {
    fn cipher(&self, purpose: CipherPurpose) -> Result<LocalCipher, String> {
        let mut ciphers = self
            .ciphers
            .lock()
            .map_err(|_| "scope-key-cache-unavailable")?;
        if let Some(cipher) = ciphers.get(&purpose) {
            return Ok(cipher.clone());
        }
        let key = derive_key(&self.root, purpose.info())?;
        let cipher = LocalCipher::from_key(key.as_slice())?;
        ciphers.insert(purpose, cipher.clone());
        Ok(cipher)
    }
}
struct RegistryState {
    database: Connection,
    keys: HashMap<String, Arc<ScopeKey>>,
}
pub(super) struct ScopeRegistry {
    vault_id: String,
    wrapping: LocalCipher,
    journal_seed: Arc<Zeroizing<[u8; 32]>>,
    state: Mutex<RegistryState>,
}
fn storage_error(_: rusqlite::Error) -> String {
    "scope-key-registry-unavailable".into()
}
fn encoded<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|_| "scope-envelope-invalid".into())
}
fn wrap_aad(identity: &KeyIdentity) -> Result<String, String> {
    Ok(format!("purr:wrapped-scope-key:v2|{}", encoded(identity)?))
}
fn keycheck_aad(identity: &KeyIdentity) -> Result<String, String> {
    Ok(format!("purr:scope-keycheck:v2|{}", encoded(identity)?))
}
fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "scope-key-random-unavailable")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
impl ScopeRegistry {
    pub(super) fn open(
        path: &Path,
        vault_id: &str,
        wrapping: LocalCipher,
        journal_seed: Arc<Zeroizing<[u8; 32]>>,
        allow_initialize: bool,
    ) -> Result<Arc<Self>, String> {
        if vault_id.is_empty() || vault_id.len() > 200 {
            return Err("scope-vault-identity-invalid".into());
        }
        let exists = match std::fs::symlink_metadata(path) {
            Ok(meta) if meta.is_file() => true,
            Ok(_) => return Err("scope-key-registry-invalid".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => return Err("scope-key-registry-unavailable".into()),
        };
        if !exists {
            for suffix in ["-wal", "-shm", "-journal"] {
                let sidecar = path.with_file_name(format!(
                    "{}{suffix}",
                    path.file_name()
                        .ok_or("scope-key-registry-invalid")?
                        .to_string_lossy()
                ));
                match std::fs::symlink_metadata(sidecar) {
                    Ok(_) => return Err("scope-key-registry-missing".into()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return Err("scope-key-registry-unavailable".into()),
                }
            }
        }
        if !exists && !allow_initialize {
            return Err("scope-key-registry-missing".into());
        }
        if !exists
            && path.parent().is_some_and(|p| {
                p.join("local-state.sqlite3").exists()
                    && !super::inventory::EncryptedInventory::inspect(p)
                        .is_ok_and(|inventory| inventory.is_public_profile())
            })
        {
            return Err("scope-key-registry-missing".into());
        }
        let canonical_parent = path
            .parent()
            .ok_or("scope-key-registry-invalid")?
            .canonicalize()
            .map_err(|_| "scope-key-registry-unavailable")?;
        let canonical_path =
            canonical_parent.join(path.file_name().ok_or("scope-key-registry-invalid")?);
        let mut db = Connection::open_with_flags(
            canonical_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
                | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(storage_error)?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(storage_error)?;
        db.pragma_update(None, "synchronous", "FULL")
            .map_err(storage_error)?;
        let version: i64 = db
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(storage_error)?;
        let empty_schema: bool = db
            .query_row(
                "SELECT NOT EXISTS(SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%')",
                [],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        let initialize = !exists
            || (version == 0
                && empty_schema
                && allow_initialize
                && !path.parent().is_some_and(|p| {
                    p.join("local-state.sqlite3").exists()
                        && !super::inventory::EncryptedInventory::inspect(p)
                            .is_ok_and(|inventory| inventory.is_public_profile())
                }));
        if initialize {
            let tx = db.transaction().map_err(storage_error)?;
            tx.execute_batch("CREATE TABLE registry_identity(vault_id TEXT NOT NULL, keycheck BLOB NOT NULL, initialized INTEGER NOT NULL); CREATE TABLE protection_scopes(scope TEXT PRIMARY KEY,active_key_id TEXT NOT NULL); CREATE TABLE wrapped_scope_keys(key_id TEXT PRIMARY KEY,scope TEXT NOT NULL,identity TEXT NOT NULL,wrapped BLOB NOT NULL,keycheck BLOB NOT NULL); PRAGMA user_version=1;").map_err(storage_error)?;
            let check = wrapping.encrypt(
                b"purr-scope-registry-v2",
                &format!("purr:scope-registry:v2|{vault_id}"),
            )?;
            tx.execute(
                "INSERT INTO registry_identity VALUES(?1,?2,0)",
                params![vault_id, check],
            )
            .map_err(storage_error)?;
            tx.commit().map_err(storage_error)?;
        } else if version != 1 {
            return Err("scope-key-registry-version-invalid".into());
        }
        let identity_rows: i64 = db
            .query_row("SELECT COUNT(*) FROM registry_identity", [], |row| {
                row.get(0)
            })
            .map_err(storage_error)?;
        if identity_rows != 1 {
            return Err("scope-key-registry-identity-invalid".into());
        }
        let (stored_vault, check, initialized): (String, Vec<u8>, bool) = db
            .query_row(
                "SELECT vault_id,keycheck,initialized FROM registry_identity",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(storage_error)?;
        if stored_vault != vault_id
            || wrapping.decrypt(&check, &format!("purr:scope-registry:v2|{vault_id}"))?
                != b"purr-scope-registry-v2"
        {
            return Err("scope-key-registry-key-mismatch".into());
        }
        let registry = Arc::new(Self {
            vault_id: vault_id.into(),
            wrapping,
            journal_seed,
            state: Mutex::new(RegistryState {
                database: db,
                keys: HashMap::new(),
            }),
        });
        if !initialized {
            if !allow_initialize {
                return Err("scope-key-registry-incomplete".into());
            }
            if path.parent().is_some_and(|p| {
                p.join("local-state.sqlite3").exists()
                    && !super::inventory::EncryptedInventory::inspect(p)
                        .is_ok_and(|inventory| inventory.is_public_profile())
            }) {
                return Err("scope-key-registry-incomplete".into());
            }
            for scope in [
                ProtectionScope::GlobalCredential,
                ProtectionScope::GlobalRuntime,
                ProtectionScope::InstallationJournal,
            ] {
                registry.provision(scope)?;
            }
            registry
                .state
                .lock()
                .map_err(|_| "scope-key-cache-unavailable")?
                .database
                .execute("UPDATE registry_identity SET initialized=1", [])
                .map_err(storage_error)?;
        }
        Ok(registry)
    }
    pub(super) fn provision(&self, scope: ProtectionScope) -> Result<(), String> {
        let identity = scope.identity()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "scope-key-cache-unavailable")?;
        let active: Option<String> = state
            .database
            .query_row(
                "SELECT active_key_id FROM protection_scopes WHERE scope=?1",
                [&identity],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        if let Some(key_id) = active {
            self.load_key(&mut state, &scope, &key_id)?;
            return Ok(());
        }
        let orphan: bool = state
            .database
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM wrapped_scope_keys WHERE scope=?1)",
                [&identity],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if orphan {
            return Err("scope-key-metadata-missing".into());
        }
        let mut root = Zeroizing::new(vec![0u8; 32]);
        if scope == ProtectionScope::InstallationJournal {
            root.copy_from_slice(self.journal_seed.as_slice());
        } else {
            getrandom::fill(&mut root).map_err(|_| "scope-key-random-unavailable")?;
        }
        let key_identity = KeyIdentity {
            vault_id: self.vault_id.clone(),
            key_id: random_id()?,
            generation: 1,
            scope,
        };
        let wrapped = self.wrapping.encrypt(&root, &wrap_aad(&key_identity)?)?;
        let check_cipher = LocalCipher::from_key(&root)?;
        let keycheck = check_cipher.encrypt(b"purr-scope-key-v2", &keycheck_aad(&key_identity)?)?;
        let tx = state.database.transaction().map_err(storage_error)?;
        tx.execute(
            "INSERT INTO wrapped_scope_keys VALUES(?1,?2,?3,?4,?5)",
            params![
                key_identity.key_id,
                identity,
                encoded(&key_identity)?,
                wrapped,
                keycheck
            ],
        )
        .map_err(storage_error)?;
        tx.execute(
            "INSERT INTO protection_scopes VALUES(?1,?2)",
            params![identity, key_identity.key_id],
        )
        .map_err(storage_error)?;
        tx.commit().map_err(storage_error)?;
        state.keys.insert(
            key_identity.key_id.clone(),
            Arc::new(ScopeKey {
                identity: key_identity,
                root,
                ciphers: Mutex::new(HashMap::new()),
            }),
        );
        Ok(())
    }
    fn load_key(
        &self,
        state: &mut RegistryState,
        scope: &ProtectionScope,
        key_id: &str,
    ) -> Result<Arc<ScopeKey>, String> {
        if let Some(key) = state.keys.get(key_id) {
            if &key.identity.scope != scope {
                return Err("scope-key-owner-mismatch".into());
            }
            return Ok(key.clone());
        }
        let row: Option<(String, String, Vec<u8>, Vec<u8>)> = state
            .database
            .query_row(
                "SELECT scope,identity,wrapped,keycheck FROM wrapped_scope_keys WHERE key_id=?1",
                [key_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(storage_error)?;
        let (stored_scope, identity, wrapped, keycheck) = row.ok_or("scope-key-missing")?;
        if stored_scope != scope.identity()? {
            return Err("scope-key-owner-mismatch".into());
        }
        let identity: KeyIdentity =
            serde_json::from_str(&identity).map_err(|_| "scope-key-metadata-invalid")?;
        if identity.vault_id != self.vault_id
            || identity.key_id != key_id
            || identity.scope != *scope
            || identity.generation != 1
        {
            return Err("scope-key-owner-mismatch".into());
        }
        let root = Zeroizing::new(self.wrapping.decrypt(&wrapped, &wrap_aad(&identity)?)?);
        if root.len() != 32 {
            return Err("scope-key-invalid".into());
        }
        if LocalCipher::from_key(&root)?.decrypt(&keycheck, &keycheck_aad(&identity)?)?
            != b"purr-scope-key-v2"
        {
            return Err("scope-key-invalid".into());
        }
        let key = Arc::new(ScopeKey {
            identity,
            root,
            ciphers: Mutex::new(HashMap::new()),
        });
        state.keys.insert(key_id.into(), key.clone());
        Ok(key)
    }
    fn active_key(&self, scope: &ProtectionScope) -> Result<Arc<ScopeKey>, String> {
        let identity = scope.identity()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "scope-key-cache-unavailable")?;
        let id: Option<String> = state
            .database
            .query_row(
                "SELECT active_key_id FROM protection_scopes WHERE scope=?1",
                [identity],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        self.load_key(&mut state, scope, &id.ok_or("scope-key-missing")?)
    }
    pub(super) fn ensure_scope(&self, scope: &ProtectionScope) -> Result<(), String> {
        self.active_key(scope).map(|_| ())
    }
    pub(super) fn export_credential_recovery_keys(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<CredentialRecoveryKey>, String> {
        let scope = ProtectionScope::WorkspaceCredential {
            workspace_id: workspace_id.into(),
        };
        let identity = scope.identity()?;
        // Check the active key; exporting recovery must never provision or repair scopes.
        self.active_key(&scope)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "scope-key-cache-unavailable")?;
        let ids = {
            let mut statement = state
                .database
                .prepare("SELECT key_id FROM wrapped_scope_keys WHERE scope=?1 ORDER BY key_id")
                .map_err(storage_error)?;
            let rows = statement
                .query_map([identity], |row| row.get::<_, String>(0))
                .map_err(storage_error)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)?
        };
        let mut result = Vec::new();
        for id in ids {
            let key = self.load_key(&mut state, &scope, &id)?;
            let keycheck = state
                .database
                .query_row(
                    "SELECT keycheck FROM wrapped_scope_keys WHERE key_id=?1",
                    [&id],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            let recovery = CredentialRecoveryKey {
                identity: key.identity.clone(),
                root: Zeroizing::new(key.root.to_vec()),
                keycheck,
            };
            recovery.validate(workspace_id)?;
            result.push(recovery);
        }
        Ok(result)
    }
    pub(super) fn seal(
        &self,
        scope: &ProtectionScope,
        purpose: CipherPurpose,
        bytes: &[u8],
        context: &str,
    ) -> Result<SealedValue, String> {
        let key = self.active_key(scope)?;
        let header = EnvelopeHeader {
            version: 2,
            algorithm: "aes-256-gcm".into(),
            key: key.identity.clone(),
            purpose,
        };
        let header = encoded(&header)?;
        let aad = envelope_aad(header.as_bytes(), context);
        let value = key.cipher(purpose)?.seal(bytes, &aad)?;
        let mut ciphertext = Vec::with_capacity(4 + header.len() + value.ciphertext.len());
        ciphertext.extend_from_slice(&(header.len() as u32).to_be_bytes());
        ciphertext.extend_from_slice(header.as_bytes());
        ciphertext.extend(value.ciphertext);
        Ok(SealedValue {
            version: 2,
            nonce: value.nonce,
            ciphertext,
        })
    }
    pub(super) fn open_sealed(
        &self,
        scope: &ProtectionScope,
        purpose: CipherPurpose,
        version: i64,
        nonce: &[u8],
        ciphertext: &[u8],
        context: &str,
    ) -> Result<Zeroizing<Vec<u8>>, String> {
        if version != 2 || ciphertext.len() < 4 {
            return Err("scope-envelope-version-invalid".into());
        }
        let length = u32::from_be_bytes(
            ciphertext[..4]
                .try_into()
                .map_err(|_| "scope-envelope-invalid")?,
        ) as usize;
        if length > 4096 || ciphertext.len() < 4 + length + 16 {
            return Err("scope-envelope-invalid".into());
        }
        let header_bytes = &ciphertext[4..4 + length];
        let header: EnvelopeHeader =
            serde_json::from_slice(header_bytes).map_err(|_| "scope-envelope-invalid")?;
        if header.version != 2
            || header.algorithm != "aes-256-gcm"
            || header.purpose != purpose
            || header.key.scope != *scope
            || header.key.vault_id != self.vault_id
        {
            return Err("scope-envelope-owner-mismatch".into());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "scope-key-cache-unavailable")?;
        let key = self.load_key(&mut state, scope, &header.key.key_id)?;
        if key.identity != header.key {
            return Err("scope-envelope-key-mismatch".into());
        }
        key.cipher(purpose)?.open_sealed(
            1,
            nonce,
            &ciphertext[4 + length..],
            &envelope_aad(header_bytes, context),
        )
    }
}
fn envelope_aad(header: &[u8], context: &str) -> String {
    // Length prefixes avoid ambiguous field boundaries; exact serialized header bytes
    // are authenticated, including fields rejected before attempting decryption.
    format!(
        "purr:scope-envelope:v2|{}:{}|{}:{}",
        header.len(),
        String::from_utf8_lossy(header),
        context.len(),
        context
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::{CipherBackend, RootCiphers};
    static ROOT_KEY: std::sync::LazyLock<[u8; 32]> =
        std::sync::LazyLock::new(crate::security::test_key);
    fn fixture() -> (tempfile::TempDir, RootCiphers) {
        let dir = tempfile::tempdir().unwrap();
        let keys = RootCiphers::from_root(&*ROOT_KEY, false)
            .unwrap()
            .with_scope_keys(&dir.path().join("scope-keys.sqlite3"), "synthetic-vault")
            .unwrap();
        for scope in scopes() {
            keys.provision_scope(scope).unwrap();
        }
        (dir, keys)
    }
    fn scopes() -> Vec<ProtectionScope> {
        vec![
            ProtectionScope::WorkspaceCredential {
                workspace_id: "workspace-a".into(),
            },
            ProtectionScope::WorkspaceRuntime {
                workspace_id: "workspace-a".into(),
            },
            ProtectionScope::WorkspaceCredential {
                workspace_id: "workspace-b".into(),
            },
            ProtectionScope::WorkspaceRuntime {
                workspace_id: "workspace-b".into(),
            },
        ]
    }
    fn registry(keys: &RootCiphers) -> Arc<ScopeRegistry> {
        match &keys.database.0 {
            CipherBackend::Scoped { registry, .. } => registry.clone(),
            _ => panic!("expected scoped fixture"),
        }
    }
    #[test]
    fn detached_recovery_opens_actual_credentials_without_installation_key() {
        let reference = "purr/workspace-a/credentials/requests/token";
        let (dir, keys) = fixture();
        let row = keys
            .secrets
            .for_scope(scopes()[0].clone())
            .unwrap()
            .seal(
                "синтетичний credential".as_bytes(),
                &format!("purr:secret:v1|{reference}"),
            )
            .unwrap();
        let exported = keys
            .secrets
            .export_credential_recovery_keys("workspace-a")
            .unwrap();
        assert_eq!(exported.len(), 1);
        let serialized = Zeroizing::new(serde_json::to_vec(&exported).unwrap());
        drop(exported);
        drop(keys);
        drop(dir);
        let recovered: Vec<CredentialRecoveryKey> = serde_json::from_slice(&serialized).unwrap();
        let plain = decrypt_recovery_secret(
            &recovered,
            "workspace-a",
            reference,
            row.version,
            &row.nonce,
            &row.ciphertext,
        )
        .unwrap();
        assert_eq!(plain.as_slice(), "синтетичний credential".as_bytes());
        assert!(decrypt_recovery_secret(
            &recovered,
            "workspace-b",
            reference,
            row.version,
            &row.nonce,
            &row.ciphertext
        )
        .is_err());
        assert!(decrypt_recovery_secret(
            &recovered,
            "workspace-a",
            "purr/workspace-a/credentials/requests/other",
            row.version,
            &row.nonce,
            &row.ciphertext
        )
        .is_err());
    }
    #[test]
    fn recovery_rejects_other_scopes_purposes_keys_and_corruption() {
        let (_dir, keys) = fixture();
        let recovery = keys
            .secrets
            .export_credential_recovery_keys("workspace-a")
            .unwrap();
        let reference = "purr/workspace-a/credentials/requests/token";
        for scope in scopes().into_iter().skip(1).chain([
            ProtectionScope::GlobalCredential,
            ProtectionScope::GlobalRuntime,
            ProtectionScope::InstallationJournal,
        ]) {
            let row = keys
                .secrets
                .for_scope(scope)
                .unwrap()
                .seal(b"synthetic", &format!("purr:secret:v1|{reference}"))
                .unwrap();
            assert!(decrypt_recovery_secret(
                &recovery,
                "workspace-a",
                reference,
                row.version,
                &row.nonce,
                &row.ciphertext
            )
            .is_err());
        }
        assert!(keys
            .secrets
            .export_credential_recovery_keys("global")
            .is_err());
        assert!(keys
            .database
            .export_credential_recovery_keys("workspace-a")
            .is_err());
        let row = keys
            .database
            .for_scope(scopes()[0].clone())
            .unwrap()
            .seal(b"synthetic", &format!("purr:secret:v1|{reference}"))
            .unwrap();
        assert!(decrypt_recovery_secret(
            &recovery,
            "workspace-a",
            reference,
            row.version,
            &row.nonce,
            &row.ciphertext
        )
        .is_err());
        let mut recovery = recovery;
        recovery[0].root[0] ^= 1;
        assert!(recovery[0].validate("workspace-a").is_err());
    }
    #[test]
    fn scoped_envelopes_roundtrip_and_bind_owner_purpose_record_and_chunk() {
        let (_dir, keys) = fixture();
        let scope = scopes()[0].clone();
        let cipher = keys.secrets.for_scope(scope.clone()).unwrap();
        let envelope = cipher
            .encrypt(b"synthetic-credential", "purr:secret:v1|ref-a")
            .unwrap();
        assert_eq!(envelope[0], 2);
        assert_eq!(
            cipher.decrypt(&envelope, "purr:secret:v1|ref-a").unwrap(),
            b"synthetic-credential"
        );
        for other in scopes().into_iter().skip(1).chain([
            ProtectionScope::GlobalCredential,
            ProtectionScope::GlobalRuntime,
            ProtectionScope::InstallationJournal,
        ]) {
            assert!(keys
                .secrets
                .for_scope(other)
                .unwrap()
                .decrypt(&envelope, "purr:secret:v1|ref-a")
                .is_err());
        }
        assert!(keys
            .database
            .for_scope(scope)
            .unwrap()
            .decrypt(&envelope, "purr:secret:v1|ref-a")
            .is_err());
        assert!(cipher.decrypt(&envelope, "purr:secret:v1|ref-b").is_err());
        assert!(keys
            .secrets
            .encrypt(b"must-explicitly-select", "ref")
            .is_err());
        let runtime = keys
            .response_content
            .for_scope(scopes()[1].clone())
            .unwrap();
        let chunk = runtime
            .seal(b"content", "workspace-a|content|0|0|7")
            .unwrap();
        assert_eq!(chunk.version, 2);
        assert!(runtime
            .open_sealed(
                chunk.version,
                &chunk.nonce,
                &chunk.ciphertext,
                "workspace-a|content|1|0|7"
            )
            .is_err());
        assert!(runtime
            .open_sealed(
                1,
                &chunk.nonce,
                &chunk.ciphertext,
                "workspace-a|content|0|0|7"
            )
            .is_err());
        // A selected journal handle can explicitly select a different owned scope.
        assert!(keys
            .database
            .for_scope(ProtectionScope::journal())
            .unwrap()
            .for_scope(scopes()[1].clone())
            .is_ok());
    }
    #[test]
    fn header_nonce_ciphertext_and_unknown_version_tampering_fail() {
        let (_dir, keys) = fixture();
        let cipher = keys.secrets.for_scope(scopes()[0].clone()).unwrap();
        let sealed = cipher.seal(b"value", "record").unwrap();
        for index in [0, 4, 9, sealed.ciphertext.len() - 1] {
            let mut damaged = sealed.ciphertext.clone();
            damaged[index] ^= 1;
            assert!(cipher
                .open_sealed(2, &sealed.nonce, &damaged, "record")
                .is_err());
        }
        let mut nonce = sealed.nonce;
        nonce[0] ^= 1;
        assert!(cipher
            .open_sealed(2, &nonce, &sealed.ciphertext, "record")
            .is_err());
        assert!(cipher
            .open_sealed(3, &sealed.nonce, &sealed.ciphertext, "record")
            .is_err());
        let len = u32::from_be_bytes(sealed.ciphertext[..4].try_into().unwrap()) as usize;
        let mut header: serde_json::Value =
            serde_json::from_slice(&sealed.ciphertext[4..4 + len]).unwrap();
        header["key"]["generation"] = 2.into();
        let bytes = serde_json::to_vec(&header).unwrap();
        let mut changed = (bytes.len() as u32).to_be_bytes().to_vec();
        changed.extend(bytes);
        changed.extend_from_slice(&sealed.ciphertext[4 + len..]);
        assert!(cipher
            .open_sealed(2, &sealed.nonce, &changed, "record")
            .is_err());
    }
    #[test]
    fn old_installation_and_exported_credential_key_cannot_unlock_other_scopes() {
        let (_dir, keys) = fixture();
        let registry = registry(&keys);
        let credential = registry.active_key(&scopes()[0]).unwrap();
        let runtime = registry.active_key(&scopes()[1]).unwrap();
        assert_ne!(&*credential.root, &*runtime.root);
        let runtime_bytes = runtime
            .cipher(CipherPurpose::Database)
            .unwrap()
            .encrypt(b"private runtime", "runtime")
            .unwrap();
        assert!(credential
            .cipher(CipherPurpose::Database)
            .unwrap()
            .decrypt(&runtime_bytes, "runtime")
            .is_err());
        let journal = registry
            .active_key(&ProtectionScope::InstallationJournal)
            .unwrap();
        let expected_journal = derive_key(&*ROOT_KEY, b"purr:installation-journal:v2").unwrap();
        assert_eq!(journal.root.as_slice(), expected_journal.as_slice());
        let journal_bytes = journal
            .cipher(CipherPurpose::Database)
            .unwrap()
            .encrypt(b"mixed-scope-commit-journal", "commit")
            .unwrap();
        assert!(credential
            .cipher(CipherPurpose::Database)
            .unwrap()
            .decrypt(&journal_bytes, "commit")
            .is_err());
        let state = registry.state.lock().unwrap();
        let wrapped: Vec<u8> = state
            .database
            .query_row(
                "SELECT wrapped FROM wrapped_scope_keys WHERE key_id=?1",
                [&runtime.identity.key_id],
                |row| row.get(0),
            )
            .unwrap();
        let aad = wrap_aad(&runtime.identity).unwrap();
        let old = RootCiphers::from_root(&crate::security::test_key(), false).unwrap();
        assert!(old.wrapping.decrypt(&wrapped, &aad).is_err());
        assert!(LocalCipher::from_key(&credential.root)
            .unwrap()
            .decrypt(&wrapped, &aad)
            .is_err());
    }
    #[test]
    fn registry_reopens_without_plaintext_keys_and_never_replaces_missing_or_corrupt_scopes() {
        let (dir, keys) = fixture();
        let registry = registry(&keys);
        let identity = scopes()[0].identity().unwrap();
        let key = registry.active_key(&scopes()[0]).unwrap();
        let root = key.root.to_vec();
        let key_id = key.identity.key_id.clone();
        let envelope = keys
            .secrets
            .for_scope(scopes()[0].clone())
            .unwrap()
            .encrypt(b"keep", "record")
            .unwrap();
        drop(key);
        drop(registry);
        drop(keys);
        let bytes = std::fs::read(dir.path().join("scope-keys.sqlite3")).unwrap();
        assert!(!bytes.windows(32).any(|b| b == root.as_slice()));
        assert!(!bytes.windows(32).any(|b| b == ROOT_KEY.as_slice()));
        let reopen = || {
            RootCiphers::from_root(&*ROOT_KEY, false)
                .unwrap()
                .with_scope_keys(&dir.path().join("scope-keys.sqlite3"), "synthetic-vault")
                .unwrap()
        };
        {
            let keys = reopen();
            assert_eq!(
                keys.secrets
                    .for_scope(scopes()[0].clone())
                    .unwrap()
                    .decrypt(&envelope, "record")
                    .unwrap(),
                b"keep"
            );
        }
        let database = Connection::open(dir.path().join("scope-keys.sqlite3")).unwrap();
        database
            .execute(
                "UPDATE wrapped_scope_keys SET wrapped=?1 WHERE key_id=?2",
                params![vec![0u8; 30], key_id],
            )
            .unwrap();
        {
            let keys = reopen();
            assert!(keys.secrets.for_scope(scopes()[0].clone()).is_err());
            assert!(keys.provision_scope(scopes()[0].clone()).is_err());
            assert!(keys.secrets.for_scope(scopes()[2].clone()).is_ok());
        }
        database
            .execute("DELETE FROM wrapped_scope_keys WHERE key_id=?1", [&key_id])
            .unwrap();
        {
            let keys = reopen();
            assert!(keys.provision_scope(scopes()[0].clone()).is_err());
            assert!(keys.secrets.for_scope(scopes()[0].clone()).is_err());
        }
        assert_eq!(
            database
                .query_row(
                    "SELECT active_key_id FROM protection_scopes WHERE scope=?1",
                    [identity],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            key_id
        );
    }
    #[test]
    fn missing_scope_manifest_does_not_rekey_orphan_wrapped_material() {
        let (dir, keys) = fixture();
        drop(keys);
        let db = Connection::open(dir.path().join("scope-keys.sqlite3")).unwrap();
        db.execute(
            "DELETE FROM protection_scopes WHERE scope=?1",
            [scopes()[0].identity().unwrap()],
        )
        .unwrap();
        let keys = RootCiphers::from_root(&*ROOT_KEY, false)
            .unwrap()
            .with_scope_keys(&dir.path().join("scope-keys.sqlite3"), "synthetic-vault")
            .unwrap();
        assert!(keys.provision_scope(scopes()[0].clone()).is_err());
        assert!(keys.secrets.for_scope(scopes()[2].clone()).is_ok());
    }
    #[test]
    fn provisioning_is_idempotent_and_scopes_are_explicit() {
        let (dir, keys) = fixture();
        let keys = Arc::new(keys);
        let scope = ProtectionScope::WorkspaceCredential {
            workspace_id: "new-workspace".into(),
        };
        assert!(keys.secrets.for_scope(scope.clone()).is_err());
        let workers: Vec<_> = (0..12)
            .map(|_| {
                let keys = keys.clone();
                let scope = scope.clone();
                std::thread::spawn(move || keys.provision_scope(scope).unwrap())
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        let db = Connection::open(dir.path().join("scope-keys.sqlite3")).unwrap();
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM wrapped_scope_keys WHERE scope=?1",
                [scope.identity().unwrap()],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            ProtectionScope::from_secret_ref("purr/global/credentials/token").unwrap(),
            ProtectionScope::GlobalCredential
        );
        assert_eq!(
            ProtectionScope::runtime("__global__"),
            ProtectionScope::GlobalRuntime
        );
        for reference in [
            "purr/workspace/auth/token",
            "purr/workspace/credentials/",
            "purr/__global__/credentials/token",
        ] {
            assert!(ProtectionScope::from_secret_ref(reference).is_err());
        }
        assert!(serde_json::from_value::<ProtectionScope>(
            serde_json::json!({"owner":"global","kind":"runtime","workspaceId":"extra"})
        )
        .is_err());
        assert!(serde_json::from_value::<ProtectionScope>(
            serde_json::json!({"owner":"workspace","kind":"credentials","workspaceId":"global"})
        )
        .is_err());
    }
    #[test]
    fn wrong_vault_wrong_wrapping_key_and_missing_registry_fail_closed() {
        let (dir, keys) = fixture();
        drop(keys);
        let path = dir.path().join("scope-keys.sqlite3");
        assert!(RootCiphers::from_root(&*ROOT_KEY, false)
            .unwrap()
            .with_scope_keys(&path, "other-vault")
            .is_err());
        assert!(RootCiphers::from_root(&crate::security::test_key(), false)
            .unwrap()
            .with_scope_keys(&path, "synthetic-vault")
            .is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::write(dir.path().join("local-state.sqlite3"), []).unwrap();
        assert!(RootCiphers::from_root(&*ROOT_KEY, false)
            .unwrap()
            .with_scope_keys(&path, "synthetic-vault")
            .is_err());
        assert!(!path.exists());
    }
}
