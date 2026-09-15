use super::contracts::{
    ByteRange, ContentInfo, ContentMetadata, ContentWindow, LinePage, ResponseContentRef,
};
use crate::{
    persistence::local_records::LocalStateStore,
    security::{LocalCipher, RootCiphers, RootKeyStore},
};
use aes_gcm::aead::rand_core::{OsRng, RngCore};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    path::Path,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const ENCRYPTED_TABLES: [&str; 12] = [
    "workspace_local_state",
    "drafts",
    "document_session_state",
    "request_executions",
    "cookie_jar",
    "schema_cache",
    "recent_items",
    "attachments",
    "pending_commits",
    "response_bodies",
    "secret_values",
    "response_content_chunks",
];

#[derive(Clone, Copy)]
pub struct ResponseLimits {
    pub chunk_bytes: usize,
    pub max_window_bytes: usize,
    pub max_content_bytes: u64,
    pub max_retained_bytes: Option<u64>,
    pub staging_ttl_seconds: i64,
}

impl Default for ResponseLimits {
    fn default() -> Self {
        Self {
            chunk_bytes: 256 * 1024,
            max_window_bytes: 4 * 1024 * 1024,
            max_content_bytes: 128 * 1024 * 1024,
            max_retained_bytes: None,
            staging_ttl_seconds: 60 * 60,
        }
    }
}

pub struct ResponseContentStore {
    db: Connection,
    cipher: LocalCipher,
    limits: ResponseLimits,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ContentWriteTiming {
    pub encryption: Duration,
    pub sqlite: Duration,
}

impl ResponseContentStore {
    pub fn open(path: &Path, root_store: &dyn RootKeyStore) -> Result<Self, String> {
        Self::open_with_limits(path, root_store, ResponseLimits::default())
    }

