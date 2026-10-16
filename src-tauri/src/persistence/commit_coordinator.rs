//! Crash-consistent filesystem commits. Unpublished v2 operations recover by
//! conditional rollback, never by silently publishing credentials after failure.
use super::{
    local_records::{LocalRecord, LocalStateStore, RecordProtection},
    project_files::{FileChange, FilesystemWorkspaceStore, ProjectFile},
    secret_commits::{record_operation, SecretBatch},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const MAX_PREPARED_COMMIT_BYTES: usize = 256 * 1024 * 1024;

fn validate_serialized_size(value: &impl Serialize) -> Result<(), String> {
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self
                .0
                .checked_add(bytes.len())
                .ok_or_else(|| std::io::Error::other("Commit size overflow"))?;
            if self.0 > MAX_PREPARED_COMMIT_BYTES {
                return Err(std::io::Error::other(
                    "Prepared commit exceeds the size limit",
                ));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(Counter(0), value)
        .map_err(|_| "Prepared commit exceeds the 256 MiB limit".into())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u32,
    directory: std::path::PathBuf,
    files: Vec<FileChange>,
    previous: BTreeMap<String, Option<ProjectFile>>,
    local: Vec<LocalRecord>,
    secrets: SecretBatch,
    request: Value,
}

fn db_error(_: rusqlite::Error) -> String {
    "Commit journal operation failed".into()
}

// The production hook is a no-op. Tests inject precise interruptions without
// touching platform storage, environment variables or real user credentials.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum CommitStep {
    BeforeJournal,
    AfterJournal,
    File(usize),
    BeforePublication,
    AfterPublication,
}

pub fn commit(
    local: &mut LocalStateStore,
    store: &FilesystemWorkspaceStore,
    workspace: &str,
    files: &[FileChange],
    records: &[LocalRecord],
    batch: &SecretBatch,
) -> Result<BTreeMap<String, Option<ProjectFile>>, String> {
    commit_with_hook(local, store, workspace, files, records, batch, |_| Ok(()))
}

fn receipt(request: &Value, result: &Value) -> Value {
    json!({"request":request,"result":result})
}

fn stage(local: &mut LocalStateStore, workspace: &str, journal: &Journal) -> Result<(), String> {
    let plain = serde_json::to_vec(journal).map_err(|_| "Invalid prepared commit")?;
    let protection = if journal.secrets.mutations.is_empty()
        && journal
            .local
            .iter()
            .all(|r| r.protection == RecordProtection::Plaintext)
    {
        RecordProtection::Plaintext
    } else {
        RecordProtection::Encrypted
    };
    let payload = protection.encode(&local.cipher, &plain, &format!("{workspace}/journal"))?;
    let tx = local
        .db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM secret_operations WHERE operation_id=?1)",
            [&journal.secrets.operation_id],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if exists {
        return Err("operation-conflict: Operation identifier was reserved concurrently".into());
    }
    tx.execute(
        "INSERT INTO pending_commits(workspace_id,payload,protection) VALUES(?1,?2,?3)",
        rusqlite::params![workspace, payload, protection.as_str()],
    )
    .map_err(db_error)?;
    record_operation(
        &tx,
        &local.cipher,
        &journal.secrets.operation_id,
        "prepared",
        &receipt(&journal.request, &Value::Null),
    )?;
    tx.commit().map_err(db_error)
}

fn finish_rollback(
    local: &mut LocalStateStore,
    workspace: &str,
    journal: &Journal,
) -> Result<(), String> {
    let tx = local.db.transaction().map_err(db_error)?;
    record_operation(
        &tx,
        &local.cipher,
        &journal.secrets.operation_id,
        "aborted",
        &receipt(&journal.request, &Value::Null),
    )?;
    tx.execute(
        "DELETE FROM pending_commits WHERE workspace_id=?1",
        [workspace],
    )
    .map_err(db_error)?;
    tx.commit().map_err(db_error)
}

