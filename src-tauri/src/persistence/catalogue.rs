//! Key-independent navigation of an existing catalogue. Never creates, migrates,
//! recovers or writes the database, and never treats inaccessible local records
//! as authoritative defaults.
use super::project_files::FilesystemWorkspaceStore;
use crate::security::{ProtectedError, ProtectedStatus};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

pub fn protected_state(error: &ProtectedError) -> Value {
    json!({"status":error.status,"code":error.code})
}
fn exists(db: &Connection, table: &str, workspace: &str) -> Result<bool, String> {
    let present: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [table],
            |r| r.get(0),
        )
        .map_err(|_| "Cannot inspect project recovery catalogue")?;
    if !present {
        return Ok(false);
    }
    db.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE workspace_id=?1)"),
        [workspace],
        |r| r.get(0),
    )
    .map_err(|_| "Cannot inspect project recovery catalogue".into())
}
pub fn load(
    data: &Path,
    error: &ProtectedError,
    attached: &HashMap<String, PathBuf>,
) -> Result<Value, String> {
    if database_absent(data)? {
        let mut roots = attached.iter().collect::<Vec<_>>();
        roots.sort_by(|a, b| a.0.cmp(b.0));
        let mut workspaces = Vec::new();
        for (id, directory) in roots {
            let files = FilesystemWorkspaceStore {
                directory: directory.clone(),
            }
            .load()?;
            workspaces.push(
                json!({"id":id,"files":files,"local":[],"protectedState":protected_state(error)}),
            );
        }
        return Ok(
            json!({"activeWorkspaceId":"","workspaces":workspaces,"protectedState":protected_state(error)}),
        );
    }
    // READ_ONLY preserves WAL visibility. immutable=1 would incorrectly ignore
    // committed catalogue rows still present in a live WAL.
    let db = Connection::open_with_flags(
        data.join("local-state.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| "Project catalogue is unavailable")?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "Project catalogue is unavailable")?;
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|_| "Project catalogue is unavailable")?;
    if !(1..=6).contains(&version) {
        return Err("Unsupported project catalogue version".into());
    }
    let tx = db
        .unchecked_transaction()
        .map_err(|_| "Project catalogue is unavailable")?;
    let mut roots = attached.clone();
    {
        let mut stmt = tx
            .prepare("SELECT id,directory FROM workspaces ORDER BY id")
            .map_err(|_| "Project catalogue is unavailable")?;
        for row in stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|_| "Project catalogue is unavailable")?
        {
            let (id, directory) = row.map_err(|_| "Project catalogue is unavailable")?;
            roots.insert(id, PathBuf::from(directory));
        }
    }
    let active: Option<String> = tx
        .query_row(
            "SELECT value FROM app_state WHERE key='active-workspace'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| "Project catalogue is unavailable")?;
    let mut roots = roots.into_iter().collect::<Vec<_>>();
    roots.sort_by(|a, b| a.0.cmp(&b.0));
    let mut workspaces = vec![];
    for (id, directory) in roots {
        // A cleanup reservation represents a deleted workspace, never an orphan
        // to rediscover or attach while its encrypted intent cannot be checked.
        if exists(&tx, "workspace_cleanup", &id)? {
            continue;
        }
        let state = if exists(&tx, "pending_commits", &id)? {
            protected_state(&ProtectedError::new(
                ProtectedStatus::RecoveryRequired,
                "project-recovery-required",
                true,
            ))
        } else {
            protected_state(error)
        };
        let files = FilesystemWorkspaceStore { directory }.load()?;
        workspaces.push(json!({"id":id,"files":files,"local":[],"protectedState":state}));
    }
    tx.rollback()
        .map_err(|_| "Project catalogue is unavailable")?;
    Ok(
        json!({"activeWorkspaceId":active.unwrap_or_default(),"workspaces":workspaces,"protectedState":protected_state(error)}),
    )
}

pub fn check_attachment(
    data: &Path,
    id: &str,
    directory: &Path,
    attached: &HashMap<String, PathBuf>,
) -> Result<(), String> {
    if database_absent(data)? {
        if attached.iter().any(|(owner, path)| {
            (owner == id && path != directory) || (owner != id && path == directory)
        }) {
            return Err("Project identity or directory is already registered".into());
        }
        return Ok(());
    }
    let db = Connection::open_with_flags(
        data.join("local-state.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| "Project catalogue is unavailable")?;
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|_| "Project catalogue is unavailable")?;
    if !(1..=6).contains(&version) {
        return Err("Unsupported project catalogue version".into());
    }
    let cleanup:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_cleanup')",[],|row|row.get(0)).map_err(|_|"Project catalogue is unavailable")?;
    if cleanup
        && db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM workspace_cleanup)",
                [],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|_| "Project catalogue is unavailable")?
    {
        return Err("Cannot attach while protected cleanup paths are unavailable".into());
    }
    let mut existing = attached.clone();
    let mut statement = db
        .prepare("SELECT id,directory FROM workspaces")
        .map_err(|_| "Project catalogue is unavailable")?;
    for row in statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| "Project catalogue is unavailable")?
    {
        let (id, path) = row.map_err(|_| "Project catalogue is unavailable")?;
        existing.insert(id, PathBuf::from(path));
    }
    if existing.iter().any(|(owner, path)| {
        (owner == id && path != directory) || (owner != id && path == directory)
    }) {
        return Err("Project identity or directory is already registered".into());
    }
    if exists(&db, "pending_commits", id)? {
        return Err("Project recovery is required before attaching this directory".into());
    }
    Ok(())
}

