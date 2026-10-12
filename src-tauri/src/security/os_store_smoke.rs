//! Opt-in real macOS adapter smoke. Never part of the ordinary test suite.
//! Each invocation owns an unpredictable service and a temporary profile only.
use super::manager::KeyManager;
use serde::Deserialize;
use std::{path::Path, sync::Arc};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureIdentity {
    app_id: String,
    profile: String,
    vault_id: String,
}

struct SyntheticOsEntry {
    directory: tempfile::TempDir,
    app_id: String,
    profile: String,
    cleaned: bool,
}
impl SyntheticOsEntry {
    fn new() -> Self {
        let mut nonce = [0_u8; 16];
        getrandom::fill(&mut nonce).expect("generate isolated smoke identity");
        let suffix: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
        Self {
            directory: tempfile::tempdir().expect("create isolated smoke profile"),
            app_id: format!("app.purr.synthetic-os-smoke.{suffix}"),
            profile: "test".into(),
            cleaned: false,
        }
    }
    fn path(&self) -> &Path {
        self.directory.path()
    }
    fn manager(&self) -> KeyManager {
        KeyManager::new(
            self.path().into(),
            self.app_id.clone(),
            self.profile.clone(),
            false, // Never consult the historical shared Purr Keychain entry.
        )
    }
    fn cleanup(&mut self) -> Result<(), &'static str> {
        if self.cleaned {
            return Ok(());
        }
        let bytes = match std::fs::read(self.path().join("root-key-metadata-v1.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.cleaned = true;
                return Ok(());
            }
            Err(_) => return Err("cannot read synthetic smoke identity for cleanup"),
        };
        let identity: FixtureIdentity = serde_json::from_slice(&bytes)
            .map_err(|_| "invalid synthetic smoke identity for cleanup")?;
        // Only delete an entry belonging to this exact generated service/profile.
        // Never enumerate the store or use identity from outside our TempDir.
        if identity.app_id != self.app_id
            || identity.profile != self.profile
            || identity.vault_id.len() != 32
            || !identity
                .vault_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("synthetic smoke cleanup identity mismatch");
        }
        let service = format!("{}.root-keys.{}", self.app_id, self.profile);
        let entry = keyring::Entry::new_with_target("User", &service, &identity.vault_id)
            .map_err(|_| "cannot address synthetic smoke entry for cleanup")?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {
                self.cleaned = true;
                Ok(())
            }
            Err(_) => Err("cannot remove synthetic smoke OS entry"),
        }
    }
}
impl Drop for SyntheticOsEntry {
    fn drop(&mut self) {
        if let Err(reason) = self.cleanup() {
            // Never panic while unwinding. Explicit cleanup below makes ordinary
            // cleanup errors fail the test, while Drop covers early assertions.
            eprintln!("Synthetic OS smoke cleanup failed: {reason}");
        }
    }
}

#[test]
#[ignore = "opt-in: creates and removes one unique synthetic macOS Keychain entry"]
fn real_macos_store_roundtrip_reopen_and_cached_access() {
    let mut fixture = SyntheticOsEntry::new();
    let ciphertexts = {
        let manager = fixture.manager();
        let keys = manager.open().expect("initialize synthetic OS-backed root");
        let ciphers = [&keys.database, &keys.secrets, &keys.response_content];
        let ciphertexts: Vec<_> = ciphers
            .iter()
            .map(|cipher| {
                cipher
                    .encrypt(b"purr synthetic OS-store smoke", "synthetic/os-smoke/v1")
                    .expect("encrypt synthetic value")
            })
            .collect();
        for _ in 0..16 {
            let cached = manager.open().expect("use cached root");
            let retried = manager.retry().expect("successful root remains cached");
            assert!(Arc::ptr_eq(&keys, &cached));
            assert!(Arc::ptr_eq(&keys, &retried));
        }
        assert!(!fixture.path().join("root-key-v1").exists());
        ciphertexts
    }; // Drop every manager/cipher: reopening must read the actual OS entry.
    {
        let manager = fixture.manager();
        let keys = manager.open().expect("reopen synthetic OS-backed root");
        for (cipher, ciphertext) in [&keys.database, &keys.secrets, &keys.response_content]
            .into_iter()
            .zip(ciphertexts)
        {
            assert_eq!(
                cipher
                    .decrypt(&ciphertext, "synthetic/os-smoke/v1")
                    .expect("decrypt synthetic value after manager restart"),
                b"purr synthetic OS-store smoke"
            );
            assert!(cipher.decrypt(&ciphertext, "wrong-context").is_err());
        }
        assert!(!fixture.path().join("root-key-v1").exists());
    }
    fixture
        .cleanup()
        .expect("remove only this synthetic smoke OS entry");
}