fn rollback(
    local: &mut LocalStateStore,
    store: &FilesystemWorkspaceStore,
    workspace: &str,
    journal: &Journal,
) -> Result<(), String> {
    // Work backwards so a partially applied multi-file edit is restored safely.
    let restored = (|| {
        for change in journal.files.iter().rev() {
            let before = journal
                .previous
                .get(&change.path)
                .ok_or("Damaged commit preimage")?;
            let current = store.read(&change.path)?;
            let current_revision = current.as_ref().map(|file| file.revision.clone());
            if current_revision == before.as_ref().map(|file| file.revision.clone()) {
                continue;
            }
            if current_revision != FilesystemWorkspaceStore::desired_revision(change)? {
                return Err("External revision prevents safe commit rollback".to_string());
            }
            let restore = FileChange {
                path: change.path.clone(),
                content: before.as_ref().map(|file| file.content.clone()),
                expected_revision: current_revision,
            };
            store.apply(std::slice::from_ref(&restore))?;
        }
        Ok::<_, String>(())
    })();
    if restored.is_err() {
        record_operation(
            &local.db,
            &local.cipher,
            &journal.secrets.operation_id,
            "recovery-required",
            &receipt(&journal.request, &Value::Null),
        )
        .map_err(|_| "Commit recovery-required; cannot persist rollback conflict")?;
        return Err("Commit recovery-required; an external edit or filesystem failure prevents safe rollback. Active secrets were not changed.".into());
    }
    finish_rollback(local, workspace, journal)
        .map_err(|_| "Commit recovery-required; rollback receipt could not be confirmed".into())
}

pub(super) fn commit_with_hook(
    local: &mut LocalStateStore,
    store: &FilesystemWorkspaceStore,
    workspace: &str,
    files: &[FileChange],
    records: &[LocalRecord],
    batch: &SecretBatch,
    mut hook: impl FnMut(CommitStep) -> Result<(), String>,
) -> Result<BTreeMap<String, Option<ProjectFile>>, String> {
    batch.validate(Some(workspace))?;
    validate_serialized_size(&(files, records, batch))?;
    let request = json!({"protection":if batch.mutations.is_empty() && records.iter().all(|r|r.protection==RecordProtection::Plaintext){"plaintext"}else{"encrypted"},"workspace":workspace,"directory":store.directory,"files":files,"local":records,"secrets":batch});
    if let Some(result) = local.replay_result(batch, &request)? {
        return serde_json::from_value(result).map_err(|_| "Damaged commit result".into());
    }
    if local.pending()?.iter().any(|(id, _)| id == workspace) {
        return Err("Commit recovery-required; recover the pending operation before saving".into());
    }
    let prepared = (|| {
        let mut seen = BTreeSet::new();
        for change in files {
            if !seen.insert(&change.path) {
                return Err("Duplicate project resource change".into());
            }
        }
        store.preflight(files, false)?;
        local.prepare_local(workspace, records, batch)?;
        let previous: BTreeMap<_, _> = files
            .iter()
            .map(|change| Ok((change.path.clone(), store.read(&change.path)?)))
            .collect::<Result<_, String>>()?;
        // Recheck revisions after preparation so backups always match preflight.
        store.preflight(files, false)?;
        hook(CommitStep::BeforeJournal)?;
        let journal = Journal {
            version: 2,
            directory: store.directory.clone(),
            files: files.to_vec(),
            previous,
            local: records.to_vec(),
            secrets: batch.clone(),
            request: request.clone(),
        };
        validate_serialized_size(&journal)?;
        Ok(journal)
    })();
    let journal = match prepared {
        Ok(journal) => journal,
        Err(error) => {
            record_operation(
                &local.db,
                &local.cipher,
                &batch.operation_id,
                "aborted",
                &receipt(&request, &Value::Null),
            )?;
            return Err(error);
        }
    };
    stage(local, workspace, &journal)?;
    // A crash from this point leaves an encrypted rollback journal. A handled
    // failure rolls back now and returns aborted only after durable completion.
    let applied = (|| {
        hook(CommitStep::AfterJournal)?;
        record_operation(
            &local.db,
            &local.cipher,
            &batch.operation_id,
            "applying",
            &receipt(&request, &Value::Null),
        )?;
        for (index, change) in files.iter().enumerate() {
            store.apply(std::slice::from_ref(change))?;
            hook(CommitStep::File(index))?;
        }
        let result: BTreeMap<_, _> = files
            .iter()
            .map(|change| Ok((change.path.clone(), store.read(&change.path)?)))
            .collect::<Result<_, String>>()?;
        // Do not publish secrets if an external tool changed an applied file.
        for change in files {
            if result[&change.path]
                .as_ref()
                .map(|file| file.revision.clone())
                != FilesystemWorkspaceStore::desired_revision(change)?
            {
                return Err("Project changed before commit publication".into());
            }
        }
        hook(CommitStep::BeforePublication)?;
        local.publish_local(
            workspace,
            records,
            batch,
            &request,
            &json!(result),
            (workspace != "__global__" && !store.directory.as_os_str().is_empty())
                .then_some(store.directory.as_path()),
        )?;
        Ok(result)
    })();
    let result = match applied {
        Ok(result) => result,
        Err(error) => {
            // A COMMIT error can be ambiguous. Never undo a published result.
            if let Some((state, payload)) = local
                .operation(&batch.operation_id)
                .map_err(|_| "Commit recovery-required; cannot determine publication outcome")?
            {
                if state == "committed" {
                    return serde_json::from_value(payload["result"].clone())
                        .map_err(|_| "Damaged commit result".into());
                }
            }
            rollback(local, store, workspace, &journal)?;
            return Err(error);
        }
    };
    hook(CommitStep::AfterPublication)?;
    Ok(result)
}

