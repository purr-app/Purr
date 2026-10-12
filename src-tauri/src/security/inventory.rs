//! Read-only inventory of every ciphertext owner, before root-key publication.
use super::{LocalCipher, ProtectedError, RootCiphers};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

const DATABASE: &str = "local-state.sqlite3";
const GENERIC: &[&str] = &[
    "workspace_local_state",
    "drafts",
    "document_session_state",
    "request_executions",
    "cookie_jar",
    "schema_cache",
    "recent_items",
    "attachments",
];
const EXTRA: &[(&str, i64)] = &[
    ("pending_commits", 1),
    ("response_bodies", 2),
    ("secret_values", 3),
    ("response_content_chunks", 4),
    ("history_attachments", 5),
    ("secret_operations", 6),
    ("workspace_cleanup", 6),
];

pub struct EncryptedInventory {
    data: PathBuf,
    database: PathBuf,
    encrypted: bool,
}

fn unknown() -> ProtectedError {
    ProtectedError::unavailable("root-inventory-unavailable")
}
fn corrupt() -> ProtectedError {
    ProtectedError::corrupt("root-inventory-corrupt")
}
fn invalid_ciphertext() -> ProtectedError {
    ProtectedError::corrupt("root-key-conflict")
}

fn regular_file(path: &Path) -> Result<bool, ProtectedError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(corrupt()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(unknown()),
    }
}

// Old archive writers used tempfile's default .tmp prefix. Do not silently
// ignore an interrupted archive just because its final name was not published.
fn archives(data: &Path) -> Result<Vec<PathBuf>, ProtectedError> {
    let entries = match fs::read_dir(data) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err(unknown()),
    };
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| unknown())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == "legacy-workspaces.encrypted"
            || name.starts_with("legacy-workspaces.encrypted.")
            || name.starts_with(".tmp")
        {
            if !regular_file(&entry.path())? {
                return Err(unknown());
            }
            paths.push(entry.path());
        }
    }
    paths.sort();
    Ok(paths)
}

fn open_database(path: &Path) -> Result<Option<Connection>, ProtectedError> {
    if !regular_file(path)? {
        for suffix in ["-wal", "-shm", "-journal"] {
            let mut sidecar = path.as_os_str().to_os_string();
            sidecar.push(suffix);
            if regular_file(&PathBuf::from(sidecar))? {
                return Err(corrupt());
            }
        }
        return Ok(None);
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| unknown())?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| unknown())?;
    db.execute_batch("BEGIN DEFERRED TRANSACTION;")
        .map_err(|_| unknown())?;
    Ok(Some(db))
}

