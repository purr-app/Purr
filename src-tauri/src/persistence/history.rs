use super::local_records::{LocalRecord, LocalStateStore};
use crate::persistence::response_bodies::delete_execution_content;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};
fn db(_: rusqlite::Error) -> String {
    "History database operation failed".into()
}

pub(super) fn summary(id: &str, value: &Value, pinned: bool) -> Value {
    if value["version"] == 1 && value["outcome"].is_string() {
        let mut result = json!({"id":id,"pinned":pinned});
        for key in [
            "documentId",
            "name",
            "kind",
            "method",
            "url",
            "startedAt",
            "durationMs",
            "outcome",
            "status",
            "size",
        ] {
            result[key] = value[key].clone();
        }
        return result;
    }
    let response = &value["response"];
    let request = response["timeline"]
        .get("displayRequest")
        .filter(|request| request.is_object())
        .or_else(|| {
            response
                .get("request")
                .filter(|request| request.is_object())
        })
        .unwrap_or(&response["timeline"]["request"]);
    json!({"id":id,"documentId":value["documentId"],"name":"","kind":"http","method":request["method"].as_str().unwrap_or("GET"),"url":request["url"].as_str().unwrap_or(""),"startedAt":response["timeline"]["startedAtMs"],"durationMs":response["durationMs"].as_f64().or_else(||response["response"]["durationMs"].as_f64()).unwrap_or(0.0),"outcome":"response","status":response["status"].as_i64().or_else(||response["response"]["status"].as_i64()),"size":response["size"].as_u64().or_else(||response["content"]["byteLength"].as_u64()).unwrap_or(0),"pinned":pinned})
}
fn valid_summary(value: &Value) -> bool {
    value.is_object()
        && value["id"].is_string()
        && value["documentId"].is_string()
        && value["startedAt"].is_i64()
        && value["method"].is_string()
        && value["url"].is_string()
}
impl LocalStateStore {
    // Pre-history-UI rows may predate the indexed execution metadata columns.
    pub(super) fn backfill_history_metadata(&self) -> Result<(), String> {
        let mut statement = self
            .db
            .prepare("SELECT workspace_id,id,payload FROM request_executions WHERE summary IS NULL")
            .map_err(db)?;
        let rows = statement
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                ))
            })
            .map_err(db)?;
        for row in rows {
            let (workspace, id, payload) = row.map_err(db)?;
            let plain = self
                .cipher()
                .decrypt(&payload, &format!("{workspace}/request_executions/{id}"))?;
            let Ok(value) = serde_json::from_slice::<Value>(&plain) else {
                continue;
            };
            let metadata = summary(&id, &value, false);
            if !valid_summary(&metadata) {
                continue;
            }
            let encrypted = self.cipher().encrypt(
                &serde_json::to_vec(&metadata).map_err(|_| "Invalid history metadata")?,
                &format!("{workspace}/history-summary/{id}"),
            )?;
            self.db.execute("UPDATE request_executions SET document_id=?3,started_at=?4,status=?5,summary=?6 WHERE workspace_id=?1 AND id=?2",params![workspace,id,metadata["documentId"].as_str(),metadata["startedAt"].as_i64(),metadata["status"].as_i64(),encrypted]).map_err(db)?;
        }
        Ok(())
    }
    pub fn request_history(&mut self, workspace: &str, action: Value) -> Result<Value, String> {
        let operation = action["operation"]
            .as_str()
            .ok_or("Invalid history operation")?;
        match operation {
            "append" => {
                let entry = &action["entry"];
                let id = entry["id"]
                    .as_str()
                    .filter(|id| !id.is_empty() && id.len() < 256)
                    .ok_or("Invalid history identifier")?;
                if entry["version"] != 1
                    || !entry["documentId"].is_string()
                    || !entry["startedAt"].is_i64()
                    || !matches!(
                        entry["outcome"].as_str(),
                        Some("response" | "error" | "cancelled")
                    )
                {
                    return Err("Invalid history entry".into());
                }
                let exists: bool = self.db.query_row("SELECT EXISTS(SELECT 1 FROM request_executions WHERE workspace_id=?1 AND id=?2)",params![workspace,id],|r|r.get(0)).map_err(db)?;
                if !exists {
                    self.write(
                        workspace,
                        &[LocalRecord {
                            table: "request_executions".into(),
                            id: id.into(),
                            value: entry.clone(),
                        }],
                    )?;
                }
                self.prune_history(workspace)?;
                Ok(Value::Null)
            }
            "existing" => {
                let ids = action["ids"]
                    .as_array()
                    .filter(|ids| ids.len() <= 1000)
                    .ok_or("Invalid history identifiers")?;
                if ids.iter().any(|id| {
                    id.as_str()
                        .is_none_or(|id| id.is_empty() || id.len() >= 256)
                }) {
                    return Err("Invalid history identifiers".into());
                }
                self.prune_history(workspace)?;
                let mut stmt = self.db.prepare("SELECT EXISTS(SELECT 1 FROM request_executions WHERE workspace_id=?1 AND id=?2)").map_err(db)?;
                let mut existing = Vec::new();
                for id in ids {
                    let exists: bool = stmt
                        .query_row(params![workspace, id.as_str()], |row| row.get(0))
                        .map_err(db)?;
                    if exists {
                        existing.push(id.clone());
                    }
                }
                Ok(json!(existing))
            }
            "list" => {
                self.prune_history(workspace)?;
                let query = &action["query"];
                let limit = query["limit"].as_u64().unwrap_or(50).clamp(1, 100) as usize;
                let before = query["cursor"]["startedAt"].as_i64().unwrap_or(i64::MAX);
                let before_id = query["cursor"]["id"].as_str().unwrap_or("");
                let search = query["search"].as_str().unwrap_or("").trim().to_lowercase();
                let mut stmt = self.db.prepare("SELECT id,summary,CASE WHEN summary IS NULL THEN payload ELSE NULL END,pinned FROM request_executions WHERE workspace_id=?1 AND (?2 IS NULL OR document_id=?2) AND (started_at<?3 OR (started_at=?3 AND id<?4)) ORDER BY started_at DESC,id DESC").map_err(db)?;
                let rows = stmt
                    .query_map(
                        params![workspace, query["documentId"].as_str(), before, before_id],
                        |r| {
                            Ok((
                                r.get::<_, String>(0)?,
                                r.get::<_, Option<Vec<u8>>>(1)?,
                                r.get::<_, Option<Vec<u8>>>(2)?,
                                r.get::<_, bool>(3)?,
                            ))
                        },
                    )
                    .map_err(db)?;
                let mut items = Vec::new();
                for row in rows {
                    let (id, metadata, payload, pinned) = row.map_err(db)?;
                    let mut item = if let Some(metadata) = metadata {
                        let plain = self
                            .cipher()
                            .decrypt(&metadata, &format!("{workspace}/history-summary/{id}"))?;
                        let Ok(metadata) = serde_json::from_slice::<Value>(&plain) else {
                            continue;
                        };
                        metadata
                    } else {
                        let plain = self.cipher().decrypt(
                            &payload.ok_or("Missing history payload")?,
                            &format!("{workspace}/request_executions/{id}"),
                        )?;
                        let Ok(value) = serde_json::from_slice::<Value>(&plain) else {
                            continue;
                        };
                        summary(&id, &value, pinned)
                    };
                    if !valid_summary(&item) {
                        continue;
                    }
                    item["pinned"] = json!(pinned);
                    if !search.is_empty()
                        && !["name", "url", "method", "status", "outcome"]
                            .iter()
                            .any(|key| {
                                let text = item[*key]
                                    .as_str()
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| item[*key].to_string());
                                text.to_lowercase().contains(&search)
                            })
                    {
                        continue;
                    }
                    items.push(item);
                    if items.len() > limit {
                        break;
                    }
                }
                let more = items.len() > limit;
                items.truncate(limit);
                let cursor = if more {
                    items
                        .last()
                        .map(|v| json!({"startedAt":v["startedAt"],"id":v["id"]}))
                        .unwrap_or(Value::Null)
                } else {
                    Value::Null
                };
                Ok(json!({"items":items,"cursor":cursor}))
            }
            "read" => {
                self.prune_history(workspace)?;
                let id = action["id"].as_str().ok_or("Missing history id")?;
                let row:Option<(Vec<u8>,bool)>=self.db.query_row("SELECT payload,pinned FROM request_executions WHERE workspace_id=?1 AND id=?2",params![workspace,id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(db)?;
                let Some((payload, pinned)) = row else {
                    return Ok(Value::Null);
                };
                let mut value: Value = serde_json::from_slice(
                    &self
                        .cipher()
                        .decrypt(&payload, &format!("{workspace}/request_executions/{id}"))?,
                )
                .map_err(|_| "Damaged history entry")?;
                self.restore_response_body(workspace, id, &mut value)?;
                let meta = summary(id, &value, pinned);
                for (key, item) in meta.as_object().unwrap() {
                    value[key] = item.clone();
                }
                value["version"] = json!(1);
                value["files"] = value.get("files").cloned().unwrap_or(json!({}));
                value["error"] = value.get("error").cloned().unwrap_or(json!(""));
                Ok(value)
            }
            "pin" => {
                self.db
                    .execute(
                        "UPDATE request_executions SET pinned=?3 WHERE workspace_id=?1 AND id=?2",
                        params![
                            workspace,
                            action["id"].as_str().ok_or("Missing history id")?,
                            action["pinned"].as_bool().ok_or("Invalid pin")?
                        ],
                    )
                    .map_err(db)?;
                Ok(Value::Null)
            }
            "remove" => {
                let filter = &action["filter"];
                let ids = {
                    let mut stmt=self.db.prepare("SELECT id FROM request_executions WHERE workspace_id=?1 AND (?2 IS NULL OR id=?2) AND (?3 IS NULL OR document_id=?3)").map_err(db)?;
                    let rows = stmt
                        .query_map(
                            params![
                                workspace,
                                filter["id"].as_str(),
                                filter["documentId"].as_str()
                            ],
                            |r| r.get::<_, String>(0),
                        )
                        .map_err(db)?;
                    rows.collect::<Result<Vec<_>, _>>().map_err(db)?
                };
                self.remove_history(workspace, &ids)?;
                Ok(Value::Null)
            }
            "settings" => {
                if !action["retentionDays"].is_null() {
                    let days = action["retentionDays"]
                        .as_u64()
                        .filter(|v| *v >= 1 && *v <= 36500)
                        .ok_or("Retention must be between 1 and 36500 days")?;
                    self.set_app(&format!("history-retention/{workspace}"), &days.to_string())?;
                }
                Ok(json!({"retentionDays":self.history_retention(workspace)?}))
            }
            "prune" => {
                self.prune_history(workspace)?;
                Ok(Value::Null)
            }
            "attachment" => {
                let id = action["id"].as_str().ok_or("Missing attachment")?;
                Ok(json!(self.read_attachment(workspace, id)?.bytes))
            }
            _ => Err("Unknown history operation".into()),
        }
    }
    fn history_retention(&self, workspace: &str) -> Result<i64, String> {
        let value: Option<String> = self
            .db
            .query_row(
                "SELECT value FROM app_state WHERE key=?1",
                [format!("history-retention/{workspace}")],
                |r| r.get(0),
            )
            .optional()
            .map_err(db)?;
        Ok(value.and_then(|v| v.parse().ok()).unwrap_or(30))
    }
    pub fn prune_history(&mut self, workspace: &str) -> Result<(), String> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "Invalid system clock")?
            .as_millis() as i64;
        let cutoff = now - self.history_retention(workspace)? * 86_400_000;
        let ids = {
            let mut stmt=self.db.prepare("SELECT id FROM request_executions WHERE workspace_id=?1 AND pinned=0 AND started_at<?2").map_err(db)?;
            let rows = stmt
                .query_map(params![workspace, cutoff], |r| r.get::<_, String>(0))
                .map_err(db)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(db)?
        };
        self.remove_history(workspace, &ids)
    }
    fn remove_history(&mut self, workspace: &str, ids: &[String]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let tx = self.db.transaction().map_err(db)?;
        for id in ids {
            let secret_prefix = format!("purr/{workspace}/history/{id}/");
            tx.execute(
                "DELETE FROM secret_values WHERE substr(reference,1,length(?1))=?1",
                [secret_prefix],
            )
            .map_err(db)?;
            delete_execution_content(&tx, workspace, id)?;
            tx.execute(
                "DELETE FROM response_bodies WHERE workspace_id=?1 AND execution_id=?2",
                params![workspace, id],
            )
            .map_err(db)?;
            tx.execute(
                "DELETE FROM request_executions WHERE workspace_id=?1 AND id=?2",
                params![workspace, id],
            )
            .map_err(db)?;
            tx.execute(
                "DELETE FROM history_attachment_links WHERE workspace_id=?1 AND execution_id=?2",
                params![workspace, id],
            )
            .map_err(db)?;
        }
        tx.execute("DELETE FROM history_attachments WHERE workspace_id=?1 AND NOT EXISTS(SELECT 1 FROM history_attachment_links l WHERE l.workspace_id=history_attachments.workspace_id AND l.attachment_id=history_attachments.id)",[workspace]).map_err(db)?;
        tx.commit().map_err(db)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::tests::MemoryRootKeyStore;
    use base64::{engine::general_purpose::STANDARD, Engine};

    fn now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }
    fn entry(id: &str, document: &str, started: i64) -> Value {
        json!({"version":1,"id":id,"documentId":document,"name":"Example","kind":"http","method":"POST","url":"http://localhost/upload","startedAt":started,"durationMs":12,"outcome":"error","status":null,"size":0,"pinned":false,"editor":{"url":"{{baseUrl}}/upload"},"response":null,"error":"Offline","files":{}})
    }
    fn run(store: &mut LocalStateStore, action: Value) -> Value {
        store.request_history("workspace", action).unwrap()
    }
    fn append(store: &mut LocalStateStore, value: Value) {
        run(store, json!({"operation":"append","entry":value}));
    }

    #[test]
    fn immutable_executions_workspace_scope_search_and_cursor() {
        let dir = tempfile::tempdir().unwrap();
        let mut store =
            LocalStateStore::open(&dir.path().join("state.db"), &MemoryRootKeyStore::default())
                .unwrap();
        let timestamp = now();
        append(&mut store, entry("a", "draft", timestamp));
        let mut replacement = entry("a", "draft", timestamp);
        replacement["error"] = json!("Changed");
        append(&mut store, replacement);
        let mut cancelled = entry("b", "other", timestamp);
        cancelled["outcome"] = json!("cancelled");
        append(&mut store, cancelled);
        assert_eq!(
            run(&mut store, json!({"operation":"read","id":"a"}))["error"],
            "Offline"
        );
        let page = run(&mut store, json!({"operation":"list","query":{"limit":1}}));
        assert_eq!(page["items"][0]["id"], "b");
        let next = run(
            &mut store,
            json!({"operation":"list","query":{"limit":1,"cursor":page["cursor"]}}),
        );
        assert_eq!(next["items"][0]["id"], "a");
        assert_eq!(next["cursor"], Value::Null);
        assert_eq!(
            run(
                &mut store,
                json!({"operation":"list","query":{"search":"OFFLINE"}})
            )["items"],
            json!([])
        ); // Error payload is not list metadata.
        assert_eq!(
            run(
                &mut store,
                json!({"operation":"list","query":{"search":"cancelled","limit":1}})
            )["items"][0]["id"],
            "b"
        );
        assert_eq!(
            run(
                &mut store,
                json!({"operation":"list","query":{"documentId":"draft"}})
            )["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .request_history("other", json!({"operation":"list","query":{}}))
                .unwrap()["items"],
            json!([])
        );
        // Lists decrypt metadata only, even if a full snapshot is unavailable.
        store
            .db
            .execute(
                "UPDATE request_executions SET payload=zeroblob(2000000)",
                [],
            )
            .unwrap();
        assert_eq!(
            run(&mut store, json!({"operation":"list","query":{}}))["items"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn retention_pin_and_manual_deletion_release_only_owned_data() {
        let dir = tempfile::tempdir().unwrap();
        let mut store =
            LocalStateStore::open(&dir.path().join("state.db"), &MemoryRootKeyStore::default())
                .unwrap();
        run(
            &mut store,
            json!({"operation":"settings","retentionDays":90}),
        );
        append(&mut store, entry("old", "draft", now() - 40 * 86_400_000));
        append(
            &mut store,
            entry("pinned", "draft", now() - 40 * 86_400_000),
        );
        run(
            &mut store,
            json!({"operation":"pin","id":"pinned","pinned":true}),
        );
        store
            .set_secret("purr/workspace/history/old/editor/auth/token", "secret")
            .unwrap();
        store
            .set_secret(
                "purr/workspace/history/pinned/editor/auth/token",
                "retained",
            )
            .unwrap();
        store
            .write(
                "workspace",
                &[LocalRecord {
                    table: "drafts".into(),
                    id: "draft".into(),
                    value: Value::Null,
                }],
            )
            .unwrap();
        assert_eq!(
            run(&mut store, json!({"operation":"list","query":{}}))["items"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        run(
            &mut store,
            json!({"operation":"settings","retentionDays":30}),
        );
        run(&mut store, json!({"operation":"prune"}));
        assert_eq!(
            run(&mut store, json!({"operation":"read","id":"old"})),
            Value::Null
        );
        assert!(store
            .get_secret("purr/workspace/history/old/editor/auth/token")
            .unwrap()
            .is_none());
        assert_eq!(
            run(&mut store, json!({"operation":"read","id":"pinned"}))["pinned"],
            true
        );
        run(
            &mut store,
            json!({"operation":"remove","filter":{"id":"pinned"}}),
        );
        assert!(store
            .get_secret("purr/workspace/history/pinned/editor/auth/token")
            .unwrap()
            .is_none());
    }

    #[test]
    fn retained_files_survive_draft_deletion_and_replay_without_byte_ipc() {
        let dir = tempfile::tempdir().unwrap();
        let mut store =
            LocalStateStore::open(&dir.path().join("state.db"), &MemoryRootKeyStore::default())
                .unwrap();
        let file = json!({"version":1,"name":"body.bin","type":"application/octet-stream","size":3,"lastModified":0,"base64":STANDARD.encode([1,2,3])});
        store
            .write(
                "workspace",
                &[LocalRecord {
                    table: "attachments".into(),
                    id: "file".into(),
                    value: file.clone(),
                }],
            )
            .unwrap();
        let mut execution = entry("file-execution", "draft", now());
        let mut metadata = file;
        metadata.as_object_mut().unwrap().remove("base64");
        metadata["native"] = json!(true);
        execution["files"] = json!({"file":metadata});
        append(&mut store, execution);
        store
            .write(
                "workspace",
                &[LocalRecord {
                    table: "attachments".into(),
                    id: "file".into(),
                    value: Value::Null,
                }],
            )
            .unwrap();
        assert_eq!(
            store.read_attachment("workspace", "file").unwrap().bytes,
            vec![1, 2, 3]
        );
        let snapshot = run(
            &mut store,
            json!({"operation":"read","id":"file-execution"}),
        );
        assert!(snapshot["files"]["file"]["base64"].is_null());
        store
            .write(
                "workspace",
                &[LocalRecord {
                    table: "attachments".into(),
                    id: "file".into(),
                    value: metadata,
                }],
            )
            .unwrap();
        run(&mut store, json!({"operation":"remove","filter":{}}));
        assert_eq!(
            store.read_attachment("workspace", "file").unwrap().bytes,
            vec![1, 2, 3]
        );
        let count: i64 = store
            .db
            .query_row("SELECT COUNT(*) FROM history_attachments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        store.delete_workspace("workspace").unwrap();
        assert!(store.read_attachment("workspace", "file").is_err());
    }

    #[test]
    fn legacy_history_backfill_and_inline_body_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        let keys = MemoryRootKeyStore::default();
        let mut store = LocalStateStore::open(&path, &keys).unwrap();
        let value = json!({"documentId":"saved","response":{"status":404,"durationMs":2,"size":4,"text":"test","bodyBase64":"dGVzdA==","timeline":{"startedAtMs":now(),"request":{"method":"GET","url":"https://example.test"}}}});
        store
            .write(
                "workspace",
                &[LocalRecord {
                    table: "request_executions".into(),
                    id: "legacy".into(),
                    value,
                }],
            )
            .unwrap();
        store
            .db
            .execute(
                "UPDATE request_executions SET summary=NULL,document_id=NULL,started_at=NULL",
                [],
            )
            .unwrap();
        drop(store);
        let mut store = LocalStateStore::open(&path, &keys).unwrap();
        let page = run(
            &mut store,
            json!({"operation":"list","query":{"documentId":"saved"}}),
        );
        assert_eq!(page["items"][0]["status"], 404);
        let read = run(&mut store, json!({"operation":"read","id":"legacy"}));
        assert_eq!(read["response"]["text"], "test");
        assert_eq!(read["method"], "GET");
    }
    #[test]
    fn expiration_releases_native_body_chunks_and_missing_attachment_rolls_back() {
        let dir = tempfile::tempdir().unwrap();
        let mut store =
            LocalStateStore::open(&dir.path().join("state.db"), &MemoryRootKeyStore::default())
                .unwrap();
        store.db.execute("INSERT INTO response_contents(id,state,byte_length,created_at) VALUES('content','ready',3,0)",[]).unwrap();
        store.db.execute("INSERT INTO response_content_chunks(content_id,chunk_index,plain_offset,plain_length,crypto_version,nonce,ciphertext) VALUES('content',0,0,3,1,X'00',X'00')",[]).unwrap();
        let mut value = entry("body", "draft", now());
        value["outcome"] = json!("response");
        value["response"] = json!({"protocolVersion":2,"content":{"id":"content","byteLength":3,"complete":true},"response":{"status":200}});
        append(&mut store, value);
        let owner: String = store
            .db
            .query_row(
                "SELECT execution_id FROM response_contents WHERE id='content'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(owner, "body");
        store
            .db
            .execute(
                "UPDATE request_executions SET started_at=0 WHERE id='body'",
                [],
            )
            .unwrap();
        run(&mut store, json!({"operation":"prune"}));
        let chunks: i64 = store
            .db
            .query_row("SELECT COUNT(*) FROM response_content_chunks", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(chunks, 0);
        let mut missing = entry("invalid", "draft", now());
        missing["files"] = json!({"missing":{"native":true}});
        assert!(store
            .request_history("workspace", json!({"operation":"append","entry":missing}))
            .is_err());
        assert_eq!(
            run(&mut store, json!({"operation":"read","id":"invalid"})),
            Value::Null
        );
    }
    #[test]
    fn existence_checks_skip_payloads_and_prune_expired_entries() {
        let dir = tempfile::tempdir().unwrap();
        let mut store =
            LocalStateStore::open(&dir.path().join("state.db"), &MemoryRootKeyStore::default())
                .unwrap();
        append(&mut store, entry("kept", "draft", now()));
        append(&mut store, entry("expired", "draft", now()));
        store
            .db
            .execute(
                "UPDATE request_executions SET payload=zeroblob(2000000)",
                [],
            )
            .unwrap();
        store
            .db
            .execute(
                "UPDATE request_executions SET started_at=0 WHERE id='expired'",
                [],
            )
            .unwrap();
        assert_eq!(
            run(
                &mut store,
                json!({"operation":"existing","ids":["kept","expired","missing"]})
            ),
            json!(["kept"])
        );
        assert_eq!(
            store
                .request_history("other", json!({"operation":"existing","ids":["kept"]}))
                .unwrap(),
            json!([])
        );
        assert!(store
            .request_history("workspace", json!({"operation":"existing","ids":[null]}))
            .is_err());
    }

    #[test]
    fn workspace_restores_last_response_after_later_error_or_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        let mut store =
            LocalStateStore::open(&dir.path().join("state.db"), &MemoryRootKeyStore::default())
                .unwrap();
        let timestamp = now();
        let mut success = entry("success", "draft", timestamp - 2);
        success["outcome"] = json!("response");
        success["status"] = json!(200);
        success["response"] = json!({"status":200,"text":"ok","bodyBase64":"b2s=","timeline":{"startedAtMs":timestamp-2}});
        append(&mut store, success);
        append(&mut store, entry("error", "draft", timestamp - 1));
        let mut cancelled = entry("cancel", "draft", timestamp);
        cancelled["outcome"] = json!("cancelled");
        append(&mut store, cancelled);
        let restored = store.read("workspace").unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].id, "success");
        assert_eq!(restored[0].value["response"]["text"], "ok");
        assert_eq!(
            run(&mut store, json!({"operation":"list","query":{}}))["items"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
    }
    #[test]
    fn legacy_summary_uses_masked_display_request_and_skips_malformed_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        let keys = MemoryRootKeyStore::default();
        let mut store = LocalStateStore::open(&path, &keys).unwrap();
        let value = json!({"documentId":"saved","response":{"status":200,"request":{"method":"GET","url":"https://example.test?token=secret"},"timeline":{"startedAtMs":now(),"displayRequest":{"method":"GET","url":"https://example.test?token=••••"}}}});
        store
            .write(
                "workspace",
                &[LocalRecord {
                    table: "request_executions".into(),
                    id: "masked".into(),
                    value,
                }],
            )
            .unwrap();
        for (id, plain) in [
            ("bad-json", b"{".as_slice()),
            ("bad-shape", b"[]".as_slice()),
        ] {
            let encrypted = store
                .cipher()
                .encrypt(plain, &format!("workspace/request_executions/{id}"))
                .unwrap();
            store.db.execute("INSERT INTO request_executions(workspace_id,id,payload,document_id,started_at,status) VALUES('workspace',?1,?2,'broken',?3,200)",params![id,encrypted,now()+1]).unwrap();
        }
        drop(store);
        let mut store = LocalStateStore::open(&path, &keys).unwrap();
        let page = run(&mut store, json!({"operation":"list","query":{"limit":1}}));
        assert_eq!(page["items"].as_array().unwrap().len(), 1);
        assert_eq!(page["items"][0]["url"], "https://example.test?token=••••");
        assert_eq!(
            run(
                &mut store,
                json!({"operation":"list","query":{"search":"secret"}})
            )["items"],
            json!([])
        );
        assert_eq!(store.read("workspace").unwrap().len(), 1);
        let retained: i64 = store
            .db
            .query_row("SELECT COUNT(*) FROM request_executions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(retained, 3);
    }
}
