//! Workspace deletion publishes in SQLite first. Filesystem cleanup is a
//! separate encrypted, durable job and can never turn that commit into failure.
use super::{local_records::LocalStateStore, secret_commits::SecretBatch};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

impl LocalStateStore {
    pub fn cleanup_intent(&self, workspace: &str) -> Result<Option<Value>, String> {
        let payload: Option<Vec<u8>> = self
            .db
            .query_row(
                "SELECT payload FROM workspace_cleanup WHERE workspace_id=?1",
                [workspace],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "Cannot inspect workspace cleanup")?;
        payload
            .map(|payload| {
                let bytes = self
                    .cipher
                    .decrypt(&payload, &format!("purr:workspace-cleanup:v1|{workspace}"))?;
                serde_json::from_slice(&bytes)
                    .map_err(|_| "Damaged workspace cleanup intent".into())
            })
            .transpose()
    }
    pub fn cleanup_workspaces(&self) -> Result<Vec<String>, String> {
        let mut statement = self
            .db
            .prepare("SELECT workspace_id FROM workspace_cleanup ORDER BY workspace_id")
            .map_err(|_| "Cannot inspect workspace cleanup")?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(|_| "Cannot inspect workspace cleanup")?;
        rows.collect::<Result<Vec<String>, _>>()
            .map_err(|_| "Cannot inspect workspace cleanup".into())
    }
    pub fn store_cleanup_intent(&self, workspace: &str, intent: &Value) -> Result<(), String> {
        let payload = self.cipher.encrypt(
            &serde_json::to_vec(intent).map_err(|_| "Invalid cleanup intent")?,
            &format!("purr:workspace-cleanup:v1|{workspace}"),
        )?;
        self.db
            .execute(
                "UPDATE workspace_cleanup SET payload=?2 WHERE workspace_id=?1",
                rusqlite::params![workspace, payload],
            )
            .map_err(|_| "Cannot persist workspace cleanup")?;
        Ok(())
    }
    pub fn finish_cleanup(&self, workspace: &str) -> Result<(), String> {
        self.db
            .execute(
                "DELETE FROM workspace_cleanup WHERE workspace_id=?1",
                [workspace],
            )
            .map_err(|_| "Cannot finish workspace cleanup")?;
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
struct CleanupIntent {
    source: PathBuf,
    quarantine: PathBuf,
    entries: BTreeMap<String, String>,
    quarantined: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDeletionResult {
    pub committed: bool,
    pub cleanup_pending: bool,
    pub operation_id: String,
}

fn snapshot(root: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut entries = BTreeMap::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| "Cannot inspect workspace cleanup files")?;
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "Invalid cleanup path")?
            .to_string_lossy()
            .to_string();
        let value = if metadata.file_type().is_symlink() {
            if path == root {
                return Err("Workspace cleanup root cannot be a symbolic link".into());
            }
            format!(
                "link:{}",
                fs::read_link(&path)
                    .map_err(|_| "Cannot inspect workspace link")?
                    .to_string_lossy()
            )
        } else if metadata.is_dir() {
            for entry in
                fs::read_dir(&path).map_err(|_| "Cannot inspect workspace cleanup directory")?
            {
                pending.push(
                    entry
                        .map_err(|_| "Cannot inspect workspace cleanup entry")?
                        .path(),
                );
            }
            "directory".into()
        } else if metadata.is_file() {
            let mut file =
                fs::File::open(&path).map_err(|_| "Cannot read workspace cleanup file")?;
            let mut digest = Sha256::new();
            let mut buffer = [0_u8; 65536];
            loop {
                let count = file
                    .read(&mut buffer)
                    .map_err(|_| "Cannot read workspace cleanup file")?;
                if count == 0 {
                    break;
                }
                digest.update(&buffer[..count]);
            }
            format!(
                "file:{}",
                digest
                    .finalize()
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            )
        } else {
            return Err("Unsupported workspace cleanup entry".into());
        };
        entries.insert(relative, value);
        if entries.len() > 100_000 {
            return Err("Workspace cleanup exceeds the entry limit".into());
        }
    }
    Ok(entries)
}

fn path_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("Cannot inspect workspace cleanup path".into()),
    }
}

fn unchanged_remaining(path: &Path, expected: &BTreeMap<String, String>) -> Result<(), String> {
    for (name, value) in snapshot(path)? {
        if expected.get(&name) != Some(&value) {
            return Err("Workspace cleanup is pending because files changed externally".into());
        }
    }
    Ok(())
}