// A first launch denied by Keychain must still render its protected-state UI.
// Never create a replacement catalogue or ignore surviving SQLite sidecars.
fn database_absent(data: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(data.join("local-state.sqlite3")) {
        Ok(metadata) if metadata.is_file() => Ok(false),
        Ok(_) => Err("Project catalogue is unavailable".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            for suffix in ["-wal", "-shm", "-journal"] {
                match std::fs::symlink_metadata(data.join(format!("local-state.sqlite3{suffix}"))) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    _ => return Err("Project catalogue is unavailable".into()),
                }
            }
            Ok(true)
        }
        Err(_) => Err("Project catalogue is unavailable".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        persistence::local_records::{LocalRecord, LocalStateStore},
        security::tests::MemoryRootKeyStore,
    };
    #[test]
    fn denied_first_launch_has_a_readonly_empty_catalogue_without_creating_a_database() {
        let dir = tempfile::tempdir().unwrap();
        let state = load(
            dir.path(),
            &ProtectedError::denied("root-provider-access-denied"),
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(state["protectedState"]["status"], "denied");
        assert_eq!(state["workspaces"], json!([]));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        std::fs::write(
            dir.path().join("local-state.sqlite3-wal"),
            b"unreadable surviving data",
        )
        .unwrap();
        assert!(load(
            dir.path(),
            &ProtectedError::denied("root-provider-access-denied"),
            &HashMap::new()
        )
        .is_err());
    }
    #[test]
    fn readonly_catalogue_sees_live_wal_and_preserves_opaque_records_with_recovery_guards() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("local-state.sqlite3");
        let mut local = LocalStateStore::open(&database, &MemoryRootKeyStore::default()).unwrap();
        local
            .db
            .execute_batch("PRAGMA wal_autocheckpoint=0")
            .unwrap();
        for id in ["public", "pending", "deleted"] {
            let path = dir.path().join(id);
            std::fs::create_dir(&path).unwrap();
            std::fs::write(path.join("purr.yaml"), format!("purr: 1\nid: {id}\n")).unwrap();
            local.register(id, &path).unwrap();
        }
        local
            .write(
                "public",
                &[LocalRecord {
                    table: "drafts".into(),
                    id: "draft".into(),
                    value: json!({"sensitive":"synthetic-opaque-draft"}),
                }],
            )
            .unwrap();
        local.set_app("active-workspace", "public").unwrap();
        local
            .journal("pending", &json!({"private":"synthetic-journal"}))
            .unwrap();
        local
            .db
            .execute(
                "INSERT INTO workspace_cleanup VALUES('deleted',?1)",
                [b"opaque-cleanup".as_slice()],
            )
            .unwrap();
        let absent_root = MemoryRootKeyStore::default();
        let error = LocalStateStore::open_typed(&database, &absent_root)
            .err()
            .unwrap();
        assert_eq!(error.code, "root-key-missing");
        assert_eq!(absent_root.writes(), 0);
        let wal = database.with_extension("sqlite3-wal");
        let before_db = std::fs::read(&database).unwrap();
        let before_wal = std::fs::read(&wal).unwrap();
        let snapshot = load(
            dir.path(),
            &ProtectedError::unavailable("root-key-missing"),
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(snapshot["activeWorkspaceId"], "public");
        assert!(snapshot.get("global").is_none());
        assert!(snapshot.get("legacy").is_none());
        let rows = snapshot["workspaces"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], "pending");
        assert_eq!(rows[0]["protectedState"]["status"], "recovery-required");
        assert_eq!(rows[1]["protectedState"]["status"], "unavailable");
        assert_eq!(rows[1]["local"], json!([]));
        assert!(!snapshot.to_string().contains("synthetic-opaque-draft"));
        assert_eq!(std::fs::read(&database).unwrap(), before_db);
        assert_eq!(std::fs::read(&wal).unwrap(), before_wal);
        assert!(check_attachment(
            dir.path(),
            "new",
            &dir.path().join("other"),
            &HashMap::new()
        )
        .is_err());
        assert_eq!(
            local.read("public").unwrap()[0].value["sensitive"],
            "synthetic-opaque-draft"
        );
    }
    #[test]
    fn unavailable_or_future_catalogues_are_not_recreated_or_migrated() {
        let dir = tempfile::tempdir().unwrap();
        let error = ProtectedError::unavailable("root-key-missing");
        let missing = load(dir.path(), &error, &HashMap::new()).unwrap();
        assert_eq!(missing["protectedState"]["code"], "root-key-missing");
        assert_eq!(missing["workspaces"], json!([]));
        assert!(!dir.path().join("local-state.sqlite3").exists());
        let db = Connection::open(dir.path().join("local-state.sqlite3")).unwrap();
        db.execute_batch("PRAGMA user_version=999").unwrap();
        assert!(load(dir.path(), &error, &HashMap::new()).is_err());
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            999
        );
    }
}