struct DatabaseInventory {
    version: i64,
    tables: BTreeSet<String>,
    encrypted: bool,
    derived: bool,
}
fn database_inventory(db: &Connection) -> Result<DatabaseInventory, ProtectedError> {
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|_| corrupt())?;
    if !(0..=6).contains(&version) {
        return Err(corrupt());
    }
    let mut statement = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .map_err(|_| corrupt())?;
    let tables = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| corrupt())?
        .collect::<Result<BTreeSet<_>, _>>()
        .map_err(|_| corrupt())?;
    let mut expected = BTreeSet::new();
    if version > 0 {
        expected.extend(
            ["migrations", "app_state", "workspaces"]
                .into_iter()
                .map(str::to_string),
        );
        expected.extend(GENERIC.iter().map(|table| (*table).to_string()));
        expected.extend(
            EXTRA
                .iter()
                .filter(|(_, introduced)| *introduced <= version)
                .map(|(table, _)| (*table).to_string()),
        );
        for (introduced, names) in [
            (2, &["cookie_metadata"][..]),
            (4, &["response_contents"][..]),
            (5, &["history_attachment_links"][..]),
            (6, &["secret_revisions"][..]),
        ] {
            if version >= introduced {
                expected.extend(names.iter().map(|name| (*name).to_string()));
            }
        }
    }
    if tables != expected {
        return Err(corrupt());
    }
    // Even empty damaged tables must not authorize creating a replacement root.
    for table in GENERIC {
        if tables.contains(*table) {
            db.prepare(&format!(
                "SELECT workspace_id,id,payload FROM {table} LIMIT 0"
            ))
            .map_err(|_| corrupt())?;
        }
    }
    for (table, columns) in [
        ("pending_commits", "workspace_id,payload"),
        ("response_bodies", "workspace_id,execution_id,payload"),
        ("secret_values", "reference,crypto_version,nonce,ciphertext"),
        (
            "response_content_chunks",
            "content_id,chunk_index,plain_offset,plain_length,crypto_version,nonce,ciphertext",
        ),
        ("history_attachments", "workspace_id,id,payload"),
        ("secret_operations", "operation_id,state,payload"),
        ("workspace_cleanup", "workspace_id,payload"),
    ] {
        if tables.contains(table) {
            db.prepare(&format!("SELECT {columns} FROM {table} LIMIT 0"))
                .map_err(|_| corrupt())?;
        }
    }
    if version >= 5 {
        db.prepare("SELECT summary FROM request_executions LIMIT 0")
            .map_err(|_| corrupt())?;
    }
    let mut encrypted = false;
    for table in GENERIC
        .iter()
        .copied()
        .chain(EXTRA.iter().map(|(table, _)| *table))
    {
        if tables.contains(table) {
            encrypted |= db
                .query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM {table})"),
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|_| corrupt())?;
        }
    }
    let derived = if version > 0 {
        let marker: Option<String> = db
            .query_row(
                "SELECT value FROM app_state WHERE key='crypto-key-derivation'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| corrupt())?;
        match marker.as_deref() {
            None => false,
            Some("hkdf-sha256-v1") => true,
            _ => return Err(corrupt()),
        }
    } else {
        false
    };
    Ok(DatabaseInventory {
        version,
        tables,
        encrypted,
        derived,
    })
}

impl EncryptedInventory {
    pub fn inspect(data: &Path) -> Result<Self, ProtectedError> {
        Self::inspect_database(&data.join(DATABASE))
    }

    pub fn inspect_database(database: &Path) -> Result<Self, ProtectedError> {
        let data = database.parent().ok_or_else(unknown)?;
        let encrypted = match open_database(database)? {
            Some(db) => database_inventory(&db)?.encrypted,
            None => false,
        } | !archives(data)?.is_empty();
        Ok(Self {
            data: data.to_path_buf(),
            database: database.to_path_buf(),
            encrypted,
        })
    }

    pub fn has_encrypted_data(&self) -> bool {
        self.encrypted
    }

    pub fn verify(&self, ciphers: &RootCiphers) -> Result<(), ProtectedError> {
        let db = open_database(&self.database)?;
        let archive_paths = archives(&self.data)?;
        let mut encrypted = !archive_paths.is_empty();
        if let Some(db) = db.as_ref() {
            let inventory = database_inventory(db)?;
            encrypted |= inventory.encrypted;
            verify_database(db, &inventory, ciphers)?;
        }
        if self.encrypted && !encrypted {
            return Err(corrupt());
        }
        for path in archive_paths {
            let bytes = fs::read(path).map_err(|_| unknown())?;
            if verify_envelope(&ciphers.database, &bytes, "purr/legacy-archive").is_err() {
                let legacy = ciphers
                    .legacy_database
                    .as_ref()
                    .ok_or_else(invalid_ciphertext)?;
                verify_envelope(legacy, &bytes, "purr/legacy-archive")?;
            }
        }
        Ok(())
    }
}

// Use the sealed reader directly: its plaintext is zeroized without the
// additional unprotected Vec copy made by the older decrypt convenience API.
fn verify_envelope(cipher: &LocalCipher, bytes: &[u8], aad: &str) -> Result<(), ProtectedError> {
    if bytes.len() < 29 {
        return Err(invalid_ciphertext());
    }
    cipher
        .open_sealed(i64::from(bytes[0]), &bytes[1..13], &bytes[13..], aad)
        .map(|_| ())
        .map_err(|_| invalid_ciphertext())
}