fn cleanup(
    intent: &mut CleanupIntent,
    persist: impl FnOnce(&CleanupIntent) -> Result<(), String>,
    remove: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    // A recreated source directory is never touched after quarantine exists.
    if !intent.quarantined {
        if !path_exists(&intent.quarantine)? && path_exists(&intent.source)? {
            unchanged_remaining(&intent.source, &intent.entries)?;
            fs::rename(&intent.source, &intent.quarantine)
                .map_err(|_| "Cannot quarantine deleted workspace")?;
            #[cfg(unix)]
            fs::File::open(intent.source.parent().ok_or("Invalid cleanup directory")?)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| "Cannot persist workspace quarantine")?;
        }
        intent.quarantined = true;
        persist(intent)?;
    }
    if path_exists(&intent.quarantine)? {
        unchanged_remaining(&intent.quarantine, &intent.entries)?;
        remove(&intent.quarantine)?;
        #[cfg(unix)]
        fs::File::open(
            intent
                .quarantine
                .parent()
                .ok_or("Invalid cleanup directory")?,
        )
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "Cannot persist workspace cleanup removal")?;
    }
    Ok(())
}

pub fn ensure_available(
    local: &LocalStateStore,
    workspace: &str,
    directory: &Path,
) -> Result<(), String> {
    for queued in local.cleanup_workspaces()? {
        if queued == workspace {
            return Err("Workspace file cleanup is pending; retry after cleanup completes".into());
        }
        let value = local
            .cleanup_intent(&queued)?
            .ok_or("Missing workspace cleanup intent")?;
        let intent: CleanupIntent =
            serde_json::from_value(value).map_err(|_| "Damaged workspace cleanup intent")?;
        for reserved in [&intent.source, &intent.quarantine] {
            if directory.starts_with(reserved) || reserved.starts_with(directory) {
                return Err("Project directory overlaps pending workspace cleanup".into());
            }
        }
    }
    Ok(())
}

pub fn retry(local: &LocalStateStore, workspace: &str) -> Result<(), String> {
    let Some(value) = local.cleanup_intent(workspace)? else {
        return Ok(());
    };
    let mut intent: CleanupIntent =
        serde_json::from_value(value).map_err(|_| "Damaged workspace cleanup intent")?;
    cleanup(
        &mut intent,
        |intent| {
            local.store_cleanup_intent(
                workspace,
                &serde_json::to_value(intent).map_err(|_| "Invalid cleanup intent")?,
            )
        },
        |path| fs::remove_dir_all(path).map_err(|_| "Cannot finish workspace file cleanup".into()),
    )?;
    local.finish_cleanup(workspace)
}

pub fn delete(
    local: &mut LocalStateStore,
    workspace: &str,
    managed_directory: Option<&Path>,
    batch: &SecretBatch,
) -> Result<WorkspaceDeletionResult, String> {
    delete_with_cleanup(local, workspace, managed_directory, batch, |path| {
        fs::remove_dir_all(path).map_err(|_| "Cannot finish workspace file cleanup".into())
    })
}

