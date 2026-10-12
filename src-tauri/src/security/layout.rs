//! One-time, resumable retirement of pre-release storage. No ciphertext or OS
//! entry is read or rewritten; external project folders are never traversed.
use super::ProtectedError;
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

static PREPARATION: std::sync::Mutex<()> = std::sync::Mutex::new(());

const MARKER: &str = "storage-layout-v2.json";
const PENDING: &str = "storage-layout-transition.json";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Transition {
    version: u8,
    archive: String,
    entries: Vec<String>,
}
fn failure() -> ProtectedError {
    ProtectedError::unavailable("storage-layout-unavailable")
}
fn conflict() -> ProtectedError {
    ProtectedError::corrupt("storage-layout-conflict")
}
fn present(path: &Path) -> Result<bool, ProtectedError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(failure()),
    }
}
fn directory(path: &Path) -> Result<(), ProtectedError> {
    if !present(path)? {
        fs::create_dir_all(path).map_err(|_| failure())?;
    }
    if !fs::symlink_metadata(path).map_err(|_| failure())?.is_dir() {
        return Err(conflict());
    }
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| failure())?;
    Ok(())
}
fn lock(path: &Path) -> Result<File, ProtectedError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    let file = options.open(path).map_err(|_| failure())?;
    if !file.metadata().map_err(|_| failure())?.is_file() {
        return Err(conflict());
    }
    file.try_lock()
        .map_err(|_| ProtectedError::unavailable("root-vault-in-use"))?;
    Ok(file)
}
fn sync(path: &Path) -> Result<(), ProtectedError> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| failure())
}
fn owned(name: &str) -> bool {
    matches!(
        name,
        "projects"
            | "workspaces"
            | "development"
            | "release"
            | "storage-v2"
            | "root-key-v1"
            | "root-key-metadata-v1.json"
    ) || matches!(
        name,
        "local-state.sqlite3"
            | "local-state.sqlite3-wal"
            | "local-state.sqlite3-shm"
            | "local-state.sqlite3-journal"
    ) || name == "legacy-workspaces.encrypted"
        || name.starts_with("legacy-workspaces.encrypted.")
        || name.starts_with(".tmp")
}
fn read(path: &Path) -> Result<Transition, ProtectedError> {
    if !fs::symlink_metadata(path).map_err(|_| failure())?.is_file() {
        return Err(conflict());
    }
    let value: Transition =
        serde_json::from_slice(&fs::read(path).map_err(|_| failure())?).map_err(|_| conflict())?;
    if value.version != 2
        || value.archive.len() != 32
        || !value.archive.bytes().all(|c| c.is_ascii_hexdigit())
        || value
            .entries
            .iter()
            .any(|name| !owned(name) || name.contains(['/', '\\']) || name == "." || name == "..")
    {
        return Err(conflict());
    }
    let mut unique = value.entries.clone();
    unique.sort();
    unique.dedup();
    if unique.len() != value.entries.len() {
        return Err(conflict());
    }
    Ok(value)
}
fn publish(root: &Path, value: &Transition) -> Result<(), ProtectedError> {
    let mut temp = tempfile::Builder::new()
        .prefix(".layout-")
        .tempfile_in(root)
        .map_err(|_| failure())?;
    temp.write_all(&serde_json::to_vec(value).map_err(|_| failure())?)
        .map_err(|_| failure())?;
    temp.as_file().sync_all().map_err(|_| failure())?;
    temp.persist_noclobber(root.join(PENDING))
        .map_err(|_| failure())?;
    sync(root)
}

