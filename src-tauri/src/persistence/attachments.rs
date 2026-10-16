//! Encrypted, immutable attachment chunks. A read transaction is the execution
//! lease: SQLite retains its pages even when the live owner is concurrently removed.
use super::local_records::LocalStateStore;
use crate::security::LocalCipher;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{self, Read},
    sync::{Arc, Mutex},
};
use zeroize::Zeroizing;

pub const CHUNK_BYTES: usize = 256 * 1024;
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
const ERROR: &str = "Local attachment is unavailable or damaged";
fn db_error(_: rusqlite::Error) -> String {
    ERROR.into()
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMetadata {
    pub name: String,
    #[serde(rename = "type")]
    pub media_type: String,
    pub size: u64,
    pub last_modified: u64,
}
impl AttachmentMetadata {
    fn validate(&self) -> Result<(), String> {
        if self.name.len() > 4096
            || self.media_type.len() > 1024
            || self.size > 4 * 1024 * 1024 * 1024
            || self.last_modified > 9007199254740991
        {
            return Err("Invalid attachment metadata".into());
        }
        Ok(())
    }
    fn descriptor(&self, stage: Option<&str>) -> Value {
        let mut result = json!({"version":2,"native":true,"name":self.name,"type":self.media_type,"size":self.size,"lastModified":self.last_modified});
        if let Some(stage) = stage {
            result["stageId"] = json!(stage);
        }
        result
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedAttachment {
    pub attachment_id: String,
    pub content_digest: String,
    pub record: Value,
}
fn context(workspace: &str, stage: &str, index: u64, size: u64) -> String {
    format!("purr:attachment:v2|{workspace}|{stage}|{index}|{size}")
}
fn metadata_context(workspace: &str, stage: &str) -> String {
    format!("purr:attachment-metadata:v2|{workspace}|{stage}")
}
fn count(size: u64) -> u64 {
    size.div_ceil(CHUNK_BYTES as u64)
}
pub(super) fn schema(db: &Connection) -> Result<(), String> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS attachment_blobs(stage_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, attachment_id TEXT, owner TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('staging','ready','adopted')), metadata BLOB NOT NULL, received INTEGER NOT NULL DEFAULT 0, chunks INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT(unixepoch()));
    CREATE INDEX IF NOT EXISTS attachment_blob_identity ON attachment_blobs(workspace_id,attachment_id);
    CREATE TABLE IF NOT EXISTS attachment_chunks(stage_id TEXT NOT NULL REFERENCES attachment_blobs(stage_id) ON DELETE CASCADE, chunk_index INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(stage_id,chunk_index));").map_err(db_error)
}
pub(super) fn collect(db: &Connection, workspace: &str) -> Result<(), String> {
    db.execute("DELETE FROM attachment_blobs WHERE workspace_id=?1 AND state='adopted' AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.workspace_id=?1 AND a.id=attachment_blobs.attachment_id) AND NOT EXISTS(SELECT 1 FROM history_attachments h WHERE h.workspace_id=?1 AND h.id=attachment_blobs.attachment_id)",[workspace]).map_err(db_error)?;
    Ok(())
}
impl LocalStateStore {
    pub fn begin_attachment(
        &self,
        workspace: &str,
        owner: &str,
        stage: &str,
        metadata: AttachmentMetadata,
    ) -> Result<(), String> {
        metadata.validate()?;
        self.prepare_workspace_keys(workspace)?;
        if (stage.len() != 36 && stage.len() != 64)
            || !stage.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
            || owner.is_empty()
            || owner.len() > 160
        {
            return Err("Invalid attachment upload".into());
        }
        let pending: i64 = self
            .db
            .query_row(
                "SELECT COUNT(*) FROM attachment_blobs WHERE owner=?1 AND state!='adopted'",
                [owner],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        if pending >= 4096 {
            return Err("Too many pending attachment uploads".into());
        }
        let cipher = self.runtime_cipher(workspace)?;
        let encrypted = cipher.encrypt(
            &serde_json::to_vec(&metadata).map_err(|_| ERROR)?,
            &metadata_context(workspace, stage),
        )?;
        self.db.execute("INSERT INTO attachment_blobs(stage_id,workspace_id,owner,state,metadata) VALUES(?1,?2,?3,'staging',?4)",params![stage,workspace,owner,encrypted]).map_err(db_error)?;
        Ok(())
    }
    fn stage_metadata(
        &self,
        workspace: &str,
        owner: &str,
        stage: &str,
    ) -> Result<(AttachmentMetadata, u64, u64, String), String> {
        let (encrypted,received,chunks,state):(Vec<u8>,u64,u64,String)=self.db.query_row("SELECT metadata,received,chunks,state FROM attachment_blobs WHERE stage_id=?1 AND workspace_id=?2 AND owner=?3",params![stage,workspace,owner],|r|Ok((r.get(0)?,r.get::<_,i64>(1)? as u64,r.get::<_,i64>(2)? as u64,r.get(3)?))).map_err(db_error)?;
        let plain = Zeroizing::new(
            self.runtime_cipher(workspace)?
                .decrypt(&encrypted, &metadata_context(workspace, stage))?,
        );
        let metadata: AttachmentMetadata = serde_json::from_slice(&plain).map_err(|_| ERROR)?;
        metadata.validate()?;
        Ok((metadata, received, chunks, state))
    }
    pub fn append_attachment(
        &mut self,
        workspace: &str,
        owner: &str,
        stage: &str,
        index: u64,
        bytes: &[u8],
    ) -> Result<(), String> {
        let (meta, received, chunks, state) = self.stage_metadata(workspace, owner, stage)?;
        if state != "staging"
            || index != chunks
            || bytes.is_empty()
            || received > meta.size
            || bytes.len() != ((meta.size - received).min(CHUNK_BYTES as u64) as usize)
        {
            return Err("Invalid attachment chunk".into());
        }
        let encrypted = self
            .runtime_cipher(workspace)?
            .encrypt(bytes, &context(workspace, stage, index, meta.size))?;
        let tx = self.db.transaction().map_err(db_error)?;
        tx.execute(
            "INSERT INTO attachment_chunks VALUES(?1,?2,?3)",
            params![stage, index as i64, encrypted],
        )
        .map_err(db_error)?;
        tx.execute(
            "UPDATE attachment_blobs SET received=received+?2,chunks=chunks+1 WHERE stage_id=?1",
            params![stage, bytes.len() as i64],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)
    }
    pub fn finish_attachment(
        &self,
        workspace: &str,
        owner: &str,
        stage: &str,
    ) -> Result<PreparedAttachment, String> {
        let (meta, received, chunks, state) = self.stage_metadata(workspace, owner, stage)?;
        if !matches!(state.as_str(), "staging" | "ready")
            || received != meta.size
            || chunks != count(meta.size)
        {
            return Err("Incomplete attachment upload".into());
        }
        let cipher = self.runtime_cipher(workspace)?;
        let mut hash = Sha256::new();
        for index in 0..chunks {
            let plain = read_chunk(&self.db, &cipher, workspace, stage, index, meta.size)?;
            hash.update(&*plain);
        }
        let digest = hex(&hash.finalize());
        let metadata_digest = hex(&Sha256::digest(
            serde_json::to_vec(&json!([
                meta.name,
                meta.media_type,
                meta.last_modified,
                digest
            ]))
            .map_err(|_| ERROR)?,
        ));
        let id = format!("{}-{}", digest, &metadata_digest[..16]);
        self.db
            .execute(
                "UPDATE attachment_blobs SET attachment_id=?2,state='ready' WHERE stage_id=?1",
                params![stage, id],
            )
            .map_err(db_error)?;
        Ok(PreparedAttachment {
            attachment_id: id,
            content_digest: digest,
            record: meta.descriptor(Some(stage)),
        })
    }
    pub fn abort_attachment(
        &self,
        workspace: &str,
        owner: &str,
        stage: &str,
    ) -> Result<(), String> {
        self.db.execute("DELETE FROM attachment_blobs WHERE stage_id=?1 AND workspace_id=?2 AND owner=?3 AND state!='adopted' AND NOT EXISTS(SELECT 1 FROM pending_commits p WHERE p.workspace_id=attachment_blobs.workspace_id)",params![stage,workspace,owner]).map_err(db_error)?;
        Ok(())
    }
    pub fn release_attachment_owner(&self, owner: &str) -> Result<(), String> {
        self.db
            .execute(
                "DELETE FROM attachment_blobs WHERE owner=?1 AND state!='adopted' AND NOT EXISTS(SELECT 1 FROM pending_commits p WHERE p.workspace_id=attachment_blobs.workspace_id)",
                [owner],
            )
            .map_err(db_error)?;
        Ok(())
    }
    pub fn cleanup_attachment_staging(&self) -> Result<(), String> {
        self.db.execute("DELETE FROM attachment_blobs WHERE state!='adopted' AND NOT EXISTS(SELECT 1 FROM pending_commits p WHERE p.workspace_id=attachment_blobs.workspace_id)",[]).map_err(db_error)?;
        Ok(())
    }
    pub fn prepare_attachment(
        &mut self,
        workspace: &str,
        id: &str,
    ) -> Result<AttachmentSource, String> {
        let (payload,protection):(Vec<u8>,String)=self.db.query_row("SELECT payload,protection FROM attachments WHERE workspace_id=?1 AND id=?2 UNION ALL SELECT payload,protection FROM history_attachments WHERE workspace_id=?1 AND id=?2 LIMIT 1",params![workspace,id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(db_error)?;
        let plain = Zeroizing::new(self.decode_runtime(
            workspace,
            &protection,
            &payload,
            &format!("{workspace}/attachments/{id}"),
        )?);
        let mut descriptor: Value = serde_json::from_slice(&plain).map_err(|_| ERROR)?;
        if descriptor["version"] == 1 {
            // Legacy files are authenticated in full once, then migrated atomically.
            let legacy = self.read_legacy_attachment(workspace, id)?;
            let mut random = [0u8; 32];
            getrandom::fill(&mut random).map_err(|_| "Cannot generate upload identifier")?;
            let stage = random
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            let meta = AttachmentMetadata {
                name: legacy.name,
                media_type: legacy.media_type,
                size: legacy.bytes.len() as u64,
                last_modified: descriptor["lastModified"].as_u64().ok_or(ERROR)?,
            };
            self.begin_attachment(workspace, "legacy-migration", &stage, meta.clone())?;
            let result = (|| {
                for (index, chunk) in legacy.bytes.chunks(CHUNK_BYTES).enumerate() {
                    self.append_attachment(
                        workspace,
                        "legacy-migration",
                        &stage,
                        index as u64,
                        chunk,
                    )?;
                }
                self.finish_attachment(workspace, "legacy-migration", &stage)?;
                let cipher = self.runtime_cipher(workspace)?;
                let mut value = meta.descriptor(None);
                value["contentId"] = json!(stage);
                let encrypted = cipher.encrypt(
                    &serde_json::to_vec(&value).map_err(|_| ERROR)?,
                    &format!("{workspace}/attachments/{id}"),
                )?;
                let tx = self.db.transaction().map_err(db_error)?;
                for table in ["attachments", "history_attachments"] {
                    tx.execute(&format!("UPDATE {table} SET payload=?3,protection='encrypted' WHERE workspace_id=?1 AND id=?2"),params![workspace,id,encrypted]).map_err(db_error)?;
                }
                tx.execute("UPDATE attachment_blobs SET state='adopted',attachment_id=?2 WHERE stage_id=?1",params![stage,id]).map_err(db_error)?;
                tx.commit().map_err(db_error)?;
                Ok::<Value, String>(value)
            })();
            if result.is_err() {
                let _ = self.abort_attachment(workspace, "legacy-migration", &stage);
            }
            descriptor = result?;
        }
        let metadata: AttachmentMetadata =
            serde_json::from_value(descriptor.clone()).map_err(|_| ERROR)?;
        metadata.validate()?;
        let stage = descriptor["contentId"].as_str().ok_or(ERROR)?.to_string();
        let path = self.db.path().ok_or(ERROR)?;
        let connection =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(db_error)?;
        connection
            .execute_batch("BEGIN DEFERRED")
            .map_err(db_error)?;
        // Force the snapshot now, while caller holds persistence mutation lock.
        let stored:(u64,u64)=connection.query_row("SELECT received,chunks FROM attachment_blobs WHERE stage_id=?1 AND workspace_id=?2 AND attachment_id=?3 AND state='adopted'",params![stage,workspace,id],|r|Ok((r.get::<_,i64>(0)? as u64,r.get::<_,i64>(1)? as u64))).map_err(db_error)?;
        let actual:(i64,Option<i64>,Option<i64>)=connection.query_row("SELECT COUNT(*),MIN(chunk_index),MAX(chunk_index) FROM attachment_chunks WHERE stage_id=?1",[&stage],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(db_error)?;
        let expected_count = count(metadata.size);
        if actual.0 != expected_count as i64
            || (expected_count > 0
                && (actual.1 != Some(0) || actual.2 != Some(expected_count as i64 - 1)))
        {
            return Err(ERROR.into());
        }
        if stored != (metadata.size, count(metadata.size)) {
            return Err(ERROR.into());
        }
        Ok(AttachmentSource {
            name: metadata.name,
            media_type: metadata.media_type,
            byte_length: metadata.size,
            inner: Arc::new(Snapshot {
                db: Mutex::new(connection),
                cipher: self.runtime_cipher(workspace)?,
                workspace: workspace.into(),
                stage,
            }),
        })
    }
}
pub(super) fn adopt(
    db: &Connection,
    cipher: &LocalCipher,
    workspace: &str,
    id: &str,
    value: &Value,
    history: bool,
) -> Result<(), String> {
    let cipher = cipher.for_scope(crate::security::scoped::ProtectionScope::runtime(workspace))?;
    if let Some(stage) = value["stageId"].as_str() {
        let row:Option<(String,Vec<u8>)>=db.query_row("SELECT state,metadata FROM attachment_blobs WHERE stage_id=?1 AND workspace_id=?2 AND attachment_id=?3",params![stage,workspace,id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(db_error)?;
        let (state, encrypted) = row.ok_or(ERROR)?;
        if !matches!(state.as_str(), "ready" | "adopted") {
            return Err(ERROR.into());
        }
        let plain =
            Zeroizing::new(cipher.decrypt(&encrypted, &metadata_context(workspace, stage))?);
        let metadata: AttachmentMetadata = serde_json::from_slice(&plain).map_err(|_| ERROR)?;
        let expected = metadata.descriptor(Some(stage));
        if &expected != value {
            return Err("Attachment metadata changed during upload".into());
        }
        let existing:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM attachments WHERE workspace_id=?1 AND id=?2 UNION ALL SELECT 1 FROM history_attachments WHERE workspace_id=?1 AND id=?2)",params![workspace,id],|r|r.get(0)).map_err(db_error)?;
        if !existing {
            let mut descriptor = metadata.descriptor(None);
            descriptor["contentId"] = json!(stage);
            let payload = cipher.encrypt(
                &serde_json::to_vec(&descriptor).map_err(|_| ERROR)?,
                &format!("{workspace}/attachments/{id}"),
            )?;
            let table = if history {
                "history_attachments"
            } else {
                "attachments"
            };
            db.execute(&format!("INSERT INTO {table}(workspace_id,id,payload,protection) VALUES(?1,?2,?3,'encrypted')"),params![workspace,id,payload]).map_err(db_error)?;
            db.execute(
                "UPDATE attachment_blobs SET state='adopted' WHERE stage_id=?1",
                [stage],
            )
            .map_err(db_error)?;
        }
    }
    Ok(())
}
fn read_chunk(
    db: &Connection,
    cipher: &LocalCipher,
    workspace: &str,
    stage: &str,
    index: u64,
    size: u64,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let payload: Vec<u8> = db
        .query_row(
            "SELECT payload FROM attachment_chunks WHERE stage_id=?1 AND chunk_index=?2 AND length(payload)<=?3",
            params![stage, index as i64, (CHUNK_BYTES + 4096) as i64],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    let plain = Zeroizing::new(cipher.decrypt(&payload, &context(workspace, stage, index, size))?);
    let offset = index.checked_mul(CHUNK_BYTES as u64).ok_or(ERROR)?;
    let expected = size
        .checked_sub(offset)
        .ok_or(ERROR)?
        .min(CHUNK_BYTES as u64) as usize;
    if expected == 0 {
        return Err(ERROR.into());
    }
    if plain.len() != expected {
        return Err(ERROR.into());
    }
    Ok(plain)
}
struct Snapshot {
    db: Mutex<Connection>,
    cipher: LocalCipher,
    workspace: String,
    stage: String,
}
#[derive(Clone)]
pub struct AttachmentSource {
    pub name: String,
    pub media_type: String,
    pub byte_length: u64,
    inner: Arc<Snapshot>,
}
impl AttachmentSource {
    pub fn open(&self) -> Result<AttachmentReader, String> {
        Ok(AttachmentReader {
            source: self.clone(),
            index: 0,
            offset: 0,
            buffer: Zeroizing::new(Vec::new()),
        })
    }
}
pub struct AttachmentReader {
    source: AttachmentSource,
    index: u64,
    offset: usize,
    buffer: Zeroizing<Vec<u8>>,
}
impl Read for AttachmentReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        if self.offset == self.buffer.len() {
            if self.index >= count(self.source.byte_length) {
                return Ok(0);
            }
            let inner = &self.source.inner;
            let db = inner.db.lock().map_err(|_| io::Error::other(ERROR))?;
            self.buffer = read_chunk(
                &db,
                &inner.cipher,
                &inner.workspace,
                &inner.stage,
                self.index,
                self.source.byte_length,
            )
            .map_err(io::Error::other)?;
            self.index += 1;
            self.offset = 0;
        }
        let take = out.len().min(self.buffer.len() - self.offset);
        out[..take].copy_from_slice(&self.buffer[self.offset..self.offset + take]);
        self.offset += take;
        Ok(take)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        persistence::local_records::{LocalRecord, RecordProtection},
        security::tests::MemoryRootKeyStore,
    };
    use base64::{engine::general_purpose::STANDARD, Engine};
    fn setup() -> (tempfile::TempDir, LocalStateStore) {
        let dir = tempfile::tempdir().unwrap();
        let store =
            LocalStateStore::open(&dir.path().join("state.db"), &MemoryRootKeyStore::default())
                .unwrap();
        (dir, store)
    }
    fn stage(store: &mut LocalStateStore, bytes: &[u8]) -> PreparedAttachment {
        let id = "11111111-1111-4111-8111-111111111111";
        store
            .begin_attachment(
                "workspace",
                "main",
                id,
                AttachmentMetadata {
                    name: "payload.bin".into(),
                    media_type: "application/octet-stream".into(),
                    size: bytes.len() as u64,
                    last_modified: 123,
                },
            )
            .unwrap();
        for (index, chunk) in bytes.chunks(CHUNK_BYTES).enumerate() {
            store
                .append_attachment("workspace", "main", id, index as u64, chunk)
                .unwrap();
        }
        store.finish_attachment("workspace", "main", id).unwrap()
    }
    fn adopt(store: &mut LocalStateStore, prepared: &PreparedAttachment) {
        store
            .write(
                "workspace",
                &[LocalRecord {
                    table: "attachments".into(),
                    id: prepared.attachment_id.clone(),
                    protection: RecordProtection::Encrypted,
                    value: prepared.record.clone(),
                }],
            )
            .unwrap();
    }
    fn bytes(source: &AttachmentSource) -> Vec<u8> {
        let mut bytes = vec![];
        source.open().unwrap().read_to_end(&mut bytes).unwrap();
        bytes
    }
    #[test]
    fn chunks_replay_exactly_and_snapshot_outlives_owner_deletion() {
        let (_dir, mut store) = setup();
        let input = (0..CHUNK_BYTES * 3 + 11)
            .map(|i| (i % 251) as u8)
            .collect::<Vec<_>>();
        let prepared = stage(&mut store, &input);
        assert!(store
            .prepare_attachment("workspace", &prepared.attachment_id)
            .is_err());
        adopt(&mut store, &prepared);
        let source = store
            .prepare_attachment("workspace", &prepared.attachment_id)
            .unwrap();
        assert_eq!(bytes(&source), input);
        assert_eq!(bytes(&source), input);
        let records = store.read_partial("workspace").unwrap().0;
        assert_eq!(records[0].value["version"], 2);
        assert!(records[0].value.get("base64").is_none());
        assert!(records[0].value.get("contentId").is_none());
        store
            .write(
                "workspace",
                &[LocalRecord {
                    table: "attachments".into(),
                    id: prepared.attachment_id.clone(),
                    protection: RecordProtection::Encrypted,
                    value: Value::Null,
                }],
            )
            .unwrap();
        assert_eq!(
            store
                .db
                .query_row("SELECT COUNT(*) FROM attachment_blobs", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(bytes(&source), input);
        assert!(store
            .prepare_attachment("workspace", &prepared.attachment_id)
            .is_err());
    }
    #[test]
    fn staging_is_bound_to_owner_sequence_size_and_exact_metadata() {
        let (_dir, mut store) = setup();
        let prepared = stage(&mut store, b"private bytes");
        let stage = prepared.record["stageId"].as_str().unwrap();
        assert!(store
            .finish_attachment("workspace", "other", stage)
            .is_err());
        assert!(store
            .append_attachment("workspace", "main", stage, 0, b"x")
            .is_err());
        let mut bad = prepared.record.clone();
        bad["size"] = json!(100);
        assert!(store
            .write(
                "workspace",
                &[LocalRecord {
                    table: "attachments".into(),
                    id: prepared.attachment_id.clone(),
                    protection: RecordProtection::Encrypted,
                    value: bad
                }]
            )
            .is_err());
        store.abort_attachment("workspace", "other", stage).unwrap();
        assert!(store.finish_attachment("workspace", "main", stage).is_ok());
        store.abort_attachment("workspace", "main", stage).unwrap();
        assert!(store.finish_attachment("workspace", "main", stage).is_err());
    }
    #[test]
    fn chunks_are_authenticated_before_exposure_and_never_plaintext() {
        let (dir, mut store) = setup();
        let marker = b"unique-attachment-plaintext-marker";
        let prepared = stage(&mut store, marker);
        adopt(&mut store, &prepared);
        let stage = prepared.record["stageId"].as_str().unwrap();
        let mut ciphertext: Vec<u8> = store
            .db
            .query_row("SELECT payload FROM attachment_chunks", [], |r| r.get(0))
            .unwrap();
        assert!(!ciphertext.windows(marker.len()).any(|w| w == marker));
        ciphertext[12] ^= 1;
        store
            .db
            .execute(
                "UPDATE attachment_chunks SET payload=?2 WHERE stage_id=?1",
                params![stage, ciphertext],
            )
            .unwrap();
        let source = store
            .prepare_attachment("workspace", &prepared.attachment_id)
            .unwrap();
        let mut output = [0u8; 64];
        assert!(source.open().unwrap().read(&mut output).is_err());
        assert_eq!(output, [0; 64]);
        for path in [dir.path().join("state.db"), dir.path().join("state.db-wal")] {
            if let Ok(data) = std::fs::read(path) {
                assert!(!data.windows(marker.len()).any(|w| w == marker));
            }
        }
    }
    #[test]
    fn legacy_migration_preserves_id_and_is_lazy() {
        let (_dir, mut store) = setup();
        let value = json!({"version":1,"name":"old.bin","type":"application/octet-stream","lastModified":7,"size":3,"base64":STANDARD.encode(b"old")});
        store
            .write(
                "workspace",
                &[LocalRecord {
                    table: "attachments".into(),
                    id: "legacy-id".into(),
                    protection: RecordProtection::Encrypted,
                    value,
                }],
            )
            .unwrap();
        assert_eq!(
            store.read_partial("workspace").unwrap().0[0].value["version"],
            1
        );
        let source = store.prepare_attachment("workspace", "legacy-id").unwrap();
        assert_eq!(bytes(&source), b"old");
        assert_eq!(
            store.read_partial("workspace").unwrap().0[0].value["version"],
            2
        );
        assert_eq!(
            bytes(&store.prepare_attachment("workspace", "legacy-id").unwrap()),
            b"old"
        );
    }
    #[test]
    fn corrupt_legacy_record_is_not_replaced() {
        let (_dir, mut store) = setup();
        let value = json!({"version":1,"name":"old.bin","type":"application/octet-stream","lastModified":7,"size":3,"base64":"!!!!"});
        store
            .write(
                "workspace",
                &[LocalRecord {
                    table: "attachments".into(),
                    id: "legacy-id".into(),
                    protection: RecordProtection::Encrypted,
                    value,
                }],
            )
            .unwrap();
        let before: Vec<u8> = store
            .db
            .query_row("SELECT payload FROM attachments", [], |r| r.get(0))
            .unwrap();
        assert!(store.prepare_attachment("workspace", "legacy-id").is_err());
        let after: Vec<u8> = store
            .db
            .query_row("SELECT payload FROM attachments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, after);
    }
    #[test]
    fn incomplete_and_empty_uploads_have_explicit_completion() {
        let (_dir, mut store) = setup();
        let stage_id = "22222222-2222-4222-8222-222222222222";
        store
            .begin_attachment(
                "workspace",
                "main",
                stage_id,
                AttachmentMetadata {
                    name: "x".into(),
                    media_type: "".into(),
                    size: 3,
                    last_modified: 0,
                },
            )
            .unwrap();
        assert!(store
            .append_attachment("workspace", "main", stage_id, 1, b"abc")
            .is_err());
        assert!(store
            .append_attachment("workspace", "main", stage_id, 0, b"a")
            .is_err());
        assert!(store
            .finish_attachment("workspace", "main", stage_id)
            .is_err());
        store.release_attachment_owner("main").unwrap();
        assert!(store
            .finish_attachment("workspace", "main", stage_id)
            .is_err());
        let prepared = stage(&mut store, b"");
        adopt(&mut store, &prepared);
        assert_eq!(
            bytes(
                &store
                    .prepare_attachment("workspace", &prepared.attachment_id)
                    .unwrap()
            ),
            b""
        );
    }
    #[test]
    fn abort_and_startup_keep_pending_commit_data() {
        let (_dir, mut store) = setup();
        let prepared = stage(&mut store, b"pending bytes");
        let stage = prepared.record["stageId"].as_str().unwrap();
        store
            .db
            .execute(
                "INSERT INTO pending_commits(workspace_id,payload) VALUES('workspace',X'00')",
                [],
            )
            .unwrap();
        store.abort_attachment("workspace", "main", stage).unwrap();
        store.release_attachment_owner("main").unwrap();
        store.cleanup_attachment_staging().unwrap();
        assert!(store.finish_attachment("workspace", "main", stage).is_ok());
        store.db.execute("DELETE FROM pending_commits", []).unwrap();
        store.cleanup_attachment_staging().unwrap();
        assert!(store.finish_attachment("workspace", "main", stage).is_err());
    }
    #[test]
    fn missing_extra_and_reordered_chunks_fail_before_affected_bytes() {
        for mutation in ["DELETE FROM attachment_chunks WHERE chunk_index=1", "INSERT INTO attachment_chunks SELECT stage_id,2,payload FROM attachment_chunks WHERE chunk_index=0", "UPDATE attachment_chunks SET payload=(SELECT payload FROM attachment_chunks WHERE chunk_index=1) WHERE chunk_index=0"] {
            let (_dir,mut store)=setup();let prepared=stage(&mut store,&vec![42;CHUNK_BYTES+3]);adopt(&mut store,&prepared);
            store.db.execute(mutation,[]).unwrap();
            // Reading workspace metadata never decrypts file chunks.
            assert_eq!(store.read_partial("workspace").unwrap().0[0].value["version"],2);
            if let Ok(source)=store.prepare_attachment("workspace",&prepared.attachment_id){let mut out=[0;8];assert!(source.open().unwrap().read(&mut out).is_err());assert_eq!(out,[0;8]);}
        }
    }
    #[test]
    fn many_chunks_keep_reader_buffer_bounded() {
        let (_dir, mut store) = setup();
        let id = "33333333-3333-4333-8333-333333333333";
        let chunk = vec![83; CHUNK_BYTES];
        let chunks = 32;
        store
            .begin_attachment(
                "workspace",
                "main",
                id,
                AttachmentMetadata {
                    name: "large.bin".into(),
                    media_type: "".into(),
                    size: (CHUNK_BYTES * chunks) as u64,
                    last_modified: 0,
                },
            )
            .unwrap();
        for index in 0..chunks {
            store
                .append_attachment("workspace", "main", id, index as u64, &chunk)
                .unwrap();
        }
        let prepared = store.finish_attachment("workspace", "main", id).unwrap();
        adopt(&mut store, &prepared);
        let mut reader = store
            .prepare_attachment("workspace", &prepared.attachment_id)
            .unwrap()
            .open()
            .unwrap();
        let mut out = [0; 8192];
        let mut total = 0;
        loop {
            let n = reader.read(&mut out).unwrap();
            if n == 0 {
                break;
            }
            assert!(out[..n].iter().all(|b| *b == 83));
            assert!(reader.buffer.len() <= CHUNK_BYTES);
            total += n;
        }
        assert_eq!(total, CHUNK_BYTES * chunks);
    }
    #[test]
    fn schema_eight_migrates_and_scoped_chunks_reopen_without_rekeying() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        let keys = crate::security::RootCiphers::from_root(&crate::security::test_key(), false)
            .unwrap()
            .with_scope_keys(&dir.path().join("scope-keys.sqlite3"), "synthetic-vault")
            .unwrap();
        let store = LocalStateStore::open_with_ciphers(&path, &keys).unwrap();
        store.db.execute_batch("DROP TABLE attachment_chunks; DROP TABLE attachment_blobs; DELETE FROM migrations WHERE version=9; PRAGMA user_version=8;").unwrap();
        drop(store);
        let mut store = LocalStateStore::open_with_ciphers(&path, &keys).unwrap();
        assert_eq!(
            store
                .db
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            9
        );
        let prepared = stage(&mut store, b"scoped attachment");
        adopt(&mut store, &prepared);
        drop(store);
        let mut store = LocalStateStore::open_with_ciphers(&path, &keys).unwrap();
        assert_eq!(
            bytes(
                &store
                    .prepare_attachment("workspace", &prepared.attachment_id)
                    .unwrap()
            ),
            b"scoped attachment"
        );
        assert!(store
            .prepare_attachment("different-workspace", &prepared.attachment_id)
            .is_err());
    }
    #[test]
    fn history_only_staged_attachment_adopts_without_live_alias_and_prunes() {
        let (_dir, mut store) = setup();
        let prepared = stage(&mut store, b"history-only content");
        let entry = json!({"version":1,"id":"history-only","documentId":"request","name":"Example","kind":"http","method":"POST","url":"http://localhost/upload","startedAt":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64,"durationMs":12,"outcome":"error","status":null,"size":0,"pinned":false,"editor":{"url":"http://localhost/upload"},"response":null,"error":"Offline","files":{prepared.attachment_id.clone():prepared.record.clone()}});
        store
            .request_history("workspace", json!({"operation":"append","entry":entry}))
            .unwrap();
        assert_eq!(
            store
                .db
                .query_row("SELECT COUNT(*) FROM attachments", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let source = store
            .prepare_attachment("workspace", &prepared.attachment_id)
            .unwrap();
        assert_eq!(bytes(&source), b"history-only content");
        store
            .request_history(
                "workspace",
                json!({"operation":"remove","filter":{"id":"history-only"}}),
            )
            .unwrap();
        assert_eq!(
            store
                .db
                .query_row("SELECT COUNT(*) FROM attachment_blobs", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(bytes(&source), b"history-only content");
    }
    #[test]
    fn workspace_batch_adopts_more_than_sixty_four_distinct_files() {
        let (_dir, mut store) = setup();
        let mut records = Vec::new();
        for index in 0..65u8 {
            let stage_id = format!("44444444-4444-4444-8444-{index:012x}");
            store
                .begin_attachment(
                    "workspace",
                    "main",
                    &stage_id,
                    AttachmentMetadata {
                        name: format!("{index}.bin"),
                        media_type: "".into(),
                        size: 1,
                        last_modified: 0,
                    },
                )
                .unwrap();
            store
                .append_attachment("workspace", "main", &stage_id, 0, &[index])
                .unwrap();
            let prepared = store
                .finish_attachment("workspace", "main", &stage_id)
                .unwrap();
            records.push(LocalRecord {
                table: "attachments".into(),
                id: prepared.attachment_id,
                protection: RecordProtection::Encrypted,
                value: prepared.record,
            });
        }
        store.write("workspace", &records).unwrap();
        store.release_attachment_owner("main").unwrap();
        assert_eq!(
            store
                .db
                .query_row(
                    "SELECT COUNT(*) FROM attachment_blobs WHERE state='adopted'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            65
        );
        for (index, record) in records.iter().enumerate() {
            assert_eq!(
                bytes(&store.prepare_attachment("workspace", &record.id).unwrap()),
                vec![index as u8]
            );
        }
        assert!(store
            .begin_attachment(
                "workspace",
                "main",
                "55555555-5555-4555-8555-555555555555",
                AttachmentMetadata {
                    name: "oversized".into(),
                    media_type: "".into(),
                    size: 4 * 1024 * 1024 * 1024 + 1,
                    last_modified: 0
                }
            )
            .is_err());
    }
}