#[test]
#[ignore = "opt-in: migrates an isolated synthetic file root into macOS Keychain and removes the entry"]
fn real_macos_store_migrates_legacy_file_and_preserves_ciphertext() {
    use super::{write_root_key_file, RootCiphers, ROOT_KEY_FILE};
    use crate::persistence::local_records::LocalStateStore;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use rusqlite::{params, Connection};

    let mut fixture = SyntheticOsEntry::new();
    let root = [47_u8; 32]; // Explicitly synthetic test material only.
    write_root_key_file(&fixture.path().join(ROOT_KEY_FILE), &STANDARD.encode(root))
        .expect("write isolated legacy file root");
    let original = RootCiphers::from_root(&root, true).expect("derive synthetic legacy ciphers");
    let secret_ref = "purr/synthetic-os-smoke/auth/token";
    let secret_aad = format!("purr:secret:v1|{secret_ref}");
    let secret = original
        .secrets
        .seal(b"synthetic retained credential", &secret_aad)
        .expect("seal synthetic credential");
    let database_path = fixture.path().join("local-state.sqlite3");
    {
        let mut database = Connection::open(&database_path).expect("create synthetic SQLite");
        LocalStateStore::migrate(&mut database).expect("create current synthetic schema");
        database
            .execute(
                "INSERT INTO app_state VALUES('crypto-key-derivation','hkdf-sha256-v1')",
                [],
            )
            .expect("record synthetic derivation marker");
        database
            .execute(
                "INSERT INTO secret_values(reference,crypto_version,nonce,ciphertext) VALUES(?1,?2,?3,?4)",
                params![secret_ref, secret.version, secret.nonce.as_slice(), secret.ciphertext],
            )
            .expect("persist synthetic encrypted credential");
    }
    let archive_names = [
        "legacy-workspaces.encrypted",
        "legacy-workspaces.encrypted.synthetic-raw",
    ];
    let archives: Vec<_> = [
        &original.database,
        original
            .legacy_database
            .as_ref()
            .expect("raw archive reader"),
    ]
    .into_iter()
    .zip(archive_names)
    .map(|(cipher, name)| {
        let bytes = cipher
            .encrypt(b"{\"synthetic\":true}", "purr/legacy-archive")
            .expect("encrypt synthetic legacy archive");
        std::fs::write(fixture.path().join(name), &bytes).expect("persist synthetic archive");
        bytes
    })
    .collect();
    drop(original);

    {
        let manager = fixture.manager();
        let keys = manager
            .open()
            .expect("migrate synthetic file root into OS store");
        assert_eq!(
            keys.secrets
                .open_sealed(
                    secret.version,
                    &secret.nonce,
                    &secret.ciphertext,
                    &secret_aad
                )
                .expect("same credential key after migration")
                .as_slice(),
            b"synthetic retained credential"
        );
        assert!(!fixture.path().join(ROOT_KEY_FILE).exists());
        let metadata: serde_json::Value = serde_json::from_slice(
            &std::fs::read(fixture.path().join("root-key-metadata-v1.json"))
                .expect("read synthetic migration metadata"),
        )
        .expect("parse synthetic migration metadata");
        assert_eq!(metadata["phase"], "complete");
    }
    {
        let manager = fixture.manager();
        let keys = manager.open().expect("reopen migrated OS root");
        let database =
            Connection::open_with_flags(&database_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .expect("read synthetic encrypted row after migration");
        let (version, nonce, ciphertext): (i64, Vec<u8>, Vec<u8>) = database
            .query_row(
                "SELECT crypto_version,nonce,ciphertext FROM secret_values WHERE reference=?1",
                [secret_ref],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("load unchanged synthetic ciphertext");
        assert_eq!(ciphertext, secret.ciphertext);
        assert_eq!(nonce, secret.nonce);
        assert_eq!(
            keys.secrets
                .open_sealed(version, &nonce, &ciphertext, &secret_aad)
                .expect("decrypt persisted credential after reopen")
                .as_slice(),
            b"synthetic retained credential"
        );
        for ((cipher, name), before) in [
            &keys.database,
            keys.legacy_database
                .as_ref()
                .expect("retained raw archive reader"),
        ]
        .into_iter()
        .zip(archive_names)
        .zip(archives)
        {
            let after = std::fs::read(fixture.path().join(name)).expect("read retained archive");
            assert_eq!(after, before);
            assert_eq!(
                cipher
                    .decrypt(&after, "purr/legacy-archive")
                    .expect("decrypt retained archive"),
                b"{\"synthetic\":true}"
            );
        }
        assert!(!fixture.path().join(ROOT_KEY_FILE).exists());
    }
    fixture
        .cleanup()
        .expect("remove exact migrated synthetic OS entry");
}