    fn open_with_limits(
        path: &Path,
        root_store: &dyn RootKeyStore,
        limits: ResponseLimits,
    ) -> Result<Self, String> {
        let mut db = Connection::open(path).map_err(|_| "Cannot open response storage")?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "Cannot configure response storage")?;
        db.execute_batch(
            // Response bodies are reconstructible runtime data. NORMAL keeps WAL
            // transactions atomic while avoiding a disk sync for every streamed
            // append; canonical project data continues to use FULL durability.
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
        )
        .map_err(|_| "Cannot configure response storage")?;
        LocalStateStore::migrate(&mut db)?;
        let mut has_encrypted_data = false;
        for table in ENCRYPTED_TABLES {
            has_encrypted_data |= db
                .query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM {table})"),
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|_| "Cannot inspect response storage")?;
        }
        let cipher = RootCiphers::open(root_store, has_encrypted_data, false)?.response_content;
        let mut store = Self { db, cipher, limits };
        store.cleanup_expired(now_seconds())?;
        Ok(store)
    }

    #[allow(dead_code)] // Native HTTP starts using the writer API in Phase 6.
    pub fn create_staging(
        &mut self,
        metadata: ContentMetadata,
    ) -> Result<ResponseContentRef, String> {
        self.cleanup_expired(now_seconds())?;
        let mut random = [0_u8; 16];
        OsRng.fill_bytes(&mut random);
        let id = format!(
            "content-{}",
            random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        let created_at = now_seconds();
        self.db.execute(
            "INSERT INTO response_contents(id,state,byte_length,media_type,charset,created_at,expires_at) VALUES(?1,'staging',0,?2,?3,?4,?5)",
            params![id, metadata.media_type, metadata.charset, created_at, created_at + self.limits.staging_ttl_seconds],
        ).map_err(|_| "Cannot create response content")?;
        self.reference(&id)
    }

    #[allow(dead_code)]
    pub fn append(&mut self, id: &str, bytes: &[u8]) -> Result<ContentWriteTiming, String> {
        validate_id(id)?;
        if bytes.is_empty() {
            return Ok(ContentWriteTiming::default());
        }
        let started = Instant::now();
        let mut encryption = Duration::ZERO;
        let (state, mut offset): (String, u64) = self
            .db
            .query_row(
                "SELECT state,byte_length FROM response_contents WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| "Cannot inspect response content")?
            .ok_or("Response content does not exist")?;
        if state != "staging" {
            return Err("Response content is no longer writable".into());
        }
        let next_length = offset
            .checked_add(bytes.len() as u64)
            .ok_or("Response is too large")?;
        if next_length > self.limits.max_content_bytes {
            return Err("Response exceeds the 128 MiB capture limit.".into());
        }
        if let Some(maximum) = self.limits.max_retained_bytes {
            let retained: u64 = self
                .db
                .query_row(
                    "SELECT COALESCE(SUM(byte_length),0) FROM response_contents",
                    [],
                    |row| row.get(0),
                )
                .map_err(|_| "Cannot inspect response quota")?;
            if retained
                .checked_add(bytes.len() as u64)
                .is_none_or(|total| total > maximum)
            {
                return Err("Response storage quota is exceeded".into());
            }
        }
        let first_index: u64 = self.db.query_row("SELECT COALESCE(MAX(chunk_index)+1,0) FROM response_content_chunks WHERE content_id=?1", [id], |row| row.get(0)).map_err(|_| "Cannot inspect response content")?;
        let transaction = self
            .db
            .transaction()
            .map_err(|_| "Cannot write response content")?;
        for (relative_index, chunk) in bytes.chunks(self.limits.chunk_bytes).enumerate() {
            let index = first_index + relative_index as u64;
            let aad = chunk_aad(id, index, offset, chunk.len() as u64);
            let encryption_started = Instant::now();
            let sealed = self.cipher.seal(chunk, &aad)?;
            encryption += encryption_started.elapsed();
            transaction.execute(
                "INSERT INTO response_content_chunks(content_id,chunk_index,plain_offset,plain_length,crypto_version,nonce,ciphertext) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![id, index, offset, chunk.len() as u64, sealed.version, sealed.nonce.as_slice(), sealed.ciphertext],
            ).map_err(|_| "Cannot write response content")?;
            offset += chunk.len() as u64;
        }
        transaction
            .execute(
                "UPDATE response_contents SET byte_length=?2 WHERE id=?1 AND state='staging'",
                params![id, offset],
            )
            .map_err(|_| "Cannot update response content")?;
        transaction
            .commit()
            .map_err(|_| "Cannot commit response content".to_string())?;
        Ok(ContentWriteTiming {
            encryption,
            sqlite: started.elapsed().saturating_sub(encryption),
        })
    }

    #[allow(dead_code)]
    pub fn finish(&mut self, id: &str) -> Result<ResponseContentRef, String> {
        validate_id(id)?;
        let changed = self
            .db
            .execute(
                "UPDATE response_contents SET state='ready' WHERE id=?1 AND state='staging'",
                [id],
            )
            .map_err(|_| "Cannot complete response content")?;
        if changed != 1 {
            return Err("Response content is not staging".into());
        }
        self.reference(id)
    }

    pub fn inspect(&self, id: &str) -> Result<ContentInfo, String> {
        let reference = self.reference(id)?;
        if !reference.complete {
            return Err("Response content is incomplete".into());
        }
        Ok(ContentInfo {
            size: reference.byte_length,
            media_type: reference.media_type,
            text_encoding: reference.charset,
        })
    }

    pub fn read_range(
        &self,
        id: &str,
        range: ByteRange,
        mode: &str,
    ) -> Result<ContentWindow, String> {
        validate_id(id)?;
        let reference = self.reference(id)?;
        if !reference.complete {
            return Err("Response content is incomplete".into());
        }
        let requested =
            usize::try_from(range.length).map_err(|_| "Response window is too large")?;
        if requested > self.limits.max_window_bytes {
            return Err("Response window exceeds the configured limit".into());
        }
        let end = range
            .offset
            .saturating_add(range.length)
            .min(reference.byte_length);
        let mut bytes = Vec::with_capacity((end.saturating_sub(range.offset)) as usize);
        let mut expected_offset = range.offset;
        let mut statement = self.db.prepare(
            "SELECT chunk_index,plain_offset,plain_length,crypto_version,nonce,ciphertext FROM response_content_chunks WHERE content_id=?1 AND plain_offset < ?3 AND plain_offset + plain_length > ?2 ORDER BY chunk_index",
        ).map_err(|_| "Cannot read response content")?;
        let chunks = statement
            .query_map(params![id, range.offset, end], |row| {
                Ok((
                    row.get::<_, u64>(0)?,
                    row.get::<_, u64>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                ))
            })
            .map_err(|_| "Cannot read response content")?;
        for row in chunks {
            let (index, offset, length, version, nonce, ciphertext) =
                row.map_err(|_| "Cannot read response content")?;
            let plain = self.cipher.open_sealed(
                version,
                &nonce,
                &ciphertext,
                &chunk_aad(id, index, offset, length),
            )?;
            if plain.len() as u64 != length {
                return Err("Response content chunk is damaged".into());
            }
            let from = range.offset.saturating_sub(offset) as usize;
            let to = (end - offset).min(length) as usize;
            if offset + from as u64 != expected_offset {
                return Err("Response content has a missing or reordered chunk".into());
            }
            bytes.extend_from_slice(&plain[from..to]);
            expected_offset += (to - from) as u64;
        }
        if expected_offset != end {
            return Err("Response content has a missing or reordered chunk".into());
        }
        let content = match mode {
            "text" => String::from_utf8_lossy(&bytes).into_owned(),
            "hex" => bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
            "bytes" | "base64" => STANDARD.encode(&bytes),
            _ => return Err("Unsupported response window mode".into()),
        };
        Ok(ContentWindow {
            offset: range.offset,
            bytes_read: bytes.len() as u64,
            content,
            complete: end >= reference.byte_length,
        })
    }

    pub fn read_lines(
        &self,
        id: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<LinePage, String> {
        let offset = cursor
            .unwrap_or("0")
            .parse::<u64>()
            .map_err(|_| "Invalid line cursor")?;
        let info = self.inspect(id)?;
        if offset > info.size {
            return Err("Invalid line cursor".into());
        }
        if offset == info.size {
            return Ok(LinePage {
                lines: Vec::new(),
                next_cursor: None,
                complete: true,
            });
        }
        let window = self.read_range(
            id,
            ByteRange {
                offset,
                length: self.limits.max_window_bytes as u64,
            },
            "base64",
        )?;
        let bytes = STANDARD
            .decode(&window.content)
            .map_err(|_| "Cannot decode response line window")?;
        let text =
            std::str::from_utf8(&bytes).map_err(|_| "Response content is not valid UTF-8")?;
        let maximum_lines = limit.clamp(1, 1000);
        let mut lines = Vec::new();
        let mut consumed = 0_usize;
        for part in text.split_inclusive('\n').take(maximum_lines) {
            if !part.ends_with('\n') && !window.complete {
                break;
            }
            consumed += part.len();
            let line = part.strip_suffix('\n').unwrap_or(part);
            lines.push(line.strip_suffix('\r').unwrap_or(line).to_string());
        }
        if consumed == 0 && !window.complete {
            return Err("Response line exceeds the configured window limit".into());
        }
        let next = offset + consumed as u64;
        let complete = next >= info.size;
        Ok(LinePage {
            lines,
            next_cursor: (!complete).then(|| next.to_string()),
            complete,
        })
    }

    pub fn release(&mut self, id: &str) -> Result<(), String> {
        validate_id(id)?;
        self.db
            .execute(
                "DELETE FROM response_contents WHERE id=?1 AND state<>'adopted'",
                [id],
            )
            .map_err(|_| "Cannot release response content")?;
        Ok(())
    }

    pub fn cleanup_expired(&mut self, now: i64) -> Result<usize, String> {
        self.db.execute("DELETE FROM response_contents WHERE state<>'adopted' AND expires_at IS NOT NULL AND expires_at<=?1", [now]).map_err(|_| "Cannot clean response content".to_string())
    }

    fn reference(&self, id: &str) -> Result<ResponseContentRef, String> {
        validate_id(id)?;
        self.db
            .query_row(
                "SELECT byte_length,media_type,charset,state FROM response_contents WHERE id=?1",
                [id],
                |row| {
                    let state: String = row.get(3)?;
                    Ok(ResponseContentRef {
                        id: id.into(),
                        byte_length: row.get(0)?,
                        media_type: row.get(1)?,
                        charset: row.get(2)?,
                        complete: state != "staging",
                    })
                },
            )
            .optional()
            .map_err(|_| "Cannot inspect response content")?
            .ok_or_else(|| "Response content does not exist".into())
    }
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn chunk_aad(id: &str, index: u64, offset: u64, length: u64) -> String {
    format!("purr:response-content:v1|{id}|{index}|{offset}|{length}")
}
fn validate_id(id: &str) -> Result<(), String> {
    if id.starts_with("content-")
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        Ok(())
    } else {
        Err("Invalid response content identifier".into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        persistence::local_records::{LocalRecord, LocalStateStore},
        security::tests::MemoryRootKeyStore,
    };

    fn store(
        limits: ResponseLimits,
    ) -> (tempfile::TempDir, MemoryRootKeyStore, ResponseContentStore) {
        let directory = tempfile::tempdir().unwrap();
        let root = MemoryRootKeyStore::default();
        let store = ResponseContentStore::open_with_limits(
            &directory.path().join("state.db"),
            &root,
            limits,
        )
        .unwrap();
        (directory, root, store)
    }

    #[test]
    fn staging_chunks_finish_adopt_and_read_across_boundaries() {
        let limits = ResponseLimits {
            chunk_bytes: 4,
            max_window_bytes: 32,
            max_content_bytes: 64,
            max_retained_bytes: None,
            staging_ttl_seconds: 60,
        };
        let (_directory, _root, mut store) = store(limits);
        let reference = store
            .create_staging(ContentMetadata {
                media_type: Some("text/plain".into()),
                charset: Some("utf-8".into()),
            })
            .unwrap();
        store.append(&reference.id, b"0123456789\nnext").unwrap();
        assert!(store.inspect(&reference.id).is_err());
        let ready = store.finish(&reference.id).unwrap();
        assert_eq!(ready.byte_length, 15);
        let window = store
            .read_range(
                &reference.id,
                ByteRange {
                    offset: 3,
                    length: 8,
                },
                "text",
            )
            .unwrap();
        assert_eq!(window.content, "3456789\n");
        assert_eq!(
            store.read_lines(&reference.id, None, 1).unwrap().lines,
            ["0123456789"]
        );
        store.release(&reference.id).unwrap();
        assert!(store.inspect(&reference.id).is_err());
    }

    #[test]
    fn incomplete_and_expired_content_is_unreadable_and_cleaned() {
        let limits = ResponseLimits {
            chunk_bytes: 4,
            max_window_bytes: 32,
            max_content_bytes: 64,
            max_retained_bytes: None,
            staging_ttl_seconds: 0,
        };
        let (_directory, _root, mut store) = store(limits);
        let reference = store
            .create_staging(ContentMetadata {
                media_type: None,
                charset: None,
            })
            .unwrap();
        store.append(&reference.id, b"partial").unwrap();
        assert!(store.inspect(&reference.id).is_err());
        assert_eq!(store.cleanup_expired(i64::MAX).unwrap(), 1);
        assert!(store.finish(&reference.id).is_err());
    }

    #[test]
    fn quota_and_content_limits_fail_before_committing_more_chunks() {
        let limits = ResponseLimits {
            chunk_bytes: 4,
            max_window_bytes: 32,
            max_content_bytes: 8,
            max_retained_bytes: Some(10),
            staging_ttl_seconds: 60,
        };
        let (_directory, _root, mut store) = store(limits);
        let first = store
            .create_staging(ContentMetadata {
                media_type: None,
                charset: None,
            })
            .unwrap();
        store.append(&first.id, b"12345678").unwrap();
        assert!(store.append(&first.id, b"9").is_err());
        let second = store
            .create_staging(ContentMetadata {
                media_type: None,
                charset: None,
            })
            .unwrap();
        assert!(store.append(&second.id, b"abc").is_err());
        assert_eq!(store.finish(&first.id).unwrap().byte_length, 8);
    }

    #[test]
    fn ciphertext_tampering_reordering_and_missing_chunks_fail_closed() {
        let limits = ResponseLimits {
            chunk_bytes: 4,
            max_window_bytes: 32,
            max_content_bytes: 64,
            max_retained_bytes: None,
            staging_ttl_seconds: 60,
        };
        let (_directory, _root, mut store) = store(limits);
        let reference = store
            .create_staging(ContentMetadata {
                media_type: None,
                charset: None,
            })
            .unwrap();
        store.append(&reference.id, b"abcdefghijkl").unwrap();
        store.finish(&reference.id).unwrap();
        store.db.execute("UPDATE response_content_chunks SET ciphertext=zeroblob(length(ciphertext)) WHERE content_id=?1 AND chunk_index=0", [&reference.id]).unwrap();
        assert!(store
            .read_range(
                &reference.id,
                ByteRange {
                    offset: 0,
                    length: 4
                },
                "text"
            )
            .is_err());

        let reordered = store
            .create_staging(ContentMetadata {
                media_type: None,
                charset: None,
            })
            .unwrap();
        store.append(&reordered.id, b"abcdefghijkl").unwrap();
        store.finish(&reordered.id).unwrap();
        store.db.execute("UPDATE response_content_chunks SET plain_offset=99 WHERE content_id=?1 AND chunk_index=1", [&reordered.id]).unwrap();
        assert!(store
            .read_range(
                &reordered.id,
                ByteRange {
                    offset: 0,
                    length: 12
                },
                "text"
            )
            .is_err());

        let missing = store
            .create_staging(ContentMetadata {
                media_type: None,
                charset: None,
            })
            .unwrap();
        store.append(&missing.id, b"abcdefghijkl").unwrap();
        store.finish(&missing.id).unwrap();
        store
            .db
            .execute(
                "DELETE FROM response_content_chunks WHERE content_id=?1 AND chunk_index=1",
                [&missing.id],
            )
            .unwrap();
        assert!(store
            .read_range(
                &missing.id,
                ByteRange {
                    offset: 0,
                    length: 12
                },
                "text"
            )
            .is_err());
    }

    #[test]
    fn plaintext_never_appears_in_the_database_and_migration_is_idempotent() {
        let limits = ResponseLimits {
            chunk_bytes: 4,
            max_window_bytes: 32,
            max_content_bytes: 64,
            max_retained_bytes: None,
            staging_ttl_seconds: 60,
        };
        let (directory, root, mut store) = store(limits);
        let marker = b"purr-sensitive-response-marker";
        let reference = store
            .create_staging(ContentMetadata {
                media_type: None,
                charset: None,
            })
            .unwrap();
        store.append(&reference.id, marker).unwrap();
        store.finish(&reference.id).unwrap();
        drop(store);
        let database = std::fs::read(directory.path().join("state.db")).unwrap();
        assert!(!database
            .windows(marker.len())
            .any(|window| window == marker));
        let reopened = ResponseContentStore::open_with_limits(
            &directory.path().join("state.db"),
            &root,
            limits,
        )
        .unwrap();
        assert_eq!(
            reopened.inspect(&reference.id).unwrap().size,
            marker.len() as u64
        );
        assert_eq!(
            reopened
                .db
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            4
        );
    }

    #[test]
    fn persistence_adopts_content_atomically_and_execution_deletion_cascades() {
        let limits = ResponseLimits {
            chunk_bytes: 4,
            max_window_bytes: 32,
            max_content_bytes: 64,
            max_retained_bytes: None,
            staging_ttl_seconds: 60,
        };
        let (directory, root, mut content) = store(limits);
        let reference = content
            .create_staging(ContentMetadata {
                media_type: Some("application/json".into()),
                charset: Some("utf-8".into()),
            })
            .unwrap();
        content.append(&reference.id, b"{\"ok\":true}").unwrap();
        let reference = content.finish(&reference.id).unwrap();
        let workspace_reference = content
            .create_staging(ContentMetadata {
                media_type: None,
                charset: None,
            })
            .unwrap();
        content
            .append(&workspace_reference.id, b"workspace")
            .unwrap();
        let workspace_reference = content.finish(&workspace_reference.id).unwrap();
        drop(content);

        let mut local = LocalStateStore::open(&directory.path().join("state.db"), &root).unwrap();
        let record = LocalRecord {
            table: "request_executions".into(),
            id: "execution_1".into(),
            value: serde_json::json!({
                "documentId":"request",
                "response":{
                    "protocolVersion":2,
                    "response":{"status":200},
                    "content":reference,
                    "timeline":{"startedAtMs":1}
                }
            }),
        };
        local.write("workspace", &[record]).unwrap();
        local
            .write(
                "other_workspace",
                &[LocalRecord {
                    table: "request_executions".into(),
                    id: "execution_2".into(),
                    value: serde_json::json!({
                        "documentId":"request",
                        "response":{
                            "protocolVersion":2,
                            "response":{"status":200},
                            "content":workspace_reference,
                            "timeline":{"startedAtMs":2}
                        }
                    }),
                }],
            )
            .unwrap();
        assert_eq!(
            local
                .db
                .query_row(
                    "SELECT state FROM response_contents WHERE id=?1",
                    [&reference.id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "adopted"
        );

        local
            .write(
                "workspace",
                &[LocalRecord {
                    table: "request_executions".into(),
                    id: "execution_1".into(),
                    value: serde_json::Value::Null,
                }],
            )
            .unwrap();
        assert_eq!(
            local
                .db
                .query_row("SELECT COUNT(*) FROM response_contents", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
        local
            .register("other_workspace", &directory.path().join("other_workspace"))
            .unwrap();
        local.delete_workspace("other_workspace").unwrap();
        assert_eq!(
            local
                .db
                .query_row("SELECT COUNT(*) FROM response_contents", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn failed_execution_commit_rolls_back_content_adoption() {
        let limits = ResponseLimits {
            chunk_bytes: 4,
            max_window_bytes: 32,
            max_content_bytes: 64,
            max_retained_bytes: None,
            staging_ttl_seconds: 60,
        };
        let (directory, root, mut content) = store(limits);
        let reference = content
            .create_staging(ContentMetadata {
                media_type: None,
                charset: None,
            })
            .unwrap();
        content.append(&reference.id, b"body").unwrap();
        let reference = content.finish(&reference.id).unwrap();
        drop(content);
        let mut local = LocalStateStore::open(&directory.path().join("state.db"), &root).unwrap();
        let execution = LocalRecord {
            table: "request_executions".into(),
            id: "execution_1".into(),
            value: serde_json::json!({"documentId":"request","response":{"protocolVersion":2,"response":{"status":200},"content":reference,"timeline":{"startedAtMs":1}}}),
        };
        let invalid = LocalRecord {
            table: "invalid".into(),
            id: "bad".into(),
            value: serde_json::json!({}),
        };
        assert!(local.write("workspace", &[execution, invalid]).is_err());
        assert_eq!(
            local
                .db
                .query_row(
                    "SELECT state FROM response_contents WHERE id=?1",
                    [&reference.id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "ready"
        );
    }
}