fn delete_with_cleanup(
    local: &mut LocalStateStore,
    workspace: &str,
    managed_directory: Option<&Path>,
    batch: &SecretBatch,
    remove: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<WorkspaceDeletionResult, String> {
    batch.validate(Some(workspace))?;
    if !batch.mutations.is_empty() {
        return Err("Workspace deletion cannot include explicit secret mutations".into());
    }
    let request = json!({"kind":"delete-project","workspace":workspace});
    if local.replay_result(batch, &request)?.is_some() {
        let pending = local
            .cleanup_intent(workspace)
            .map(|value| value.is_some())
            .unwrap_or(true);
        return Ok(WorkspaceDeletionResult {
            committed: true,
            cleanup_pending: pending,
            operation_id: batch.operation_id.clone(),
        });
    }
    let managed_directory = match managed_directory {
        Some(directory) if path_exists(directory)? => Some(directory),
        _ => None,
    };
    let existing = local.cleanup_intent(workspace)?;
    let intent = match existing {
        Some(value) => Some(
            serde_json::from_value::<CleanupIntent>(value)
                .map_err(|_| "Damaged workspace cleanup intent")?,
        ),
        None => managed_directory
            .map(|directory| {
                let quarantine = directory
                    .parent()
                    .ok_or("Invalid workspace directory")?
                    .join(format!(".deleted-{}", batch.operation_id));
                if path_exists(&quarantine)? {
                    return Err("Workspace cleanup destination already exists".into());
                }
                Ok::<_, String>(CleanupIntent {
                    source: directory.to_path_buf(),
                    quarantine,
                    entries: snapshot(directory)?,
                    quarantined: false,
                })
            })
            .transpose()?,
    };
    let value = intent
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|_| "Invalid workspace cleanup intent")?;
    let result = json!({"committed":true,"cleanupPending":intent.is_some(),"operationId":batch.operation_id});
    local.delete_workspace_with_receipt(workspace, value.as_ref(), batch, &request, &result)?;
    // From here on only a committed result is returned, even if disk cleanup or
    // removal of its completed queue record fails. The next startup can retry.
    let pending = if let Some(mut intent) = intent {
        cleanup(
            &mut intent,
            |intent| {
                local.store_cleanup_intent(
                    workspace,
                    &serde_json::to_value(intent).map_err(|_| "Invalid cleanup intent")?,
                )
            },
            remove,
        )
        .and_then(|_| local.finish_cleanup(workspace))
        .is_err()
    } else {
        false
    };
    Ok(WorkspaceDeletionResult {
        committed: true,
        cleanup_pending: pending,
        operation_id: batch.operation_id.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::tests::MemoryRootKeyStore;

    #[test]
    fn cleanup_failure_reports_committed_and_restarts_without_resurrecting_or_deleting_new_source()
    {
        let dir = tempfile::tempdir().unwrap();
        let keys = MemoryRootKeyStore::default();
        let database = dir.path().join("state.db");
        let mut local = LocalStateStore::open(&database, &keys).unwrap();
        let source = dir.path().join("workspace");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("purr.yaml"), "name: original").unwrap();
        local.register("workspace", &source).unwrap();
        local
            .set_secret("purr/workspace/auth/token", "old-token")
            .unwrap();
        let batch = SecretBatch::fresh(vec![]).unwrap();
        let result = delete_with_cleanup(&mut local, "workspace", Some(&source), &batch, |_| {
            Err("Injected filesystem failure".into())
        })
        .unwrap();
        assert!(result.committed && result.cleanup_pending);
        assert!(local
            .get_secret("purr/workspace/auth/token")
            .unwrap()
            .is_none());
        assert!(local.workspaces().unwrap().is_empty());
        assert_eq!(
            local.operation_status(&batch.operation_id).unwrap().status,
            "committed"
        );
        assert!(!source.exists());
        assert!(ensure_available(&local, "workspace", &source).is_err());
        assert!(ensure_available(&local, "different-id", &source).is_err());
        assert!(ensure_available(&local, "other", &dir.path().join("other")).is_ok());
        fs::create_dir(&source).unwrap();
        fs::write(source.join("purr.yaml"), "name: external recreation").unwrap();
        drop(local);
        let mut local = LocalStateStore::open(&database, &keys).unwrap();
        retry(&local, "workspace").unwrap();
        assert_eq!(
            fs::read_to_string(source.join("purr.yaml")).unwrap(),
            "name: external recreation"
        );
        assert!(
            !delete(&mut local, "workspace", Some(&source), &batch)
                .unwrap()
                .cleanup_pending
        );
        assert_eq!(
            local
                .read_secret("purr/workspace/auth/token")
                .unwrap()
                .revision,
            2
        );
    }

    #[test]
    fn cleanup_refuses_external_changes_before_quarantine() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("workspace");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("purr.yaml"), "original").unwrap();
        let mut intent = CleanupIntent {
            source: source.clone(),
            quarantine: dir.path().join("quarantine"),
            entries: snapshot(&source).unwrap(),
            quarantined: false,
        };
        fs::write(source.join("purr.yaml"), "external").unwrap();
        assert!(cleanup(
            &mut intent,
            |_| Ok(()),
            |path| fs::remove_dir_all(path).map_err(|e| e.to_string())
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(source.join("purr.yaml")).unwrap(),
            "external"
        );
    }

    #[test]
    fn interruption_after_quarantine_before_phase_publication_preserves_recreated_source() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("workspace");
        let quarantine = dir.path().join("quarantine");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("purr.yaml"), "original").unwrap();
        let intent = CleanupIntent {
            source: source.clone(),
            quarantine: quarantine.clone(),
            entries: snapshot(&source).unwrap(),
            quarantined: false,
        };
        let journal = serde_json::to_value(&intent).unwrap();
        let mut first: CleanupIntent = serde_json::from_value(journal.clone()).unwrap();
        assert!(cleanup(
            &mut first,
            |_| Err("Injected phase persistence failure".into()),
            |_| panic!("must not delete before phase is durable")
        )
        .is_err());
        assert!(quarantine.exists());
        fs::create_dir(&source).unwrap();
        fs::write(source.join("purr.yaml"), "external recreation").unwrap();
        let mut restarted: CleanupIntent = serde_json::from_value(journal).unwrap();
        cleanup(
            &mut restarted,
            |_| Ok(()),
            |path| fs::remove_dir_all(path).map_err(|e| e.to_string()),
        )
        .unwrap();
        assert!(!quarantine.exists());
        assert_eq!(
            fs::read_to_string(source.join("purr.yaml")).unwrap(),
            "external recreation"
        );
        // Even a crash after removal but before queue deletion must not target source.
        cleanup(
            &mut restarted,
            |_| panic!("phase already durable"),
            |_| panic!("quarantine already gone"),
        )
        .unwrap();
        assert!(source.exists());
    }

    #[test]
    fn corrupt_cleanup_keeps_registered_workspace_readable_but_blocks_unknown_path_reuse() {
        let dir = tempfile::tempdir().unwrap();
        let keys = MemoryRootKeyStore::default();
        let database = dir.path().join("state.db");
        let local = LocalStateStore::open(&database, &keys).unwrap();
        let registered = dir.path().join("unrelated");
        local.register("unrelated", &registered).unwrap();
        local
            .db
            .execute(
                "INSERT INTO workspace_cleanup(workspace_id,payload) VALUES(?1,?2)",
                rusqlite::params!["deleted", b"damaged encrypted payload".as_slice()],
            )
            .unwrap();
        drop(local);
        let local = LocalStateStore::open(&database, &keys).unwrap();
        assert!(retry(&local, "deleted").is_err());
        // Startup restores this existing registration without consulting cleanup.
        assert_eq!(
            local.workspaces().unwrap(),
            vec![(
                "unrelated".into(),
                registered.to_string_lossy().into_owned()
            )]
        );
        assert!(local.read("unrelated").is_ok());
        assert!(ensure_available(&local, "deleted", &dir.path().join("elsewhere")).is_err());
        assert!(ensure_available(&local, "new-id", &dir.path().join("unknown")).is_err());
    }

    #[test]
    fn metadata_errors_are_not_absence_before_or_after_deletion_commit() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("ordinary-file");
        fs::write(&blocker, "not a directory").unwrap();
        let inaccessible = blocker.join("workspace");
        assert!(path_exists(&inaccessible).is_err());
        assert!(!path_exists(&dir.path().join("absent")).unwrap());
        let keys = MemoryRootKeyStore::default();
        let mut local = LocalStateStore::open(&dir.path().join("state.db"), &keys).unwrap();
        local
            .set_secret("purr/workspace/auth/token", "original")
            .unwrap();
        let batch = SecretBatch::fresh(vec![]).unwrap();
        assert!(delete(&mut local, "workspace", Some(&inaccessible), &batch).is_err());
        assert_eq!(
            local
                .get_secret("purr/workspace/auth/token")
                .unwrap()
                .as_deref(),
            Some("original")
        );
        assert_eq!(
            local.operation_status(&batch.operation_id).unwrap().status,
            "missing"
        );
        let mut intent = CleanupIntent {
            source: inaccessible,
            quarantine: dir.path().join("quarantine"),
            entries: BTreeMap::new(),
            quarantined: false,
        };
        assert!(cleanup(
            &mut intent,
            |_| panic!("cannot publish missing phase after metadata error"),
            |_| panic!("cannot delete unknown path")
        )
        .is_err());
        intent.quarantined = true;
        intent.quarantine = blocker.join("quarantine");
        assert!(cleanup(
            &mut intent,
            |_| Ok(()),
            |_| panic!("cannot delete unknown path")
        )
        .is_err());
    }

    #[test]
    fn database_deletion_failure_preserves_directory_and_secret() {
        let dir = tempfile::tempdir().unwrap();
        let keys = MemoryRootKeyStore::default();
        let mut local = LocalStateStore::open(&dir.path().join("state.db"), &keys).unwrap();
        let source = dir.path().join("workspace");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("purr.yaml"), "original").unwrap();
        local
            .set_secret("purr/workspace/auth/token", "old-token")
            .unwrap();
        local.db.execute_batch("CREATE TRIGGER fail_delete BEFORE DELETE ON secret_values BEGIN SELECT RAISE(ABORT,'synthetic database failure'); END;").unwrap();
        assert!(delete(
            &mut local,
            "workspace",
            Some(&source),
            &SecretBatch::fresh(vec![]).unwrap()
        )
        .is_err());
        assert_eq!(
            local
                .get_secret("purr/workspace/auth/token")
                .unwrap()
                .as_deref(),
            Some("old-token")
        );
        assert_eq!(
            fs::read_to_string(source.join("purr.yaml")).unwrap(),
            "original"
        );
        assert!(local.cleanup_intent("workspace").unwrap().is_none());
    }
}
