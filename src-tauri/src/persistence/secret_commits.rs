//! CAS-protected credential mutations and encrypted, idempotent operation receipts.
use super::local_records::{LocalRecord, LocalStateStore};
use crate::security::{scoped::ProtectionScope, validate_secret_ref, LocalCipher};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const MAX_REVISION: i64 = 9_007_199_254_740_991;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretMutation {
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(default)]
    pub scope: Option<ProtectionScope>,
    pub expected_revision: i64,
    pub value: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretBatch {
    pub operation_id: String,
    pub mutations: Vec<SecretMutation>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretSnapshot {
    pub value: Option<String>,
    pub revision: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationStatus {
    pub operation_id: String,
    pub status: String,
}

fn db_error(_: rusqlite::Error) -> String {
    "Secret commit database operation failed".into()
}

pub fn validate_operation_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 160
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err("Invalid secret operation identifier".into());
    }
    Ok(())
}

impl SecretBatch {
    pub fn fresh(mutations: Vec<SecretMutation>) -> Result<Self, String> {
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| "Cannot generate secret operation identifier")?;
        Ok(Self {
            operation_id: format!(
                "commit-{}",
                random
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            ),
            mutations,
        })
    }
    pub fn validate(&self, workspace: Option<&str>) -> Result<(), String> {
        validate_operation_id(&self.operation_id)?;
        if self.mutations.len() > 10_000 {
            return Err("Too many secret mutations".into());
        }
        let prefix =
            workspace.map(|id| format!("purr/{}/", if id == "__global__" { "global" } else { id }));
        let mut seen = BTreeSet::new();
        for mutation in &self.mutations {
            validate_secret_ref(&mutation.reference)?;
            if let Some(scope) = &mutation.scope {
                if *scope != ProtectionScope::from_secret_ref(&mutation.reference)? {
                    return Err("Secret scope does not match its reference".into());
                }
            }
            if prefix
                .as_ref()
                .is_some_and(|prefix| !mutation.reference.starts_with(prefix))
            {
                return Err("Secret mutation is outside the commit scope".into());
            }
            if !seen.insert(&mutation.reference)
                || !(0..MAX_REVISION).contains(&mutation.expected_revision)
            {
                return Err("Invalid or duplicate secret mutation".into());
            }
            if mutation
                .value
                .as_ref()
                .is_some_and(|value| value.len() > 16 * 1024 * 1024)
            {
                return Err("Secret value exceeds the commit limit".into());
            }
        }
        Ok(())
    }
}