fn verify_rows(
    db: &Connection,
    cipher: &LocalCipher,
    sql: &str,
    aad: impl Fn(&str, &str) -> String,
) -> Result<(), ProtectedError> {
    let mut statement = db.prepare(sql).map_err(|_| corrupt())?;
    let mut rows = statement.query([]).map_err(|_| corrupt())?;
    while let Some(row) = rows.next().map_err(|_| corrupt())? {
        let scope: String = row.get(0).map_err(|_| corrupt())?;
        let id: String = row.get(1).map_err(|_| corrupt())?;
        let payload: Vec<u8> = row.get(2).map_err(|_| corrupt())?;
        verify_envelope(cipher, &payload, &aad(&scope, &id))?;
    }
    Ok(())
}

fn verify_database(
    db: &Connection,
    inventory: &DatabaseInventory,
    ciphers: &RootCiphers,
) -> Result<(), ProtectedError> {
    if !inventory.encrypted {
        return Ok(());
    }
    let database = if inventory.derived {
        &ciphers.database
    } else {
        ciphers
            .legacy_database
            .as_ref()
            .ok_or_else(invalid_ciphertext)?
    };
    for table in GENERIC {
        verify_rows(
            db,
            database,
            &format!("SELECT workspace_id,id,payload FROM {table}"),
            |workspace, id| format!("{workspace}/{table}/{id}"),
        )?;
    }
    let owners = [
        (
            "pending_commits",
            "SELECT workspace_id,'' AS id,payload FROM pending_commits",
            "journal",
        ),
        (
            "response_bodies",
            "SELECT workspace_id,execution_id,payload FROM response_bodies",
            "response_bodies",
        ),
        (
            "history_attachments",
            "SELECT workspace_id,id,payload FROM history_attachments",
            "attachments",
        ),
        (
            "secret_operations",
            "SELECT operation_id,'' AS id,payload FROM secret_operations",
            "purr:operation:v1|",
        ),
        (
            "workspace_cleanup",
            "SELECT workspace_id,'' AS id,payload FROM workspace_cleanup",
            "purr:workspace-cleanup:v1|",
        ),
    ];
    for (table, sql, purpose) in owners {
        if inventory.tables.contains(table) {
            verify_rows(db, database, sql, |scope, id| match table {
                "pending_commits" => format!("{scope}/{purpose}"),
                "secret_operations" | "workspace_cleanup" => format!("{purpose}{scope}"),
                _ => format!("{scope}/{purpose}/{id}"),
            })?;
        }
    }
    if inventory.version >= 5 {
        verify_rows(
            db,
            database,
            "SELECT workspace_id,id,summary FROM request_executions WHERE summary IS NOT NULL",
            |workspace, id| format!("{workspace}/history-summary/{id}"),
        )?;
    }
    if inventory.tables.contains("secret_values") {
        let mut statement = db
            .prepare("SELECT reference,crypto_version,nonce,ciphertext FROM secret_values")
            .map_err(|_| corrupt())?;
        let mut rows = statement.query([]).map_err(|_| corrupt())?;
        while let Some(row) = rows.next().map_err(|_| corrupt())? {
            let reference: String = row.get(0).map_err(|_| corrupt())?;
            let version: i64 = row.get(1).map_err(|_| corrupt())?;
            let nonce: Vec<u8> = row.get(2).map_err(|_| corrupt())?;
            let ciphertext: Vec<u8> = row.get(3).map_err(|_| corrupt())?;
            ciphers
                .secrets
                .open_sealed(
                    version,
                    &nonce,
                    &ciphertext,
                    &format!("purr:secret:v1|{reference}"),
                )
                .map_err(|_| invalid_ciphertext())?;
        }
    }
    if inventory.tables.contains("response_content_chunks") {
        let mut statement = db.prepare("SELECT content_id,chunk_index,plain_offset,plain_length,crypto_version,nonce,ciphertext FROM response_content_chunks").map_err(|_| corrupt())?;
        let mut rows = statement.query([]).map_err(|_| corrupt())?;
        while let Some(row) = rows.next().map_err(|_| corrupt())? {
            let id: String = row.get(0).map_err(|_| corrupt())?;
            let index: i64 = row.get(1).map_err(|_| corrupt())?;
            let offset: i64 = row.get(2).map_err(|_| corrupt())?;
            let length: i64 = row.get(3).map_err(|_| corrupt())?;
            if index < 0 || offset < 0 || length <= 0 {
                return Err(corrupt());
            }
            let version: i64 = row.get(4).map_err(|_| corrupt())?;
            let nonce: Vec<u8> = row.get(5).map_err(|_| corrupt())?;
            let ciphertext: Vec<u8> = row.get(6).map_err(|_| corrupt())?;
            let plain = ciphers
                .response_content
                .open_sealed(
                    version,
                    &nonce,
                    &ciphertext,
                    &format!("purr:response-content:v1|{id}|{index}|{offset}|{length}"),
                )
                .map_err(|_| invalid_ciphertext())?;
            if plain.len() as u64 != length as u64 {
                return Err(corrupt());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{persistence::local_records::LocalStateStore, security::tests::MemoryRootKeyStore};
    use rusqlite::params;

    fn fixture() -> (tempfile::TempDir, Connection, RootCiphers) {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Connection::open(dir.path().join(DATABASE)).unwrap();
        LocalStateStore::migrate(&mut db).unwrap();
        db.execute(
            "INSERT INTO app_state VALUES('crypto-key-derivation','hkdf-sha256-v1')",
            [],
        )
        .unwrap();
        let ciphers = RootCiphers::open(&MemoryRootKeyStore::default(), false, true).unwrap();
        (dir, db, ciphers)
    }

    fn add_owner(db: &Connection, ciphers: &RootCiphers, owner: &str) {
        let (sql, aad) = match owner {
            "pending_commits" => ("INSERT INTO pending_commits(workspace_id,payload) VALUES('ws',?1)".to_string(), "ws/journal".to_string()),
            "response_bodies" => ("INSERT INTO response_bodies(workspace_id,execution_id,payload) VALUES('ws','id',?1)".to_string(), "ws/response_bodies/id".to_string()),
            "secret_operations" => ("INSERT INTO secret_operations(operation_id,state,payload) VALUES('id','committed',?1)".to_string(), "purr:operation:v1|id".to_string()),
            "workspace_cleanup" => ("INSERT INTO workspace_cleanup(workspace_id,payload) VALUES('ws',?1)".to_string(), "purr:workspace-cleanup:v1|ws".to_string()),
            "secret_values" => {
                let value = ciphers.secrets.seal(b"secret", "purr:secret:v1|purr/ws/auth/token").unwrap();
                db.execute("INSERT INTO secret_values(reference,crypto_version,nonce,ciphertext) VALUES('purr/ws/auth/token',?1,?2,?3)", params![value.version, value.nonce.as_slice(), value.ciphertext]).unwrap();
                return;
            }
            "response_content_chunks" => {
                db.execute("INSERT INTO response_contents(id,state,created_at) VALUES('content-id','ready',1)", []).unwrap();
                let value = ciphers.response_content.seal(b"body", "purr:response-content:v1|content-id|0|0|4").unwrap();
                db.execute("INSERT INTO response_content_chunks(content_id,chunk_index,plain_offset,plain_length,crypto_version,nonce,ciphertext) VALUES('content-id',0,0,4,?1,?2,?3)", params![value.version, value.nonce.as_slice(), value.ciphertext]).unwrap();
                return;
            }
            table => (format!("INSERT INTO {table}(workspace_id,id,payload) VALUES('ws','id',?1)"), format!("ws/{}/id", if table == "history_attachments" { "attachments" } else { table })),
        };
        db.execute(&sql, [ciphers.database.encrypt(b"{}", &aad).unwrap()])
            .unwrap();
    }

    #[test]
    fn each_ciphertext_owner_alone_prevents_root_replacement_and_verifies() {
        for owner in GENERIC
            .iter()
            .copied()
            .chain(EXTRA.iter().map(|(table, _)| *table))
        {
            let (dir, db, ciphers) = fixture();
            add_owner(&db, &ciphers, owner);
            let inventory = EncryptedInventory::inspect(dir.path()).unwrap();
            assert!(inventory.has_encrypted_data(), "{owner}");
            inventory
                .verify(&ciphers)
                .unwrap_or_else(|error| panic!("{owner}: {error}"));
            let wrong = RootCiphers::open(&MemoryRootKeyStore::default(), false, true).unwrap();
            assert!(inventory.verify(&wrong).is_err(), "{owner}");
            let missing = MemoryRootKeyStore::default();
            assert!(
                RootCiphers::open(&missing, inventory.has_encrypted_data(), true).is_err(),
                "{owner}"
            );
            assert!(!missing.has_key(), "{owner}");
        }
    }

    #[test]
    fn history_summary_is_verified_in_addition_to_execution_payload() {
        let (dir, db, ciphers) = fixture();
        add_owner(&db, &ciphers, "request_executions");
        let summary = ciphers
            .database
            .encrypt(b"{}", "ws/history-summary/id")
            .unwrap();
        db.execute("UPDATE request_executions SET summary=?1", [summary])
            .unwrap();
        let inventory = EncryptedInventory::inspect(dir.path()).unwrap();
        inventory.verify(&ciphers).unwrap();
        db.execute("UPDATE request_executions SET summary=x'00'", [])
            .unwrap();
        assert!(inventory.verify(&ciphers).is_err());
    }

    #[test]
    fn archive_only_and_interrupted_archive_accept_derived_and_raw_roots() {
        for name in [
            "legacy-workspaces.encrypted",
            ".tmpLegacyArchive",
            "legacy-workspaces.encrypted.pending",
        ] {
            for raw in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                let ciphers =
                    RootCiphers::open(&MemoryRootKeyStore::default(), false, true).unwrap();
                let cipher = if raw {
                    ciphers.legacy_database.as_ref().unwrap()
                } else {
                    &ciphers.database
                };
                let bytes = cipher.encrypt(b"{}", "purr/legacy-archive").unwrap();
                fs::write(dir.path().join(name), &bytes).unwrap();
                let inventory = EncryptedInventory::inspect(dir.path()).unwrap();
                assert!(inventory.has_encrypted_data());
                inventory.verify(&ciphers).unwrap();
                assert!(!dir.path().join(DATABASE).exists());
                assert_eq!(fs::read(dir.path().join(name)).unwrap(), bytes);
                fs::write(dir.path().join(name), b"partial").unwrap();
                assert!(inventory.verify(&ciphers).is_err());
            }
        }
    }

    #[test]
    fn raw_database_uses_legacy_reader_and_inventory_does_not_migrate_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("alternate.sqlite3");
        let mut db = Connection::open(&path).unwrap();
        LocalStateStore::migrate(&mut db).unwrap();
        let ciphers = RootCiphers::open(&MemoryRootKeyStore::default(), false, true).unwrap();
        let payload = ciphers
            .legacy_database
            .as_ref()
            .unwrap()
            .encrypt(b"{}", "ws/drafts/id")
            .unwrap();
        db.execute(
            "INSERT INTO drafts(workspace_id,id,payload) VALUES('ws','id',?1)",
            [&payload],
        )
        .unwrap();
        let inventory = EncryptedInventory::inspect_database(&path).unwrap();
        inventory.verify(&ciphers).unwrap();
        let stored: Vec<u8> = db
            .query_row("SELECT payload FROM drafts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stored, payload);
        assert_eq!(
            db.query_row("SELECT count(*) FROM app_state", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(!dir.path().join(DATABASE).exists());
    }

    #[test]
    fn earliest_schema_is_verified_without_creating_new_tables() {
        let dir = tempfile::tempdir().unwrap();
        let db = Connection::open(dir.path().join(DATABASE)).unwrap();
        db.execute_batch("CREATE TABLE migrations(version INTEGER PRIMARY KEY); CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,directory TEXT); CREATE TABLE pending_commits(workspace_id TEXT PRIMARY KEY,payload BLOB); PRAGMA user_version=1;").unwrap();
        for table in GENERIC {
            db.execute_batch(&format!(
                "CREATE TABLE {table}(workspace_id TEXT,id TEXT,payload BLOB)"
            ))
            .unwrap();
        }
        let ciphers = RootCiphers::open(&MemoryRootKeyStore::default(), false, true).unwrap();
        let payload = ciphers
            .legacy_database
            .as_ref()
            .unwrap()
            .encrypt(b"{}", "ws/journal")
            .unwrap();
        db.execute("INSERT INTO pending_commits VALUES('ws',?1)", [payload])
            .unwrap();
        let inventory = EncryptedInventory::inspect(dir.path()).unwrap();
        assert!(inventory.has_encrypted_data());
        inventory.verify(&ciphers).unwrap();
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            12
        );
    }

    #[test]
    fn inspect_is_read_only_and_ignores_ordinary_assets() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("asset.bin"), b"asset").unwrap();
        fs::write(dir.path().join("purr.yaml"), b"version: 2").unwrap();
        let inventory = EncryptedInventory::inspect(dir.path()).unwrap();
        assert!(!inventory.has_encrypted_data());
        assert!(!dir.path().join(DATABASE).exists());
        let ciphers = RootCiphers::open(&MemoryRootKeyStore::default(), false, true).unwrap();
        inventory.verify(&ciphers).unwrap();
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn corrupted_unknown_or_incomplete_schema_is_not_an_empty_vault() {
        let (dir, db, _) = fixture();
        db.execute_batch("DROP TABLE history_attachments").unwrap();
        assert!(EncryptedInventory::inspect(dir.path()).is_err());
        let (dir, db, _) = fixture();
        db.execute_batch("DROP TABLE drafts; CREATE TABLE drafts(workspace_id TEXT,id TEXT);")
            .unwrap();
        assert!(EncryptedInventory::inspect(dir.path()).is_err());
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(DATABASE), b"corrupt").unwrap();
        assert!(EncryptedInventory::inspect(dir.path()).is_err());
        let (dir, db, _) = fixture();
        db.execute_batch("PRAGMA user_version=7").unwrap();
        assert!(EncryptedInventory::inspect(dir.path()).is_err());
        let (dir, db, _) = fixture();
        db.execute_batch("CREATE TABLE unknown_ciphertext(payload BLOB)")
            .unwrap();
        assert!(EncryptedInventory::inspect(dir.path()).is_err());
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(format!("{DATABASE}-wal")), b"orphan").unwrap();
        assert!(EncryptedInventory::inspect(dir.path()).is_err());
    }

    #[test]
    fn verification_rechecks_owners_and_refuses_disappearing_evidence() {
        let (dir, db, ciphers) = fixture();
        add_owner(&db, &ciphers, "drafts");
        let inventory = EncryptedInventory::inspect(dir.path()).unwrap();
        db.execute("DELETE FROM drafts", []).unwrap();
        assert!(inventory.verify(&ciphers).is_err());
        add_owner(&db, &ciphers, "history_attachments");
        inventory.verify(&ciphers).unwrap();
        db.execute("UPDATE history_attachments SET payload=x'00'", [])
            .unwrap();
        assert!(inventory.verify(&ciphers).is_err());
    }

    #[test]
    fn wal_ciphertext_is_visible_and_tampered_chunk_metadata_is_rejected() {
        let (dir, db, ciphers) = fixture();
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        add_owner(&db, &ciphers, "response_content_chunks");
        let inventory = EncryptedInventory::inspect(dir.path()).unwrap();
        inventory.verify(&ciphers).unwrap();
        db.execute("UPDATE response_content_chunks SET plain_offset=1", [])
            .unwrap();
        assert!(inventory.verify(&ciphers).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn archive_or_database_symlinks_are_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let target = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(
            target.path(),
            dir.path().join("legacy-workspaces.encrypted"),
        )
        .unwrap();
        assert!(EncryptedInventory::inspect(dir.path()).is_err());
        fs::remove_file(dir.path().join("legacy-workspaces.encrypted")).unwrap();
        std::os::unix::fs::symlink(target.path(), dir.path().join(DATABASE)).unwrap();
        assert!(EncryptedInventory::inspect(dir.path()).is_err());
    }
}