pub fn recover(
    local: &mut LocalStateStore,
    store: &FilesystemWorkspaceStore,
    workspace: &str,
    pending: Value,
) -> Result<(), String> {
    if pending.get("version").is_none() {
        // v1 predates credential staging and retains its original replay rule.
        let files: Vec<FileChange> = serde_json::from_value(pending["files"].clone())
            .map_err(|_| "Damaged legacy pending commit")?;
        let records: Vec<LocalRecord> = serde_json::from_value(pending["local"].clone())
            .map_err(|_| "Damaged legacy pending commit")?;
        store.preflight(&files, true)?;
        store.apply(&files)?;
        return local.write(workspace, &records);
    }
    let journal: Journal = serde_json::from_value(pending).map_err(|_| "Damaged pending commit")?;
    if journal.version != 2 {
        return Err("Unsupported pending commit version".into());
    }
    journal.secrets.validate(Some(workspace))?;
    let original_store = FilesystemWorkspaceStore {
        directory: journal.directory.clone(),
    };
    rollback(local, &original_store, workspace, &journal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{persistence::secret_commits::SecretMutation, security::tests::MemoryRootKeyStore};

    const REF: &str = "purr/workspace/auth/password";
    const MARKER: &str = "synthetic-secret-commit-marker";

    struct Fixture {
        dir: tempfile::TempDir,
        keys: MemoryRootKeyStore,
        local: LocalStateStore,
        files: FilesystemWorkspaceStore,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let keys = MemoryRootKeyStore::default();
            let mut local = LocalStateStore::open(&dir.path().join("state.db"), &keys).unwrap();
            local.set_secret(REF, "old-password").unwrap();
            local
                .write(
                    "workspace",
                    &[LocalRecord {
                        protection: Default::default(),
                        table: "drafts".into(),
                        id: "draft".into(),
                        value: json!({"name":"old"}),
                    }],
                )
                .unwrap();
            let files = FilesystemWorkspaceStore {
                directory: dir.path().join("project"),
            };
            files
                .apply(&[
                    FileChange {
                        path: "purr.yaml".into(),
                        content: Some("name: old\n".into()),
                        expected_revision: None,
                    },
                    FileChange {
                        path: "documents/remove.yaml".into(),
                        content: Some("name: remove\n".into()),
                        expected_revision: None,
                    },
                ])
                .unwrap();
            Self {
                dir,
                keys,
                local,
                files,
            }
        }
        fn batch(&self) -> SecretBatch {
            SecretBatch {
                operation_id: "operation-test".into(),
                mutations: vec![SecretMutation {
                    scope: None,
                    reference: REF.into(),
                    expected_revision: 1,
                    value: Some(MARKER.into()),
                }],
            }
        }
        fn changes(&self) -> Vec<FileChange> {
            vec![
                FileChange {
                    path: "purr.yaml".into(),
                    content: Some("name: new\n".into()),
                    expected_revision: self.files.read("purr.yaml").unwrap().map(|f| f.revision),
                },
                FileChange {
                    path: "documents/new.yaml".into(),
                    content: Some("name: new request\n".into()),
                    expected_revision: None,
                },
                FileChange {
                    path: "documents/remove.yaml".into(),
                    content: None,
                    expected_revision: self
                        .files
                        .read("documents/remove.yaml")
                        .unwrap()
                        .map(|f| f.revision),
                },
            ]
        }
        fn records(&self) -> Vec<LocalRecord> {
            vec![LocalRecord {
                protection: Default::default(),
                table: "drafts".into(),
                id: "draft".into(),
                value: json!({"name":"new"}),
            }]
        }
        fn assert_old(&self) {
            assert_eq!(
                self.local.read_secret(REF).unwrap().value.as_deref(),
                Some("old-password")
            );
            assert_eq!(self.local.read_secret(REF).unwrap().revision, 1);
            assert_eq!(
                self.local.read("workspace").unwrap()[0].value["name"],
                "old"
            );
            assert_eq!(
                self.files.read("purr.yaml").unwrap().unwrap().content,
                "name: old\n"
            );
            assert!(self.files.read("documents/new.yaml").unwrap().is_none());
            assert!(self.files.read("documents/remove.yaml").unwrap().is_some());
        }
        fn reopen(&mut self) {
            self.local =
                LocalStateStore::open(&self.dir.path().join("state.db"), &self.keys).unwrap();
        }
        fn recover(&mut self) -> Result<(), String> {
            for (id, pending) in self.local.pending()? {
                recover(&mut self.local, &self.files, &id, pending)?;
            }
            Ok(())
        }
    }

    #[test]
    fn every_handled_failpoint_preserves_old_files_local_state_and_credentials() {
        for point in [
            CommitStep::BeforeJournal,
            CommitStep::AfterJournal,
            CommitStep::File(0),
            CommitStep::File(1),
            CommitStep::File(2),
            CommitStep::BeforePublication,
        ] {
            let mut f = Fixture::new();
            let batch = f.batch();
            let changes = f.changes();
            let records = f.records();
            assert!(commit_with_hook(
                &mut f.local,
                &f.files,
                "workspace",
                &changes,
                &records,
                &batch,
                |step| if step == point {
                    Err("Injected failure".into())
                } else {
                    Ok(())
                }
            )
            .is_err());
            f.assert_old();
            assert_eq!(
                f.local
                    .operation_status(&batch.operation_id)
                    .unwrap()
                    .status,
                "aborted"
            );
            assert!(!f.local.has_pending_commit().unwrap());
            f.reopen();
            f.recover().unwrap();
            f.assert_old();
        }
    }

    #[test]
    fn process_interruption_recovers_by_rollback_and_journal_never_stores_plaintext() {
        for point in [
            CommitStep::AfterJournal,
            CommitStep::File(0),
            CommitStep::File(1),
            CommitStep::File(2),
            CommitStep::BeforePublication,
        ] {
            let mut f = Fixture::new();
            let batch = f.batch();
            let changes = f.changes();
            let records = f.records();
            let interrupted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = commit_with_hook(
                    &mut f.local,
                    &f.files,
                    "workspace",
                    &changes,
                    &records,
                    &batch,
                    |step| {
                        if step == point {
                            panic!("synthetic process interruption")
                        };
                        Ok(())
                    },
                );
            }));
            assert!(interrupted.is_err());
            assert_eq!(
                f.local
                    .operation_status(&batch.operation_id)
                    .unwrap()
                    .status,
                "recovery-required"
            );
            for suffix in ["state.db", "state.db-wal"] {
                if let Ok(bytes) = std::fs::read(f.dir.path().join(suffix)) {
                    assert!(!bytes
                        .windows(MARKER.len())
                        .any(|bytes| bytes == MARKER.as_bytes()));
                }
            }
            f.reopen();
            f.recover().unwrap();
            f.assert_old();
            assert_eq!(
                f.local
                    .operation_status(&batch.operation_id)
                    .unwrap()
                    .status,
                "aborted"
            );
            f.recover().unwrap();
            f.assert_old();
        }
    }

    #[test]
    fn external_edits_are_never_overwritten_to_force_rollback() {
        let mut f = Fixture::new();
        let batch = f.batch();
        let changes = f.changes();
        let records = f.records();
        let path = f.files.directory.join("purr.yaml");
        let error = commit_with_hook(
            &mut f.local,
            &f.files,
            "workspace",
            &changes,
            &records,
            &batch,
            |step| {
                if step == CommitStep::File(0) {
                    std::fs::write(&path, "name: external\n").unwrap();
                    return Err("Injected failure".into());
                }
                Ok(())
            },
        )
        .err()
        .unwrap();
        assert!(error.contains("recovery-required"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "name: external\n");
        assert_eq!(
            f.local.get_secret(REF).unwrap().as_deref(),
            Some("old-password")
        );
        f.reopen();
        assert!(f.recover().is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "name: external\n");
        assert_eq!(
            f.local
                .operation_status(&batch.operation_id)
                .unwrap()
                .status,
            "recovery-required"
        );
        // Explicitly restoring the baseline allows deterministic completion.
        std::fs::write(&path, "name: old\n").unwrap();
        f.recover().unwrap();
        f.assert_old();
    }

    #[test]
    fn lost_ack_replays_receipt_without_reapplying_or_overwriting_newer_secrets() {
        let mut f = Fixture::new();
        let batch = f.batch();
        let changes = f.changes();
        let records = f.records();
        assert!(commit_with_hook(
            &mut f.local,
            &f.files,
            "workspace",
            &changes,
            &records,
            &batch,
            |step| if step == CommitStep::AfterPublication {
                Err("Acknowledgement lost".into())
            } else {
                Ok(())
            }
        )
        .is_err());
        assert_eq!(
            f.local
                .operation_status(&batch.operation_id)
                .unwrap()
                .status,
            "committed"
        );
        assert_eq!(f.local.read_secret(REF).unwrap().revision, 2);
        assert!(!f.local.has_pending_commit().unwrap());
        f.local.set_secret(REF, "newer-runtime-value").unwrap();
        f.reopen();
        f.recover().unwrap();
        let result = commit(
            &mut f.local,
            &f.files,
            "workspace",
            &changes,
            &records,
            &batch,
        )
        .unwrap();
        assert_eq!(result["purr.yaml"].as_ref().unwrap().content, "name: new\n");
        assert_eq!(f.local.read_secret(REF).unwrap().revision, 3);
        assert_eq!(
            f.local.get_secret(REF).unwrap().as_deref(),
            Some("newer-runtime-value")
        );
        assert!(commit(&mut f.local, &f.files, "workspace", &[], &records, &batch).is_err());
        let receipt = f.local.operation(&batch.operation_id).unwrap().unwrap().1;
        assert!(!receipt.to_string().contains(MARKER));
    }

    #[test]
    fn invalid_local_preflight_and_assets_abort_before_any_files_or_secrets_change() {
        for invalid in 0..3 {
            let mut f = Fixture::new();
            let batch = f.batch();
            let mut changes = f.changes();
            let mut records = f.records();
            match invalid {
                0 => records.push(LocalRecord {
                    protection: Default::default(),
                    table: "invalid".into(),
                    id: "bad".into(),
                    value: json!(true),
                }),
                1 => changes[0].expected_revision = Some("outdated".into()),
                _ => changes.push(FileChange {
                    path: "assets/bad.bin".into(),
                    content: Some("invalid-base64!".into()),
                    expected_revision: None,
                }),
            }
            assert!(commit(
                &mut f.local,
                &f.files,
                "workspace",
                &changes,
                &records,
                &batch
            )
            .is_err());
            f.assert_old();
            assert!(!f.local.has_pending_commit().unwrap());
        }
    }

    #[test]
    fn sqlite_publication_failure_rolls_back_local_and_vault_and_restores_files() {
        let mut f = Fixture::new();
        let batch = f.batch();
        let changes = f.changes();
        let records = f.records();
        let other = rusqlite::Connection::open(f.dir.path().join("state.db")).unwrap();
        assert!(commit_with_hook(&mut f.local,&f.files,"workspace",&changes,&records,&batch,|step| {
            if step==CommitStep::BeforePublication {
                other.execute_batch("CREATE TRIGGER fail_publish BEFORE UPDATE ON secret_values BEGIN SELECT RAISE(ABORT,'synthetic publication failure'); END;").unwrap();
            } Ok(())
        }).is_err());
        f.assert_old();
        assert_eq!(
            f.local
                .operation_status(&batch.operation_id)
                .unwrap()
                .status,
            "aborted"
        );
    }

    #[test]
    fn secret_only_global_and_noop_commits_have_atomic_receipts() {
        let mut f = Fixture::new();
        let batch = f.batch();
        commit(&mut f.local, &f.files, "workspace", &[], &[], &batch).unwrap();
        assert_eq!(f.local.read_secret(REF).unwrap().revision, 2);
        let empty = SecretBatch::fresh(vec![]).unwrap();
        commit(&mut f.local, &f.files, "workspace", &[], &[], &empty).unwrap();
        assert_eq!(
            f.local
                .operation_status(&empty.operation_id)
                .unwrap()
                .status,
            "committed"
        );
        let globals = SecretBatch::fresh(vec![SecretMutation {
            scope: None,
            reference: "purr/global/variables/id".into(),
            expected_revision: 0,
            value: Some("global-marker".into()),
        }])
        .unwrap();
        let store = FilesystemWorkspaceStore {
            directory: std::path::PathBuf::new(),
        };
        commit(&mut f.local, &store, "__global__", &[], &[], &globals).unwrap();
        assert_eq!(
            f.local
                .read_secret("purr/global/variables/id")
                .unwrap()
                .revision,
            1
        );
    }

    #[test]
    fn legacy_v1_pending_commit_still_replays() {
        let mut f = Fixture::new();
        let changes = f.changes();
        let records = f.records();
        f.local
            .journal("workspace", &json!({"files":changes,"local":records}))
            .unwrap();
        f.files.apply(&changes[..1]).unwrap();
        f.reopen();
        f.recover().unwrap();
        assert_eq!(
            f.files.read("purr.yaml").unwrap().unwrap().content,
            "name: new\n"
        );
        assert_eq!(
            f.local.get_secret(REF).unwrap().as_deref(),
            Some("old-password")
        );
    }
}
