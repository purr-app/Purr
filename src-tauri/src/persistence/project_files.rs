use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};

#[derive(Serialize, Deserialize, Clone)]
pub struct ProjectFile {
    pub content: String,
    pub revision: String,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub content: Option<String>,
    pub expected_revision: Option<String>,
}
pub struct FilesystemWorkspaceStore {
    pub directory: PathBuf,
}
pub fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn storage_error(_: std::io::Error) -> String {
    "Cannot access project file".into()
}
impl FilesystemWorkspaceStore {
    pub fn path(&self, relative: &str) -> Result<PathBuf, String> {
        let path = Path::new(relative);
        if relative.is_empty()
            || relative.contains('\\')
            || relative
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || !path
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
            || !(relative == "purr.yaml"
                || [
                    "requests/",
                    "graphql/",
                    "documents/",
                    "schemas/",
                    "environments/",
                    "folders/",
                    "integrations/",
                    "assets/",
                ]
                .iter()
                .any(|prefix| relative.starts_with(prefix)))
            || !(relative.ends_with(".yaml")
                || relative.ends_with(".graphql")
                || relative.starts_with("schemas/") && relative.ends_with(".openapi")
                || relative.starts_with("assets/") && relative.ends_with(".bin"))
        {
            return Err("Invalid project resource path".into());
        }
        let mut current = self.directory.clone();
        for component in path.components() {
            current.push(component);
            if let Ok(meta) = fs::symlink_metadata(&current) {
                if meta.file_type().is_symlink() {
                    return Err("Project resources cannot traverse symbolic links".into());
                }
            }
        }
        Ok(current)
    }
    pub fn read(&self, relative: &str) -> Result<Option<ProjectFile>, String> {
        let path = self.path(relative)?;
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(storage_error(error)),
        };
        let rev = revision(&bytes);
        let content = if relative.starts_with("assets/") {
            STANDARD.encode(&bytes)
        } else {
            String::from_utf8(bytes).map_err(|_| "Project resource is not UTF-8")?
        };
        Ok(Some(ProjectFile {
            content,
            revision: rev,
        }))
    }
    pub fn load(&self) -> Result<BTreeMap<String, ProjectFile>, String> {
        let mut index = BTreeMap::new();
        if !self.directory.exists() {
            return Ok(index);
        }
        let mut pending = vec![self.directory.clone()];
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(directory).map_err(storage_error)? {
                let entry = entry.map_err(storage_error)?;
                let kind = entry.file_type().map_err(storage_error)?;
                let full = entry.path();
                let relative = full
                    .strip_prefix(&self.directory)
                    .map_err(|_| "Invalid project path")?
                    .to_string_lossy()
                    .replace('\\', "/");
                if kind.is_symlink() {
                    continue;
                }
                if kind.is_dir() {
                    if !relative.split('/').any(|part| part.starts_with('.'))
                        && [
                            "requests",
                            "graphql",
                            "documents",
                            "schemas",
                            "environments",
                            "folders",
                            "integrations",
                            "assets",
                        ]
                        .contains(&relative.split('/').next().unwrap_or(""))
                    {
                        pending.push(full);
                    }
                } else if self.path(&relative).is_ok() {
                    if let Some(file) = self.read(&relative)? {
                        index.insert(relative, file);
                    }
                }
            }
        }
        Ok(index)
    }
    fn bytes(change: &FileChange) -> Result<Option<Vec<u8>>, String> {
        change
            .content
            .as_ref()
            .map(|content| {
                if change.path.starts_with("assets/") {
                    STANDARD
                        .decode(content)
                        .map_err(|_| "Invalid attachment encoding".into())
                } else {
                    Ok(content.as_bytes().to_vec())
                }
            })
            .transpose()
    }
    pub fn preflight(&self, changes: &[FileChange], recovering: bool) -> Result<(), String> {
        for change in changes {
            let actual = self.read(&change.path)?;
            let current = actual.as_ref().map(|file| file.revision.as_str());
            let desired = Self::bytes(change)?.as_ref().map(|bytes| revision(bytes));
            if current != change.expected_revision.as_deref()
                && !(recovering && current == desired.as_deref())
            {
                return Err("Project file changed externally. Reload the workspace before saving; existing files have not been overwritten.".into());
            }
        }
        Ok(())
    }
    pub fn apply(&self, changes: &[FileChange]) -> Result<(), String> {
        for change in changes {
            let path = self.path(&change.path)?;
            self.preflight(std::slice::from_ref(change), true)?;
            if let Some(bytes) = Self::bytes(change)? {
                if fs::read(&path).ok().as_deref() == Some(bytes.as_slice()) {
                    continue;
                }
                let parent = path.parent().ok_or("Invalid project path")?;
                fs::create_dir_all(parent).map_err(storage_error)?;
                let mut temporary =
                    tempfile::NamedTempFile::new_in(parent).map_err(storage_error)?;
                temporary.write_all(&bytes).map_err(storage_error)?;
                temporary.as_file().sync_all().map_err(storage_error)?;
                temporary
                    .persist(&path)
                    .map_err(|_| "Cannot replace project resource atomically")?;
                #[cfg(unix)]
                fs::File::open(parent)
                    .and_then(|file| file.sync_all())
                    .map_err(storage_error)?;
            } else if path.exists() {
                fs::remove_file(&path).map_err(storage_error)?;
            }
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{persistence::local_records::LocalStateStore, security::tests::MemoryRootKeyStore};
    #[test]
    fn interrupted_file_commit_replays_idempotently_before_local_transaction_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let secure = MemoryRootKeyStore::default();
        let project = FilesystemWorkspaceStore {
            directory: dir.path().join("project"),
        };
        let db = dir.path().join("state.db");
        let mut local = LocalStateStore::open(&db, &secure).unwrap();
        let changes = vec![
            FileChange {
                path: "purr.yaml".into(),
                content: Some("purr: 1\n".into()),
                expected_revision: None,
            },
            FileChange {
                path: "requests/get.yaml".into(),
                content: Some("purr: 1\nkind: http\n".into()),
                expected_revision: None,
            },
        ];
        project.preflight(&changes, false).unwrap();
        local
            .journal(
                "workspace",
                &serde_json::json!({"files":changes,"local":[]}),
            )
            .unwrap();
        project.apply(&changes[..1]).unwrap();
        drop(local);
        local = LocalStateStore::open(&db, &secure).unwrap();
        let pending = local.pending().unwrap();
        assert_eq!(pending.len(), 1);
        let replay: Vec<FileChange> =
            serde_json::from_value(pending[0].1["files"].clone()).unwrap();
        project.preflight(&replay, true).unwrap();
        project.apply(&replay).unwrap();
        local.write("workspace", &[]).unwrap();
        assert!(local.pending().unwrap().is_empty());
        assert_eq!(project.load().unwrap().len(), 2);
        let modified = fs::metadata(project.directory.join("purr.yaml"))
            .unwrap()
            .modified()
            .unwrap();
        project.apply(&replay).unwrap();
        assert_eq!(
            fs::metadata(project.directory.join("purr.yaml"))
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_resources_are_never_written() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("requests")).unwrap();
        let store = FilesystemWorkspaceStore {
            directory: dir.path().into(),
        };
        assert!(store.path("requests/test.yaml").is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }
    #[test]
    fn external_changes_and_traversal_are_rejected_before_writes() {
        let dir = tempfile::tempdir().unwrap();
        let store = FilesystemWorkspaceStore {
            directory: dir.path().into(),
        };
        assert!(store.path("requests/../../outside.yaml").is_err());
        assert!(store.path("schemas/imported.openapi").is_ok());
        assert!(store.path("documents/imported.openapi").is_err());
        let first = FileChange {
            path: "purr.yaml".into(),
            content: Some("purr: 1\n".into()),
            expected_revision: None,
        };
        store
            .preflight(std::slice::from_ref(&first), false)
            .unwrap();
        store.apply(&[first]).unwrap();
        let previous = store.read("purr.yaml").unwrap().unwrap();
        fs::write(dir.path().join("purr.yaml"), "invalid: [").unwrap();
        assert!(store
            .preflight(
                &[FileChange {
                    path: "purr.yaml".into(),
                    content: Some("purr: 1".into()),
                    expected_revision: Some(previous.revision)
                }],
                false
            )
            .is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join("purr.yaml")).unwrap(),
            "invalid: ["
        );
    }
}