pub fn prepare(root: &Path) -> Result<PathBuf, ProtectedError> {
    prepare_inner(root, None)
}
fn prepare_inner(root: &Path, stop_after: Option<usize>) -> Result<PathBuf, ProtectedError> {
    let _process = PREPARATION.lock().map_err(|_| failure())?;
    directory(root)?;
    let _layout = lock(&root.join("storage-layout.lock"))?;
    if present(&root.join(MARKER))? {
        read(&root.join(MARKER))?;
        if present(&root.join(PENDING))? {
            return Err(conflict());
        }
        return Ok(root.to_owned());
    }
    // Keep this inode at its original path: old builds also lock it.
    let _old = lock(&root.join("root-key-manager.lock"))?;
    // A lost layout marker must not make an established scoped store look old.
    if [
        "scope-keys.sqlite3",
        "scope-keys.sqlite3-wal",
        "scope-keys.sqlite3-shm",
        "scope-keys.sqlite3-journal",
    ]
    .iter()
    .any(|name| present(&root.join(name)).unwrap_or(true))
    {
        return Err(conflict());
    }
    let metadata_path = root.join("root-key-metadata-v1.json");
    if present(&metadata_path)? {
        if !fs::symlink_metadata(&metadata_path)
            .map_err(|_| failure())?
            .is_file()
        {
            return Err(conflict());
        }
        let metadata: serde_json::Value =
            serde_json::from_slice(&fs::read(&metadata_path).map_err(|_| failure())?)
                .map_err(|_| conflict())?;
        if metadata["profile"] == "application-v2" || metadata.get("scopeRegistryVersion").is_some()
        {
            return Err(conflict());
        }
    }
    let transition = if present(&root.join(PENDING))? {
        read(&root.join(PENDING))?
    } else {
        let mut entries = fs::read_dir(root)
            .map_err(|_| failure())?
            .map(|entry| entry.map_err(|_| failure()))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter_map(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .filter(|name| owned(name))
                    .map(str::to_owned)
            })
            .collect::<Vec<_>>();
        entries.sort();
        let mut id = [0u8; 16];
        getrandom::fill(&mut id).map_err(|_| failure())?;
        let value = Transition {
            version: 2,
            archive: id.iter().map(|byte| format!("{byte:02x}")).collect(),
            entries,
        };
        publish(root, &value)?;
        value
    };
    let archive = root.join("deprecated").join(&transition.archive);
    if !transition.entries.is_empty() {
        directory(&root.join("deprecated"))?;
        directory(&archive)?;
        sync(&root.join("deprecated"))?;
        sync(root)?;
    }
    let mut child_locks = Vec::new();
    for name in ["development", "release", "storage-v2"] {
        let source = root.join(name);
        if present(&source)? {
            if !fs::symlink_metadata(&source)
                .map_err(|_| failure())?
                .is_dir()
            {
                return Err(conflict());
            }
            child_locks.push(lock(&source.join("root-key-manager.lock"))?);
        }
    }
    for (index, name) in transition.entries.iter().enumerate() {
        let source = root.join(name);
        let target = archive.join(name);
        match (present(&source)?, present(&target)?) {
            (true, false) => {
                fs::rename(&source, &target).map_err(|_| failure())?;
                sync(&archive)?;
                sync(root)?;
            }
            (false, true) => {} // resume after a durable rename
            _ => return Err(conflict()),
        }
        if stop_after == Some(index + 1) {
            return Err(failure());
        }
    }
    fs::rename(root.join(PENDING), root.join(MARKER)).map_err(|_| failure())?;
    sync(root)?;
    Ok(root.to_owned())
}

