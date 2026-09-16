use crate::{
    persistence::response_bodies::{adopt_content, delete_execution_content},
    security::{validate_secret_ref, LocalCipher, RootCiphers, RootKeyStore},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

pub const TABLES: &[&str] = &[
    "workspace_local_state",
    "drafts",
    "document_session_state",
    "request_executions",
    "cookie_jar",
    "schema_cache",
    "recent_items",
    "attachments",
];
#[derive(Serialize, Deserialize, Clone)]
pub struct LocalRecord {
    pub table: String,
    pub id: String,
    pub value: Value,
}
pub struct LocalAttachment {
    pub name: String,
    pub media_type: String,
    pub bytes: Vec<u8>,
}
pub struct LocalStateStore {
    pub db: Connection,
    cipher: LocalCipher,
    secret_cipher: LocalCipher,
}
fn db_error(_: rusqlite::Error) -> String {
    "Local database operation failed".into()
}
impl LocalStateStore {
    fn attachment_fields(value: &Value) -> Result<(&str, &str, u64, &str, u64), String> {
        if value["version"].as_u64() != Some(1) {
            return Err("Damaged local attachment".into());
        }
        let name = value["name"].as_str().ok_or("Damaged local attachment")?;
        let media_type = value["type"].as_str().ok_or("Damaged local attachment")?;
        let last_modified = value["lastModified"]
            .as_u64()
            .ok_or("Damaged local attachment")?;
        let encoded = value["base64"].as_str().ok_or("Damaged local attachment")?;
        if encoded.len() % 4 != 0 {
            return Err("Damaged local attachment".into());
        }
        let padding = if encoded.ends_with("==") {
            2
        } else if encoded.ends_with('=') {
            1
        } else {
            0
        };
        let size = (encoded.len() as u64)
            .checked_mul(3)
            .ok_or("Local attachment is too large")?
            / 4
            - padding;
        if value
            .get("size")
            .is_some_and(|stored| stored.as_u64() != Some(size))
        {
            return Err("Damaged local attachment".into());
        }
        Ok((name, media_type, last_modified, encoded, size))
    }

    fn attachment_metadata(value: &Value) -> Result<Value, String> {
        let (name, media_type, last_modified, _, size) = Self::attachment_fields(value)?;
        Ok(serde_json::json!({
            "version": 1,
            "native": true,
            "name": name,
            "type": media_type,
            "lastModified": last_modified,
            "size": size,
        }))
    }

    pub fn open(path: &Path, root_store: &dyn RootKeyStore) -> Result<Self, String> {
        let mut db = Connection::open(path).map_err(db_error)?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(db_error)?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
        )
        .map_err(db_error)?;
        Self::migrate(&mut db)?;
        let mut has_encrypted_data = false;
        for table in TABLES.iter().copied().chain([
            "pending_commits",
            "response_bodies",
            "secret_values",
            "response_content_chunks",
        ]) {
            has_encrypted_data |= db
                .query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM {table})"),
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(db_error)?;
        }
        let uses_derived_keys = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM app_state WHERE key='crypto-key-derivation' AND value='hkdf-sha256-v1')",
                [],
                |row| row.get::<_, bool>(0),
            )
            .map_err(db_error)?;
        let mut ciphers = RootCiphers::open(
            root_store,
            has_encrypted_data,
            has_encrypted_data && !uses_derived_keys,
        )?;
        if !uses_derived_keys {
            if has_encrypted_data {
                let legacy = ciphers
                    .legacy_database
                    .as_ref()
                    .ok_or("Legacy local cipher is unavailable")?;
                Self::upgrade_database_cipher(&mut db, legacy, &ciphers.database)?;
            } else {
                db.execute(
                    "INSERT INTO app_state(key,value) VALUES('crypto-key-derivation','hkdf-sha256-v1') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    [],
                )
                .map_err(db_error)?;
            }
        }
        ciphers.legacy_database = None;
        Ok(Self {
            db,
            cipher: ciphers.database,
            secret_cipher: ciphers.secrets,
        })
    }
    pub fn cipher(&self) -> &LocalCipher {
        &self.cipher
    }
    pub(crate) fn migrate(db: &mut Connection) -> Result<(), String> {
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(db_error)?;
        if version > 4 {
            return Err("Local database was created by a newer Purr version".into());
        }
        if version == 0 {
            let tx = db.transaction().map_err(db_error)?;
            tx.execute_batch("CREATE TABLE migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
                CREATE TABLE app_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE workspaces(id TEXT PRIMARY KEY, directory TEXT NOT NULL UNIQUE);
                CREATE TABLE pending_commits(workspace_id TEXT PRIMARY KEY, payload BLOB NOT NULL);").map_err(db_error)?;
            for table in TABLES {
                tx.execute_batch(&format!("CREATE TABLE {table}(workspace_id TEXT NOT NULL, id TEXT NOT NULL, payload BLOB NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(workspace_id,id));")).map_err(db_error)?;
            }
            tx.execute_batch("INSERT INTO migrations(version) VALUES(1); PRAGMA user_version=1;")
                .map_err(db_error)?;
            tx.commit().map_err(db_error)?;
        }
        if version < 2 {
            let tx = db.transaction().map_err(db_error)?;
            tx.execute_batch("ALTER TABLE request_executions ADD COLUMN document_id TEXT;
                ALTER TABLE request_executions ADD COLUMN started_at INTEGER;
                ALTER TABLE request_executions ADD COLUMN status INTEGER;
                CREATE INDEX execution_document_time ON request_executions(workspace_id,document_id,started_at DESC);
                CREATE TABLE response_bodies(workspace_id TEXT NOT NULL, execution_id TEXT NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(workspace_id,execution_id));
                CREATE TABLE cookie_metadata(workspace_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, domain TEXT NOT NULL, path TEXT NOT NULL, expires TEXT, secure INTEGER NOT NULL, http_only INTEGER NOT NULL, same_site TEXT, host_only INTEGER NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY(workspace_id,id));
                CREATE INDEX cookie_domain_path ON cookie_metadata(workspace_id,domain,path);
                INSERT INTO migrations(version) VALUES(2); PRAGMA user_version=2;").map_err(db_error)?;
            tx.commit().map_err(db_error)?;
        }
        if version < 3 {
            let tx = db.transaction().map_err(db_error)?;
            tx.execute_batch(
                "CREATE TABLE secret_values(
                    reference TEXT PRIMARY KEY,
                    ciphertext BLOB NOT NULL,
                    nonce BLOB NOT NULL,
                    crypto_version INTEGER NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                INSERT INTO migrations(version) VALUES(3);
                PRAGMA user_version=3;",
            )
            .map_err(db_error)?;
            tx.commit().map_err(db_error)?;
        }
        if version < 4 {
            let tx = db.transaction().map_err(db_error)?;
            tx.execute_batch(
                "CREATE TABLE response_contents(
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT,
                    execution_id TEXT,
                    state TEXT NOT NULL CHECK(state IN ('staging','ready','adopted')),
                    byte_length INTEGER NOT NULL DEFAULT 0 CHECK(byte_length >= 0),
                    media_type TEXT,
                    charset TEXT,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER,
                    UNIQUE(workspace_id, execution_id)
                );
                CREATE INDEX response_contents_expiry ON response_contents(state, expires_at);
                CREATE TABLE response_content_chunks(
                    content_id TEXT NOT NULL REFERENCES response_contents(id) ON DELETE CASCADE,
                    chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
                    plain_offset INTEGER NOT NULL CHECK(plain_offset >= 0),
                    plain_length INTEGER NOT NULL CHECK(plain_length > 0),
                    crypto_version INTEGER NOT NULL,
                    nonce BLOB NOT NULL,
                    ciphertext BLOB NOT NULL,
                    PRIMARY KEY(content_id, chunk_index),
                    UNIQUE(content_id, plain_offset)
                );
                INSERT INTO migrations(version) VALUES(4);
                PRAGMA user_version=4;",
            )
            .map_err(db_error)?;
            tx.commit().map_err(db_error)?;
        }
        Ok(())
    }

    fn upgrade_database_cipher(
        db: &mut Connection,
        legacy: &LocalCipher,
        derived: &LocalCipher,
    ) -> Result<(), String> {
        let tx = db.transaction().map_err(db_error)?;
        for table in TABLES {
            let mut stmt = tx
                .prepare(&format!("SELECT workspace_id,id,payload FROM {table}"))
                .map_err(db_error)?;
            let records = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                    ))
                })
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?;
            drop(stmt);
            for (workspace, id, payload) in records {
                let context = format!("{workspace}/{table}/{id}");
                let plaintext = legacy.decrypt(&payload, &context)?;
                let replacement = derived.encrypt(&plaintext, &context)?;
                tx.execute(
                    &format!("UPDATE {table} SET payload=?3 WHERE workspace_id=?1 AND id=?2"),
                    params![workspace, id, replacement],
                )
                .map_err(db_error)?;
            }
        }
        {
            let mut stmt = tx
                .prepare("SELECT workspace_id,payload FROM pending_commits")
                .map_err(db_error)?;
            let records = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
                })
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?;
            drop(stmt);
            for (workspace, payload) in records {
                let context = format!("{workspace}/journal");
                let plaintext = legacy.decrypt(&payload, &context)?;
                let replacement = derived.encrypt(&plaintext, &context)?;
                tx.execute(
                    "UPDATE pending_commits SET payload=?2 WHERE workspace_id=?1",
                    params![workspace, replacement],
                )
                .map_err(db_error)?;
            }
        }
        {
            let mut stmt = tx
                .prepare("SELECT workspace_id,execution_id,payload FROM response_bodies")
                .map_err(db_error)?;
            let records = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                    ))
                })
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?;
            drop(stmt);
            for (workspace, execution, payload) in records {
                let context = format!("{workspace}/response_bodies/{execution}");
                let plaintext = legacy.decrypt(&payload, &context)?;
                let replacement = derived.encrypt(&plaintext, &context)?;
                tx.execute(
                    "UPDATE response_bodies SET payload=?3 WHERE workspace_id=?1 AND execution_id=?2",
                    params![workspace, execution, replacement],
                )
                .map_err(db_error)?;
            }
        }
        tx.execute(
            "INSERT INTO app_state(key,value) VALUES('crypto-key-derivation','hkdf-sha256-v1') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)
    }

    fn secret_aad(reference: &str) -> String {
        format!("purr:secret:v1|{reference}")
    }

    pub fn get_secret(&self, reference: &str) -> Result<Option<String>, String> {
        validate_secret_ref(reference)?;
        let stored = self
            .db
            .query_row(
                "SELECT crypto_version,nonce,ciphertext FROM secret_values WHERE reference=?1",
                [reference],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Vec<u8>>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(db_error)?;
        let Some((version, nonce, ciphertext)) = stored else {
            return Ok(None);
        };
        let plaintext = self.secret_cipher.open_sealed(
            version,
            &nonce,
            &ciphertext,
            &Self::secret_aad(reference),
        )?;
        String::from_utf8(plaintext.to_vec())
            .map(Some)
            .map_err(|_| "Invalid secret value".into())
    }

    pub fn set_secret(&self, reference: &str, value: &str) -> Result<(), String> {
        validate_secret_ref(reference)?;
        if value.is_empty() {
            return self.delete_secret(reference);
        }
        let sealed = self
            .secret_cipher
            .seal(value.as_bytes(), &Self::secret_aad(reference))?;
        self.db
            .execute(
                "INSERT INTO secret_values(reference,ciphertext,nonce,crypto_version)
                 VALUES(?1,?2,?3,?4)
                 ON CONFLICT(reference) DO UPDATE SET
                   ciphertext=excluded.ciphertext,
                   nonce=excluded.nonce,
                   crypto_version=excluded.crypto_version,
                   updated_at=CURRENT_TIMESTAMP",
                params![
                    reference,
                    sealed.ciphertext,
                    sealed.nonce.as_slice(),
                    sealed.version
                ],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn delete_secret(&self, reference: &str) -> Result<(), String> {
        validate_secret_ref(reference)?;
        self.db
            .execute("DELETE FROM secret_values WHERE reference=?1", [reference])
            .map_err(db_error)?;
        Ok(())
    }

    pub fn secret_exists(&self, reference: &str) -> Result<bool, String> {
        validate_secret_ref(reference)?;
        self.db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM secret_values WHERE reference=?1)",
                [reference],
                |row| row.get(0),
            )
            .map_err(db_error)
    }
    pub fn workspaces(&self) -> Result<Vec<(String, String)>, String> {
        let mut stmt = self
            .db
            .prepare("SELECT id,directory FROM workspaces ORDER BY id")
            .map_err(db_error)?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(db_error)?;
        rows.collect::<Result<_, _>>().map_err(db_error)
    }
    pub fn register(&self, id: &str, directory: &Path) -> Result<(), String> {
        self.db.execute("INSERT INTO workspaces(id,directory) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET directory=excluded.directory", params![id, directory.to_string_lossy()]).map_err(db_error)?;
        Ok(())
    }
    pub fn delete_workspace(&mut self, workspace: &str) -> Result<(), String> {
        let tx = self.db.transaction().map_err(db_error)?;
        for table in TABLES {
            tx.execute(
                &format!("DELETE FROM {table} WHERE workspace_id=?1"),
                [workspace],
            )
            .map_err(db_error)?;
        }
        tx.execute(
            "DELETE FROM response_bodies WHERE workspace_id=?1",
            [workspace],
        )
        .map_err(db_error)?;
        tx.execute(
            "DELETE FROM response_contents WHERE workspace_id=?1",
            [workspace],
        )
        .map_err(db_error)?;
        tx.execute(
            "DELETE FROM cookie_metadata WHERE workspace_id=?1",
            [workspace],
        )
        .map_err(db_error)?;
        tx.execute(
            "DELETE FROM pending_commits WHERE workspace_id=?1",
            [workspace],
        )
        .map_err(db_error)?;
        let secret_prefix = format!("purr/{workspace}/");
        tx.execute(
            "DELETE FROM secret_values WHERE substr(reference,1,length(?1))=?1",
            [secret_prefix],
        )
        .map_err(db_error)?;
        tx.execute("DELETE FROM workspaces WHERE id=?1", [workspace])
            .map_err(db_error)?;
        tx.execute(
            "DELETE FROM app_state WHERE key='active-workspace' AND value=?1",
            [workspace],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)
    }
    pub fn app(&self, key: &str) -> Result<Option<String>, String> {
        self.db
            .query_row("SELECT value FROM app_state WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .optional()
            .map_err(db_error)
    }
    pub fn set_app(&self, key: &str, value: &str) -> Result<(), String> {
        self.db.execute("INSERT INTO app_state(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value", params![key,value]).map_err(db_error)?;
        Ok(())
    }
    pub fn read(&self, workspace: &str) -> Result<Vec<LocalRecord>, String> {
        let mut records = Vec::new();
        for table in TABLES {
            let query = if *table == "request_executions" {
                "SELECT id,payload FROM request_executions e WHERE workspace_id=?1 AND (document_id IS NULL OR id=(SELECT newest.id FROM request_executions newest WHERE newest.workspace_id=e.workspace_id AND newest.document_id=e.document_id ORDER BY started_at DESC LIMIT 1)) ORDER BY id".to_string()
            } else {
                format!("SELECT id,payload FROM {table} WHERE workspace_id=?1 ORDER BY id")
            };
            let mut stmt = self.db.prepare(&query).map_err(db_error)?;
            let rows = stmt
                .query_map([workspace], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
                })
                .map_err(db_error)?;
            for row in rows {
                let (id, bytes) = row.map_err(db_error)?;
                let plain = self
                    .cipher
                    .decrypt(&bytes, &format!("{workspace}/{table}/{id}"))?;
                let mut value: Value =
                    serde_json::from_slice(&plain).map_err(|_| "Damaged local record")?;
                if *table == "request_executions" {
                    self.restore_response_body(workspace, &id, &mut value)?;
                } else if *table == "attachments" {
                    value = Self::attachment_metadata(&value)?;
                }
                records.push(LocalRecord {
                    table: table.to_string(),
                    id,
                    value,
                });
            }
        }
        Ok(records)
    }
    pub fn read_attachment(&self, workspace: &str, id: &str) -> Result<LocalAttachment, String> {
        let payload: Vec<u8> = self
            .db
            .query_row(
                "SELECT payload FROM attachments WHERE workspace_id=?1 AND id=?2",
                params![workspace, id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?
            .ok_or("Local attachment is unavailable")?;
        let plain = self
            .cipher
            .decrypt(&payload, &format!("{workspace}/attachments/{id}"))?;
        let value: Value =
            serde_json::from_slice(&plain).map_err(|_| "Damaged local attachment")?;
        let (name, media_type, _last_modified, encoded, expected_size) =
            Self::attachment_fields(&value)?;
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| "Damaged local attachment")?;
        if bytes.len() as u64 != expected_size {
            return Err("Damaged local attachment".into());
        }
        Ok(LocalAttachment {
            name: name.into(),
            media_type: media_type.into(),
            bytes,
        })
    }
    pub fn write(&mut self, workspace: &str, records: &[LocalRecord]) -> Result<(), String> {
        let tx = self.db.transaction().map_err(db_error)?;
        for record in records {
            if !TABLES.contains(&record.table.as_str()) {
                return Err("Unknown local state table".into());
            }
            if record.value.is_null() {
                tx.execute(
                    &format!(
                        "DELETE FROM {} WHERE workspace_id=?1 AND id=?2",
                        record.table
                    ),
                    params![workspace, record.id],
                )
                .map_err(db_error)?;
                if record.table == "cookie_jar" {
                    tx.execute(
                        "DELETE FROM cookie_metadata WHERE workspace_id=?1 AND id=?2",
                        params![workspace, record.id],
                    )
                    .map_err(db_error)?;
                }
                if record.table == "request_executions" {
                    tx.execute(
                        "DELETE FROM response_bodies WHERE workspace_id=?1 AND execution_id=?2",
                        params![workspace, record.id],
                    )
                    .map_err(db_error)?;
                    delete_execution_content(&tx, workspace, &record.id)?;
                }
            } else {
                let context = format!("{workspace}/{}/{}", record.table, record.id);
                let mut value = record.value.clone();
                if record.table == "request_executions" {
                    if let Some(response) = value.get_mut("response").and_then(Value::as_object_mut)
                    {
                        if response.contains_key("text") || response.contains_key("bodyBase64") {
                            let body = serde_json::json!({ "text": response.remove("text"), "bodyBase64": response.remove("bodyBase64") });
                            let plain =
                                serde_json::to_vec(&body).map_err(|_| "Invalid response body")?;
                            let payload = self.cipher.encrypt(
                                &plain,
                                &format!("{workspace}/response_bodies/{}", record.id),
                            )?;
                            tx.execute("INSERT INTO response_bodies(workspace_id,execution_id,payload) VALUES(?1,?2,?3) ON CONFLICT(workspace_id,execution_id) DO UPDATE SET payload=excluded.payload",params![workspace,record.id,payload]).map_err(db_error)?;
                            delete_execution_content(&tx, workspace, &record.id)?;
                        } else if let Some(content) = response.get("content") {
                            let content_id = content["id"]
                                .as_str()
                                .ok_or("Invalid response content reference")?;
                            let byte_length = content["byteLength"]
                                .as_u64()
                                .ok_or("Invalid response content reference")?;
                            let complete = content["complete"]
                                .as_bool()
                                .ok_or("Invalid response content reference")?;
                            adopt_content(
                                &tx,
                                workspace,
                                &record.id,
                                content_id,
                                byte_length,
                                complete,
                            )?;
                            tx.execute(
                                "DELETE FROM response_bodies WHERE workspace_id=?1 AND execution_id=?2",
                                params![workspace, record.id],
                            )
                            .map_err(db_error)?;
                        } else {
                            tx.execute(
                                "DELETE FROM response_bodies WHERE workspace_id=?1 AND execution_id=?2",
                                params![workspace, record.id],
                            )
                            .map_err(db_error)?;
                            delete_execution_content(&tx, workspace, &record.id)?;
                        }
                    }
                }
                let plain = serde_json::to_vec(&value).map_err(|_| "Invalid local data")?;
                let old: Option<Vec<u8>> = tx
                    .query_row(
                        &format!(
                            "SELECT payload FROM {} WHERE workspace_id=?1 AND id=?2",
                            record.table
                        ),
                        params![workspace, record.id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(db_error)?;
                if let Some(old) = old {
                    if self.cipher.decrypt(&old, &context)? == plain {
                        continue;
                    }
                }
                let payload = self.cipher.encrypt(&plain, &context)?;
                tx.execute(&format!("INSERT INTO {}(workspace_id,id,payload) VALUES(?1,?2,?3) ON CONFLICT(workspace_id,id) DO UPDATE SET payload=excluded.payload,updated_at=CURRENT_TIMESTAMP", record.table), params![workspace, record.id, payload]).map_err(db_error)?;
                if record.table == "request_executions" {
                    let response = &value["response"];
                    let status = response["status"]
                        .as_i64()
                        .or_else(|| response["response"]["status"].as_i64());
                    tx.execute("UPDATE request_executions SET document_id=?3,started_at=?4,status=?5 WHERE workspace_id=?1 AND id=?2", params![workspace,record.id,value["documentId"].as_str(),response["timeline"]["startedAtMs"].as_i64(),status]).map_err(db_error)?;
                }
                if record.table == "cookie_jar" {
                    tx.execute("INSERT INTO cookie_metadata(workspace_id,id,name,domain,path,expires,secure,http_only,same_site,host_only,enabled) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(workspace_id,id) DO UPDATE SET name=excluded.name,domain=excluded.domain,path=excluded.path,expires=excluded.expires,secure=excluded.secure,http_only=excluded.http_only,same_site=excluded.same_site,host_only=excluded.host_only,enabled=excluded.enabled",
                        params![workspace,record.id,value["name"].as_str().unwrap_or(""),value["domain"].as_str().unwrap_or(""),value["path"].as_str().unwrap_or("/"),value["expires"].as_str(),value["secure"].as_bool().unwrap_or(false),value["httpOnly"].as_bool().unwrap_or(false),value["sameSite"].as_str(),value["hostOnly"].as_bool().unwrap_or(false),value["enabled"].as_bool().unwrap_or(true)]).map_err(db_error)?;
                }
            }
        }
        tx.execute(
            "DELETE FROM pending_commits WHERE workspace_id=?1",
            [workspace],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)
    }
    fn restore_response_body(
        &self,
        workspace: &str,
        id: &str,
        value: &mut Value,
    ) -> Result<(), String> {
        let bytes: Option<Vec<u8>> = self
            .db
            .query_row(
                "SELECT payload FROM response_bodies WHERE workspace_id=?1 AND execution_id=?2",
                params![workspace, id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if let Some(bytes) = bytes {
            let plain = self
                .cipher
                .decrypt(&bytes, &format!("{workspace}/response_bodies/{id}"))?;
            let body: Value =
                serde_json::from_slice(&plain).map_err(|_| "Damaged response body")?;
            value["response"]["text"] = body["text"].clone();
            value["response"]["bodyBase64"] = body["bodyBase64"].clone();
        }
        Ok(())
    }
    pub fn history(
        &self,
        workspace: &str,
        document: &str,
        before: i64,
        limit: u32,
    ) -> Result<Vec<Value>, String> {
        let mut stmt = self.db.prepare("SELECT id,started_at,status FROM request_executions WHERE workspace_id=?1 AND document_id=?2 AND started_at<?3 ORDER BY started_at DESC LIMIT ?4").map_err(db_error)?;
        let rows = stmt.query_map(params![workspace,document,before,limit.clamp(1,100)], |row| Ok(serde_json::json!({"id":row.get::<_,String>(0)?,"startedAt":row.get::<_,i64>(1)?,"status":row.get::<_,i64>(2)?}))).map_err(db_error)?;
        rows.collect::<Result<_, _>>().map_err(db_error)
    }

    pub fn execution_metadata(
        &self,
        workspace: &str,
        document: &str,
        started_at: u64,
    ) -> Result<Option<Value>, String> {
        let row = self.db.query_row(
            "SELECT id,CASE WHEN length(payload)<=1048576 THEN payload ELSE NULL END FROM request_executions WHERE workspace_id=?1 AND document_id=?2 AND started_at=?3 LIMIT 1",
            params![workspace, document, started_at], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<Vec<u8>>>(1)?)),
        ).optional().map_err(db_error)?;
        row.map(|(id, payload)| {
            let payload = payload.ok_or("Execution metadata exceeds trace lookup limit")?;
            let plain = self
                .cipher
                .decrypt(&payload, &format!("{workspace}/request_executions/{id}"))?;
            serde_json::from_slice(&plain).map_err(|_| "Damaged execution metadata".into())
        })
        .transpose()
    }
    pub fn journal(&self, workspace: &str, value: &Value) -> Result<(), String> {
        let payload = self.cipher.encrypt(
            &serde_json::to_vec(value).map_err(|_| "Invalid commit")?,
            &format!("{workspace}/journal"),
        )?;
        self.db.execute("INSERT INTO pending_commits(workspace_id,payload) VALUES(?1,?2) ON CONFLICT(workspace_id) DO UPDATE SET payload=excluded.payload", params![workspace, payload]).map_err(db_error)?;
        Ok(())
    }
    pub fn pending(&self) -> Result<Vec<(String, Value)>, String> {
        let mut stmt = self
            .db
            .prepare("SELECT workspace_id,payload FROM pending_commits")
            .map_err(db_error)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
            })
            .map_err(db_error)?;
        rows.map(|row| {
            let (id, bytes) = row.map_err(db_error)?;
            let plain = self.cipher.decrypt(&bytes, &format!("{id}/journal"))?;
            Ok((
                id,
                serde_json::from_slice(&plain).map_err(|_| "Damaged pending commit")?,
            ))
        })
        .collect()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::tests::MemoryRootKeyStore;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn sample_value(label: &str) -> String {
        format!(
            "test-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }

    fn vault_row(store: &LocalStateStore, reference: &str) -> (i64, Vec<u8>, Vec<u8>) {
        store
            .db
            .query_row(
                "SELECT crypto_version,nonce,ciphertext FROM secret_values WHERE reference=?1",
                [reference],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
    }

    #[test]
    fn attachment_reads_return_metadata_until_bytes_are_explicitly_requested() {
        let directory = tempfile::tempdir().unwrap();
        let root = MemoryRootKeyStore::default();
        let mut store = LocalStateStore::open(&directory.path().join("state.db"), &root).unwrap();
        let bytes = [0_u8, 1, 2, 254, 255];
        store
            .write(
                "workspace",
                &[LocalRecord {
                    table: "attachments".into(),
                    id: "attachment-1".into(),
                    value: serde_json::json!({
                        "version": 1,
                        "name": "payload.bin",
                        "type": "application/octet-stream",
                        "lastModified": 1234,
                        "size": bytes.len(),
                        "base64": STANDARD.encode(bytes),
                    }),
                }],
            )
            .unwrap();

        let records = store.read("workspace").unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].value["native"], true);
        assert_eq!(records[0].value["size"], bytes.len());
        assert!(records[0].value.get("base64").is_none());

        let attachment = store.read_attachment("workspace", "attachment-1").unwrap();
        assert_eq!(attachment.name, "payload.bin");
        assert_eq!(attachment.media_type, "application/octet-stream");
        assert_eq!(attachment.bytes, bytes);
    }

    #[test]
    fn secret_vault_set_is_encrypted_and_get_returns_the_original_value() {
        let directory = tempfile::tempdir().unwrap();
        let root = MemoryRootKeyStore::default();
        let store = LocalStateStore::open(&directory.path().join("state.db"), &root).unwrap();
        let reference = "purr/workspace/auth/profile/token";
        let value = sample_value("vault");
        store.set_secret(reference, &value).unwrap();
        let (version, nonce, ciphertext) = vault_row(&store, reference);
        assert_eq!(version, 1);
        assert_eq!(nonce.len(), 12);
        assert!(!ciphertext
            .windows(value.len())
            .any(|part| part == value.as_bytes()));
        assert_eq!(
            store.get_secret(reference).unwrap().as_deref(),
            Some(value.as_str())
        );
    }

    #[test]
    fn overwriting_a_secret_uses_a_new_random_nonce() {
        let directory = tempfile::tempdir().unwrap();
        let root = MemoryRootKeyStore::default();
        let store = LocalStateStore::open(&directory.path().join("state.db"), &root).unwrap();
        let reference = "purr/workspace/auth/profile/token";
        store.set_secret(reference, &sample_value("first")).unwrap();
        let (_, first_nonce, _) = vault_row(&store, reference);
        store
            .set_secret(reference, &sample_value("second"))
            .unwrap();
        let (_, second_nonce, _) = vault_row(&store, reference);
        assert_ne!(first_nonce, second_nonce);
    }

    #[test]
    fn secret_ciphertext_is_bound_to_its_reference_by_aad() {
        let directory = tempfile::tempdir().unwrap();
        let root = MemoryRootKeyStore::default();
        let store = LocalStateStore::open(&directory.path().join("state.db"), &root).unwrap();
        let reference = "purr/workspace/auth/profile/token";
        store.set_secret(reference, &sample_value("aad")).unwrap();
        let (version, nonce, ciphertext) = vault_row(&store, reference);
        assert!(store
            .secret_cipher
            .open_sealed(
                version,
                &nonce,
                &ciphertext,
                &LocalStateStore::secret_aad("purr/workspace/auth/other/token"),
            )
            .is_err());
    }

    #[test]
    fn corrupted_secret_ciphertext_fails_closed() {
        let directory = tempfile::tempdir().unwrap();
        let root = MemoryRootKeyStore::default();
        let store = LocalStateStore::open(&directory.path().join("state.db"), &root).unwrap();
        let reference = "purr/workspace/auth/profile/token";
        store
            .set_secret(reference, &sample_value("corrupt"))
            .unwrap();
        let (_, _, mut ciphertext) = vault_row(&store, reference);
        ciphertext[0] ^= 1;
        store
            .db
            .execute(
                "UPDATE secret_values SET ciphertext=?2 WHERE reference=?1",
                params![reference, ciphertext],
            )
            .unwrap();
        assert!(store.get_secret(reference).is_err());
    }

    #[test]
    fn deleting_a_secret_removes_it_from_the_vault() {
        let directory = tempfile::tempdir().unwrap();
        let root = MemoryRootKeyStore::default();
        let store = LocalStateStore::open(&directory.path().join("state.db"), &root).unwrap();
        let reference = "purr/workspace/auth/profile/token";
        store
            .set_secret(reference, &sample_value("delete"))
            .unwrap();
        assert!(store.secret_exists(reference).unwrap());
        store.delete_secret(reference).unwrap();
        assert!(!store.secret_exists(reference).unwrap());
        assert_eq!(store.get_secret(reference).unwrap(), None);
    }

    #[test]
    fn deleting_workspace_removes_only_its_scoped_secrets() {
        let directory = tempfile::tempdir().unwrap();
        let root = MemoryRootKeyStore::default();
        let mut store = LocalStateStore::open(&directory.path().join("state.db"), &root).unwrap();
        let removed = "purr/work_space/auth/token";
        let retained = "purr/workXspace/auth/token";
        store.set_secret(removed, &sample_value("removed")).unwrap();
        store
            .set_secret(retained, &sample_value("retained"))
            .unwrap();
        store
            .register("work_space", &directory.path().join("work_space"))
            .unwrap();
        store.delete_workspace("work_space").unwrap();
        assert!(!store.secret_exists(removed).unwrap());
        assert!(store.secret_exists(retained).unwrap());
    }

    #[test]
    fn many_secret_operations_do_not_access_the_root_key_store_again() {
        let directory = tempfile::tempdir().unwrap();
        let root = MemoryRootKeyStore::default();
        let store = LocalStateStore::open(&directory.path().join("state.db"), &root).unwrap();
        assert_eq!(root.reads(), 1);
        assert_eq!(root.writes(), 1);
        for index in 0..12 {
            let reference = format!("purr/workspace/auth/profile/value-{index}");
            store.set_secret(&reference, &sample_value("many")).unwrap();
            assert!(store.secret_exists(&reference).unwrap());
            assert!(store.get_secret(&reference).unwrap().is_some());
        }
        assert_eq!(root.reads(), 1);
        assert_eq!(root.writes(), 1);
    }

    #[test]
    fn existing_raw_root_encryption_is_rekeyed_to_the_derived_database_key() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.db");
        let root = MemoryRootKeyStore::default();
        let legacy = RootCiphers::open(&root, false, true)
            .unwrap()
            .legacy_database
            .unwrap();
        let mut db = Connection::open(&path).unwrap();
        LocalStateStore::migrate(&mut db).unwrap();
        let context = "workspace/drafts/draft";
        let value = serde_json::json!({"name":"existing development draft"});
        let old_payload = legacy
            .encrypt(&serde_json::to_vec(&value).unwrap(), context)
            .unwrap();
        db.execute(
            "INSERT INTO drafts(workspace_id,id,payload) VALUES('workspace','draft',?1)",
            [old_payload],
        )
        .unwrap();
        drop(db);

        let store = LocalStateStore::open(&path, &root).unwrap();
        let records = store.read("workspace").unwrap();
        assert_eq!(records[0].value, value);
        assert_eq!(
            store.app("crypto-key-derivation").unwrap().as_deref(),
            Some("hkdf-sha256-v1")
        );
        let new_payload: Vec<u8> = store
            .db
            .query_row(
                "SELECT payload FROM drafts WHERE workspace_id='workspace' AND id='draft'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(legacy.decrypt(&new_payload, context).is_err());
        assert!(store.cipher.decrypt(&new_payload, context).is_ok());
    }

    #[test]
    fn execution_bodies_history_and_transaction_rollback() {
        let directory = tempfile::tempdir().unwrap();
        let secure = MemoryRootKeyStore::default();
        let mut store = LocalStateStore::open(&directory.path().join("state.db"), &secure).unwrap();
        let execution = |id: i64| LocalRecord {
            table: "request_executions".into(),
            id: format!("request-{id}"),
            value: serde_json::json!({
                "documentId":"request", "response":{"status":200,"text":"sensitive-response","bodyBase64":"Ym9keQ==","timeline":{"startedAtMs":id}}
            }),
        };
        store
            .write("workspace", &[execution(1), execution(2)])
            .unwrap();
        let loaded = store.read("workspace").unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "request-2");
        assert_eq!(loaded[0].value["response"]["text"], "sensitive-response");
        assert_eq!(
            store.history("workspace", "request", 3, 10).unwrap().len(),
            2
        );
        assert_eq!(
            store.history("workspace", "request", 2, 10).unwrap()[0]["id"],
            "request-1"
        );
        let bytes: Vec<u8> = store
            .db
            .query_row("SELECT payload FROM response_bodies LIMIT 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("sensitive-response"));
        store
            .journal("workspace", &serde_json::json!({"files":[],"local":[]}))
            .unwrap();
        assert!(store
            .write(
                "workspace",
                &[
                    execution(3),
                    LocalRecord {
                        table: "not_a_table".into(),
                        id: "bad".into(),
                        value: Value::Bool(true)
                    }
                ]
            )
            .is_err());
        assert_eq!(
            store.history("workspace", "request", 4, 10).unwrap().len(),
            2
        );
        assert_eq!(store.pending().unwrap().len(), 1);
        store.write("workspace", &[]).unwrap();
        assert!(store.pending().unwrap().is_empty());
        secure.remove_key();
        drop(store);
        assert!(LocalStateStore::open(&directory.path().join("state.db"), &secure).is_err());
        assert!(!secure.has_key());
    }

    #[test]
    fn observability_reads_exact_encrypted_execution_without_hydrating_body() {
        let directory = tempfile::tempdir().unwrap();
        let root = MemoryRootKeyStore::default();
        let path = directory.path().join("state.db");
        let mut store = LocalStateStore::open(&path, &root).unwrap();
        let record = |time| LocalRecord {
            table: "request_executions".into(),
            id: format!("document-{time}"),
            value: serde_json::json!({
                "documentId":"document", "response": {"status":200,"headers":[],"text":"synthetic-body","bodyBase64":"eA==",
                "timeline":{"startedAtMs":time,"request":{"headers":[["x-b3-traceid","0123456789abcdef"]]}}}
            }),
        };
        store.write("workspace", &[record(1), record(2)]).unwrap();
        let first = store
            .execution_metadata("workspace", "document", 1)
            .unwrap()
            .unwrap();
        assert_eq!(first["response"]["timeline"]["startedAtMs"], 1);
        assert!(first["response"]["text"].is_null());
        assert!(store
            .execution_metadata("other", "document", 1)
            .unwrap()
            .is_none());
        assert!(store
            .execution_metadata("workspace", "other", 1)
            .unwrap()
            .is_none());
        drop(store);
        let reopened = LocalStateStore::open(&path, &root).unwrap();
        assert!(super::super::observability::exchange(
            reopened
                .execution_metadata("workspace", "document", 2)
                .unwrap()
                .unwrap()
        )
        .is_ok());
        reopened
            .db
            .execute(
                "UPDATE request_executions SET payload=zeroblob(1048577) WHERE id='document-2'",
                [],
            )
            .unwrap();
        assert_eq!(
            reopened
                .execution_metadata("workspace", "document", 2)
                .unwrap_err(),
            "Execution metadata exceeds trace lookup limit"
        );
    }

    #[test]
    fn referenced_execution_round_trips_without_inline_body_fields() {
        let directory = tempfile::tempdir().unwrap();
        let secure = MemoryRootKeyStore::default();
        let mut store = LocalStateStore::open(&directory.path().join("state.db"), &secure).unwrap();
        let response = serde_json::json!({
            "protocolVersion": 2,
            "request": {
                "url": "https://fixture.invalid/large-response",
                "method": "GET",
                "headers": [],
                "bodyBase64": null
            },
            "response": {
                "url": "https://fixture.invalid/large-response",
                "status": 206,
                "statusText": "Partial Content",
                "headers": [["content-type", "application/json"]],
                "byteLength": 1048576,
                "durationMs": 10
            },
            "content": {
                "id": "fixture-content-0001",
                "byteLength": 1048576,
                "mediaType": "application/json",
                "complete": true
            },
            "timeline": {
                "startedAtMs": 1700000001000_i64,
                "prepareMs": 1,
                "waitingMs": 2,
                "downloadMs": 7,
                "completedAtMs": 1700000001010_i64,
                "request": {
                    "url": "https://fixture.invalid/large-response",
                    "method": "GET",
                    "headers": [],
                    "bodyBase64": null
                },
                "followRedirects": true,
                "usesCookieJar": false,
                "timeoutMs": 60000
            }
        });
        let execution = LocalRecord {
            table: "request_executions".into(),
            id: "request-reference".into(),
            value: serde_json::json!({ "documentId": "request", "response": response }),
        };

        store.write("workspace", &[execution]).unwrap();
        let loaded = store.read("workspace").unwrap();
        assert_eq!(loaded[0].value["response"], response);
        assert!(loaded[0].value["response"].get("text").is_none());
        assert!(loaded[0].value["response"].get("bodyBase64").is_none());
        let history = store.history("workspace", "request", i64::MAX, 10).unwrap();
        assert_eq!(history[0]["status"], 206);
        let body_count = store
            .db
            .query_row("SELECT COUNT(*) FROM response_bodies", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        assert_eq!(body_count, 0);
    }

    #[test]
    fn sqlite_v1_upgrades_without_losing_records_and_future_versions_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.db");
        let secure = MemoryRootKeyStore::default();
        let store = LocalStateStore::open(&path, &secure).unwrap();
        // Reconstruct the earlier local schema, then exercise the real migration.
        store.db.execute_batch("DROP TABLE response_content_chunks; DROP INDEX response_contents_expiry; DROP TABLE response_contents; DROP INDEX execution_document_time; ALTER TABLE request_executions DROP COLUMN document_id; ALTER TABLE request_executions DROP COLUMN started_at; ALTER TABLE request_executions DROP COLUMN status; DROP TABLE response_bodies; DROP TABLE cookie_metadata; DROP TABLE secret_values; DELETE FROM migrations WHERE version>1; PRAGMA user_version=1;").unwrap();
        let value = serde_json::json!({"text":"retained draft"});
        let payload = store
            .cipher
            .encrypt(
                &serde_json::to_vec(&value).unwrap(),
                "workspace/drafts/draft",
            )
            .unwrap();
        store
            .db
            .execute(
                "INSERT INTO drafts(workspace_id,id,payload) VALUES('workspace','draft',?1)",
                [payload],
            )
            .unwrap();
        drop(store);
        let store = LocalStateStore::open(&path, &secure).unwrap();
        assert_eq!(store.read("workspace").unwrap()[0].value, value);
        store.db.execute_batch("PRAGMA user_version=999;").unwrap();
        drop(store);
        assert!(LocalStateStore::open(&path, &secure).is_err());
    }
    #[test]
    fn sqlite_v3_inline_response_survives_the_content_store_migration() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.db");
        let secure = MemoryRootKeyStore::default();
        let mut store = LocalStateStore::open(&path, &secure).unwrap();
        store
            .write(
                "workspace",
                &[LocalRecord {
                    table: "request_executions".into(),
                    id: "legacy-response".into(),
                    value: serde_json::json!({"documentId":"request","response":{"status":200,"text":"legacy body","bodyBase64":"bGVnYWN5IGJvZHk=","timeline":{"startedAtMs":1}}}),
                }],
            )
            .unwrap();
        store.db.execute_batch("DROP TABLE response_content_chunks; DROP INDEX response_contents_expiry; DROP TABLE response_contents; DELETE FROM migrations WHERE version=4; PRAGMA user_version=3;").unwrap();
        drop(store);

        let store = LocalStateStore::open(&path, &secure).unwrap();
        let loaded = store.read("workspace").unwrap();
        assert_eq!(loaded[0].value["response"]["text"], "legacy body");
        assert_eq!(
            loaded[0].value["response"]["bodyBase64"],
            "bGVnYWN5IGJvZHk="
        );
        assert_eq!(
            store
                .db
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            4
        );
    }

    #[test]
    fn migrations_are_idempotent_and_sensitive_records_are_encrypted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        let secure = MemoryRootKeyStore::default();
        let mut store = LocalStateStore::open(&path, &secure).unwrap();
        store
            .write(
                "ws",
                &[LocalRecord {
                    table: "cookie_jar".into(),
                    id: "cookie".into(),
                    value: serde_json::json!({"value":"sensitive-cookie"}),
                }],
            )
            .unwrap();
        let bytes: Vec<u8> = store
            .db
            .query_row("SELECT payload FROM cookie_jar", [], |row| row.get(0))
            .unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("sensitive-cookie"));
        drop(store);
        let store = LocalStateStore::open(&path, &secure).unwrap();
        assert_eq!(
            store.read("ws").unwrap()[0].value["value"],
            "sensitive-cookie"
        );
        assert_eq!(
            store
                .db
                .query_row("SELECT COUNT(*) FROM migrations", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            4
        );
    }
}