pub(super) fn revision(db: &Connection, reference: &str) -> Result<i64, String> {
    Ok(db
        .query_row(
            "SELECT revision FROM secret_revisions WHERE reference=?1",
            [reference],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?
        .unwrap_or(0))
}

pub(super) fn apply_mutations(
    tx: &Transaction<'_>,
    cipher: &LocalCipher,
    batch: &SecretBatch,
) -> Result<(), String> {
    batch.validate(None)?;
    // Prepare every required cipher before publishing even the first row.
    let mut prepared = Vec::with_capacity(batch.mutations.len());
    for mutation in &batch.mutations {
        let selected = if cipher.is_scoped() {
            let scope = mutation
                .scope
                .clone()
                .ok_or("Secret protection scope is required")?;
            if scope != ProtectionScope::from_secret_ref(&mutation.reference)? {
                return Err("Secret scope does not match its reference".into());
            }
            cipher.for_scope(scope)?
        } else {
            cipher.clone()
        };
        prepared.push(selected);
        if revision(tx, &mutation.reference)? != mutation.expected_revision {
            return Err("Secret changed since preparation; reload before saving".into());
        }
    }
    for (mutation, selected) in batch.mutations.iter().zip(prepared) {
        if let Some(value) = &mutation.value {
            let sealed = selected.seal(
                value.as_bytes(),
                &format!("purr:secret:v1|{}", mutation.reference),
            )?;
            tx.execute("INSERT INTO secret_values(reference,ciphertext,nonce,crypto_version) VALUES(?1,?2,?3,?4) ON CONFLICT(reference) DO UPDATE SET ciphertext=excluded.ciphertext,nonce=excluded.nonce,crypto_version=excluded.crypto_version,updated_at=CURRENT_TIMESTAMP", params![mutation.reference,sealed.ciphertext,sealed.nonce.as_slice(),sealed.version]).map_err(db_error)?;
        } else {
            let count = tx
                .execute(
                    "DELETE FROM secret_values WHERE reference=?1",
                    [&mutation.reference],
                )
                .map_err(db_error)?;
            // Deletion of an already absent value also consumes a revision.
            if count == 0 {
                tx.execute("INSERT INTO secret_revisions(reference,revision) VALUES(?1,1) ON CONFLICT(reference) DO UPDATE SET revision=revision+1", [&mutation.reference]).map_err(db_error)?;
            }
        }
    }
    Ok(())
}

fn fingerprint(request: &Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(request).map_err(|_| "Invalid operation request")?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

pub(super) fn record_operation(
    db: &Connection,
    cipher: &LocalCipher,
    id: &str,
    state: &str,
    payload: &Value,
) -> Result<(), String> {
    // Terminal receipts retain only an encrypted fingerprint and result, never
    // old secret values. The separate pending journal owns replay material.
    let payload =
        json!({"requestFingerprint":fingerprint(&payload["request"])?,"result":payload["result"]});
    let payload = cipher.encrypt(
        &serde_json::to_vec(&payload).map_err(|_| "Invalid operation receipt")?,
        &format!("purr:operation:v1|{id}"),
    )?;
    db.execute("INSERT INTO secret_operations(operation_id,state,payload) VALUES(?1,?2,?3) ON CONFLICT(operation_id) DO UPDATE SET state=excluded.state,payload=excluded.payload WHERE secret_operations.state NOT IN ('committed','aborted')", params![id,state,payload]).map_err(db_error)?;
    Ok(())
}

impl LocalStateStore {
    pub fn has_pending_commit(&self) -> Result<bool, String> {
        self.db
            .query_row("SELECT EXISTS(SELECT 1 FROM pending_commits)", [], |row| {
                row.get(0)
            })
            .map_err(db_error)
    }
    pub fn read_secret(&self, reference: &str) -> Result<SecretSnapshot, String> {
        self.read_secret_typed(reference)
            .map_err(|error| error.to_string())
    }
    pub fn read_secret_typed(
        &self,
        reference: &str,
    ) -> Result<SecretSnapshot, crate::security::ProtectedError> {
        use crate::security::ProtectedError;
        validate_secret_ref(reference)
            .map_err(|_| ProtectedError::denied("invalid-secret-reference"))?;
        let tx = self
            .db
            .unchecked_transaction()
            .map_err(|_| ProtectedError::unavailable("secret-database-unavailable"))?;
        let result = SecretSnapshot {
            value: self.get_secret_typed(reference)?,
            revision: revision(&self.db, reference)?,
        };
        tx.rollback()
            .map_err(|_| ProtectedError::unavailable("secret-database-unavailable"))?;
        Ok(result)
    }

    pub fn operation(&self, id: &str) -> Result<Option<(String, Value)>, String> {
        validate_operation_id(id)?;
        let row: Option<(String, Vec<u8>)> = self
            .db
            .query_row(
                "SELECT state,payload FROM secret_operations WHERE operation_id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db_error)?;
        row.map(|(state, payload)| {
            let plain = self
                .cipher
                .decrypt(&payload, &format!("purr:operation:v1|{id}"))?;
            Ok((
                state,
                serde_json::from_slice(&plain).map_err(|_| "Damaged operation receipt")?,
            ))
        })
        .transpose()
    }

    pub fn operation_status(&self, id: &str) -> Result<OperationStatus, String> {
        let status = match self.operation(id)? {
            None => "missing".to_string(),
            Some((state, _)) if state == "committed" || state == "aborted" => state,
            Some(_) => "recovery-required".to_string(),
        };
        Ok(OperationStatus {
            operation_id: id.into(),
            status,
        })
    }

    pub(super) fn replay_result(
        &self,
        batch: &SecretBatch,
        request: &Value,
    ) -> Result<Option<Value>, String> {
        let Some((state, payload)) = self.operation(&batch.operation_id)? else {
            return Ok(None);
        };
        if payload["requestFingerprint"].as_str() != Some(fingerprint(request)?.as_str()) {
            return Err(
                "operation-conflict: Operation identifier was reused for a different commit".into(),
            );
        }
        match state.as_str() {
            "committed" => Ok(Some(payload["result"].clone())),
            "aborted" => Err("Commit aborted; prepare a new operation before retrying".into()),
            _ => Err("Commit recovery-required; reconcile the operation before saving".into()),
        }
    }

    pub(super) fn prepare_local(
        &mut self,
        workspace: &str,
        records: &[LocalRecord],
        batch: &SecretBatch,
    ) -> Result<(), String> {
        batch.validate(Some(workspace))?;
        let tx = self.db.transaction().map_err(db_error)?;
        Self::write_records(&tx, &self.cipher, workspace, records)?;
        apply_mutations(&tx, &self.secret_cipher, batch)?;
        tx.rollback().map_err(db_error)
    }

    pub(super) fn publish_local(
        &mut self,
        workspace: &str,
        records: &[LocalRecord],
        batch: &SecretBatch,
        request: &Value,
        result: &Value,
        directory: Option<&std::path::Path>,
    ) -> Result<(), String> {
        batch.validate(Some(workspace))?;
        let tx = self.db.transaction().map_err(db_error)?;
        Self::write_records(&tx, &self.cipher, workspace, records)?;
        apply_mutations(&tx, &self.secret_cipher, batch)?;
        if let Some(directory) = directory {
            tx.execute("INSERT INTO workspaces(id,directory) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET directory=excluded.directory", params![workspace,directory.to_string_lossy()]).map_err(db_error)?;
        }
        record_operation(
            &tx,
            &self.cipher,
            &batch.operation_id,
            "committed",
            &json!({"request":request,"result":result}),
        )?;
        tx.execute(
            "DELETE FROM pending_commits WHERE workspace_id=?1",
            [workspace],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)
    }

    pub fn commit_secrets(&self, batch: &SecretBatch) -> Result<(), String> {
        batch.validate(None)?;
        let request = json!({"kind":"secrets","batch":batch});
        if self.replay_result(batch, &request)?.is_some() {
            return Ok(());
        }
        let tx = Transaction::new_unchecked(&self.db, rusqlite::TransactionBehavior::Immediate)
            .map_err(db_error)?;
        if self.replay_result(batch, &request)?.is_some() {
            return Ok(());
        }
        if let Err(error) = apply_mutations(&tx, &self.secret_cipher, batch) {
            tx.rollback().map_err(db_error)?;
            record_operation(
                &self.db,
                &self.cipher,
                &batch.operation_id,
                "aborted",
                &json!({"request":request,"result":null}),
            )?;
            return Err(error);
        }
        record_operation(
            &tx,
            &self.cipher,
            &batch.operation_id,
            "committed",
            &json!({"request":request,"result":null}),
        )?;
        match tx.commit() {
            Ok(()) => Ok(()),
            Err(error) => match self.operation(&batch.operation_id) {
                Ok(Some((state, _))) if state == "committed" => Ok(()),
                Ok(_) => Err(db_error(error)),
                Err(_) => Err(
                    "Commit recovery-required; cannot determine secret publication outcome".into(),
                ),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::tests::MemoryRootKeyStore;

    fn batch(id: &str, reference: &str, revision: i64, value: Option<&str>) -> SecretBatch {
        SecretBatch {
            operation_id: id.into(),
            mutations: vec![SecretMutation {
                scope: None,
                reference: reference.into(),
                expected_revision: revision,
                value: value.map(str::to_owned),
            }],
        }
    }

    #[test]
    fn tombstones_cas_empty_values_and_replay_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let key = MemoryRootKeyStore::default();
        let path = dir.path().join("state.db");
        let store = LocalStateStore::open(&path, &key).unwrap();
        let reference = "purr/workspace/auth/token";
        assert_eq!(store.read_secret(reference).unwrap().revision, 0);
        let create = batch("create", reference, 0, Some("synthetic-value"));
        store.commit_secrets(&create).unwrap();
        store.commit_secrets(&create).unwrap();
        assert_eq!(store.read_secret(reference).unwrap().revision, 1);
        let delete = batch("delete", reference, 1, None);
        store.commit_secrets(&delete).unwrap();
        assert_eq!(store.read_secret(reference).unwrap().revision, 2);
        assert!(store.read_secret(reference).unwrap().value.is_none());
        assert!(store
            .commit_secrets(&batch("stale", reference, 0, Some("bad")))
            .is_err());
        store
            .commit_secrets(&batch("empty", reference, 2, Some("")))
            .unwrap();
        assert_eq!(
            store.read_secret(reference).unwrap().value.as_deref(),
            Some("")
        );
        store
            .commit_secrets(&batch("delete-again", reference, 3, None))
            .unwrap();
        store
            .commit_secrets(&batch("delete-absent", reference, 4, None))
            .unwrap();
        drop(store);
        let store = LocalStateStore::open(&path, &key).unwrap();
        assert_eq!(store.read_secret(reference).unwrap().revision, 5);
        assert_eq!(
            store.operation_status("create").unwrap().status,
            "committed"
        );
        assert_eq!(store.operation_status("stale").unwrap().status, "aborted");
        assert_eq!(store.operation_status("unknown").unwrap().status, "missing");
        assert!(store
            .commit_secrets(&batch("create", reference, 0, Some("different")))
            .is_err());
        let (_, receipt) = store.operation("create").unwrap().unwrap();
        assert!(!receipt.to_string().contains("synthetic-value"));
        assert!(receipt.get("request").is_none());
    }

    #[test]
    fn batch_conflicts_are_atomic_and_scope_and_internal_refs_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let key = MemoryRootKeyStore::default();
        let store = LocalStateStore::open(&dir.path().join("state.db"), &key).unwrap();
        let mut changes = batch("atomic", "purr/workspace/auth/first", 0, Some("first"));
        changes.mutations.push(SecretMutation {
            scope: None,
            reference: "purr/workspace/auth/second".into(),
            expected_revision: 8,
            value: Some("second".into()),
        });
        assert!(store.commit_secrets(&changes).is_err());
        assert!(store
            .get_secret("purr/workspace/auth/first")
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .read_secret("purr/workspace/auth/first")
                .unwrap()
                .revision,
            0
        );
        assert!(batch("scope", "purr/other/auth/token", 0, None)
            .validate(Some("workspace"))
            .is_err());
        assert!(batch("root", crate::security::ROOT_KEY_REF, 0, None)
            .validate(None)
            .is_err());
        assert!(batch("global", "purr/global/variables/id", 0, None)
            .validate(Some("__global__"))
            .is_ok());
    }

    #[test]
    fn legacy_workspace_and_history_deletions_advance_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let key = MemoryRootKeyStore::default();
        let mut store = LocalStateStore::open(&dir.path().join("state.db"), &key).unwrap();
        let reference = "purr/workspace/auth/token";
        store.set_secret(reference, "value").unwrap();
        store.delete_workspace("workspace").unwrap();
        assert_eq!(store.read_secret(reference).unwrap().revision, 2);
        assert!(store
            .commit_secrets(&batch("stale-create", reference, 0, Some("resurrect")))
            .is_err());
    }

    #[test]
    fn v5_vault_gets_initial_revisions_without_reencrypting_values() {
        let dir = tempfile::tempdir().unwrap();
        let key = MemoryRootKeyStore::default();
        let path = dir.path().join("state.db");
        let store = LocalStateStore::open(&path, &key).unwrap();
        store
            .set_secret("purr/workspace/auth/token", "legacy")
            .unwrap();
        store.db.execute_batch("DROP TRIGGER secret_insert_revision; DROP TRIGGER secret_update_revision; DROP TRIGGER secret_delete_revision; DROP TABLE secret_revisions; DROP TABLE secret_operations; DROP TABLE workspace_cleanup; DELETE FROM migrations WHERE version=6; PRAGMA user_version=5;").unwrap();
        drop(store);
        let store = LocalStateStore::open(&path, &key).unwrap();
        let snapshot = store.read_secret("purr/workspace/auth/token").unwrap();
        assert_eq!(snapshot.revision, 1);
        assert_eq!(snapshot.value.as_deref(), Some("legacy"));
    }
}