pub fn deprecated_directory(root: &Path) -> Option<PathBuf> {
    let value = read(&root.join(MARKER)).ok()?;
    (!value.entries.is_empty()).then(|| root.join("deprecated").join(value.archive))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archives_only_owned_files_and_preserves_profiles_without_reading_ciphertext() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for name in [
            "projects/a",
            "storage-v2/projects/b",
            "development/workspaces/c",
        ] {
            fs::create_dir_all(root.join(name)).unwrap();
            fs::write(root.join(name).join("purr.yaml"), name).unwrap();
        }
        for name in [
            "local-state.sqlite3",
            "local-state.sqlite3-wal",
            "root-key-metadata-v1.json",
            "root-key-v1",
            "legacy-workspaces.encrypted",
        ] {
            fs::write(root.join(name), format!("opaque-{name}")).unwrap();
        }
        fs::write(
            root.join("root-key-metadata-v1.json"),
            br#"{"profile":"application"}"#,
        )
        .unwrap();
        fs::write(root.join("webview-state"), b"unchanged").unwrap();
        assert_eq!(prepare(root).unwrap(), root);
        let old = deprecated_directory(root).unwrap();
        assert_eq!(
            fs::read(old.join("local-state.sqlite3-wal")).unwrap(),
            b"opaque-local-state.sqlite3-wal"
        );
        assert_eq!(
            fs::read(old.join("root-key-v1")).unwrap(),
            b"opaque-root-key-v1"
        );
        assert_eq!(
            fs::read(old.join("storage-v2/projects/b/purr.yaml")).unwrap(),
            b"storage-v2/projects/b"
        );
        assert_eq!(fs::read(root.join("webview-state")).unwrap(), b"unchanged");
        fs::write(root.join("local-state.sqlite3"), b"new-state").unwrap();
        fs::write(root.join("scope-keys.sqlite3"), b"new-keys").unwrap();
        prepare(root).unwrap();
        assert_eq!(
            fs::read(root.join("local-state.sqlite3")).unwrap(),
            b"new-state"
        );
        assert_eq!(deprecated_directory(root).unwrap(), old);
    }
    #[test]
    fn interrupted_moves_resume_without_overwrite() {
        for stop in 1..=3 {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path();
            for name in ["projects", "workspaces", "storage-v2"] {
                fs::create_dir(root.join(name)).unwrap();
                fs::write(root.join(name).join("sentinel"), name).unwrap();
            }
            assert!(prepare_inner(root, Some(stop)).is_err());
            prepare(root).unwrap();
            let old = deprecated_directory(root).unwrap();
            for name in ["projects", "workspaces", "storage-v2"] {
                assert_eq!(
                    fs::read(old.join(name).join("sentinel")).unwrap(),
                    name.as_bytes()
                );
            }
        }
    }
    #[test]
    fn active_old_process_and_conflicting_destination_do_not_lose_data() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join("local-state.sqlite3"), b"original").unwrap();
        let guard = lock(&root.join("root-key-manager.lock")).unwrap();
        assert!(prepare(root).is_err());
        drop(guard);
        assert!(prepare_inner(root, Some(1)).is_err());
        fs::write(root.join("local-state.sqlite3"), b"conflicting").unwrap();
        assert!(prepare(root).is_err());
        let plan = read(&root.join(PENDING)).unwrap();
        assert_eq!(
            fs::read(
                root.join("deprecated")
                    .join(plan.archive)
                    .join("local-state.sqlite3")
            )
            .unwrap(),
            b"original"
        );
        assert_eq!(
            fs::read(root.join("local-state.sqlite3")).unwrap(),
            b"conflicting"
        );
    }
    #[test]
    fn fresh_profile_and_missing_marker_fail_closed_for_existing_keys() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        prepare(root).unwrap();
        assert!(deprecated_directory(root).is_none());
        fs::write(root.join("scope-keys.sqlite3"), b"established").unwrap();
        fs::remove_file(root.join(MARKER)).unwrap();
        assert!(prepare(root).is_err());
        assert_eq!(
            fs::read(root.join("scope-keys.sqlite3")).unwrap(),
            b"established"
        );
    }
    #[test]
    fn missing_layout_and_registry_cannot_retire_new_root_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::write(
            root.join("root-key-metadata-v1.json"),
            br#"{"profile":"application-v2"}"#,
        )
        .unwrap();
        assert!(prepare(root).is_err());
        assert!(!root.join(PENDING).exists());
        assert_eq!(
            fs::read(root.join("root-key-metadata-v1.json")).unwrap(),
            br#"{"profile":"application-v2"}"#
        );
    }
    #[test]
    fn concurrent_consumers_prepare_one_archive() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("local-state.sqlite3"), b"original").unwrap();
        std::thread::scope(|threads| {
            let jobs = (0..4)
                .map(|_| threads.spawn(|| prepare(temp.path())))
                .collect::<Vec<_>>();
            for job in jobs {
                assert!(job.join().unwrap().is_ok());
            }
        });
        assert_eq!(
            fs::read_dir(temp.path().join("deprecated"))
                .unwrap()
                .count(),
            1
        );
    }
    #[cfg(unix)]
    #[test]
    fn refuses_redirected_archive_directory() {
        let temp = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("local-state.sqlite3"), b"original").unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), temp.path().join("deprecated")).unwrap();
        assert!(prepare(temp.path()).is_err());
        assert_eq!(
            fs::read(temp.path().join("local-state.sqlite3")).unwrap(),
            b"original"
        );
        assert_eq!(fs::read_dir(elsewhere.path()).unwrap().count(), 0);
    }
}
