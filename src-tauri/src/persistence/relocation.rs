//! Whole-directory moves preserve Git metadata and use content checks before cleanup.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Stamp {
    pub kind: String,
    pub digest: String,
}
pub type Tree = BTreeMap<String, Stamp>;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Job {
    pub version: u32,
    pub source: PathBuf,
    pub target: PathBuf,
    pub staging: PathBuf,
    pub files: Tree,
}
pub fn fingerprint(root: &Path) -> Result<Tree, String> {
    let root_meta = fs::symlink_metadata(root).map_err(|_| "Cannot inspect project directory")?;
    if root_meta.file_type().is_symlink() || !root_meta.is_dir() {
        return Err("The project directory was replaced. Existing paths are preserved.".into());
    }
    let mut result = Tree::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in
            fs::read_dir(&directory).map_err(|_| "Cannot read project files during relocation")?
        {
            let entry = entry.map_err(|_| "Cannot inspect a project file")?;
            let path = entry.path();
            let meta = fs::symlink_metadata(&path).map_err(|_| "Cannot inspect a project file")?;
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "Invalid project path")?
                .to_str()
                .ok_or("Project paths must use UTF-8")?
                .replace('\\', "/");
            let stamp = if meta.file_type().is_symlink() {
                Stamp {
                    kind: "link".into(),
                    digest: fs::read_link(&path)
                        .map_err(|_| "Cannot read project link")?
                        .to_str()
                        .ok_or("Project links must use UTF-8")?
                        .into(),
                }
            } else if meta.is_dir() {
                pending.push(path);
                Stamp {
                    kind: "directory".into(),
                    digest: String::new(),
                }
            } else if meta.is_file() {
                let mut input = fs::File::open(&path).map_err(|_| "Cannot read project file")?;
                let mut hasher = Sha256::new();
                let mut buffer = [0; 64 * 1024];
                loop {
                    let count = input
                        .read(&mut buffer)
                        .map_err(|_| "Cannot read project file")?;
                    if count == 0 {
                        break;
                    }
                    hasher.update(&buffer[..count]);
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    hasher.update(meta.permissions().mode().to_le_bytes());
                }
                Stamp {
                    kind: "file".into(),
                    digest: hasher
                        .finalize()
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect(),
                }
            } else {
                return Err("Special filesystem entries cannot be moved by Purr".into());
            };
            result.insert(relative, stamp);
        }
    }
    Ok(result)
}
pub fn copy(job: &Job) -> Result<(), String> {
    if job.version != 1 {
        return Err("This relocation record requires a newer Purr version".into());
    }
    if fingerprint(&job.source)? != job.files {
        return Err("The source changed outside Purr. Both directories are preserved; cancel the move or restore the source before retrying.".into());
    }
    for (relative, stamp) in &job.files {
        let source = job.source.join(relative);
        let target = job.staging.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|_| "Cannot create destination directory")?;
        }
        match stamp.kind.as_str() {
            "directory" => {
                fs::create_dir_all(&target).map_err(|_| "Cannot create destination directory")?
            }
            "file" => {
                fs::copy(&source, &target)
                    .map_err(|_| "Cannot copy project file; source is preserved")?;
            }
            "link" => copy_link(&source, &target)?,
            _ => return Err("Invalid relocation record".into()),
        }
    }
    if fingerprint(&job.source)? != job.files || fingerprint(&job.staging)? != job.files {
        return Err(
            "Project files changed during relocation. Source and copied files are preserved."
                .into(),
        );
    }
    Ok(())
}
#[cfg(unix)]
fn copy_link(source: &Path, target: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(
        fs::read_link(source).map_err(|_| "Cannot read project link")?,
        target,
    )
    .map_err(|_| "Cannot preserve project symbolic link".into())
}
#[cfg(windows)]
fn copy_link(source: &Path, target: &Path) -> Result<(), String> {
    let link = fs::read_link(source).map_err(|_| "Cannot read project link")?;
    if source.is_dir() {
        std::os::windows::fs::symlink_dir(link, target)
    } else {
        std::os::windows::fs::symlink_file(link, target)
    }
    .map_err(|_| "Cannot preserve project symbolic link".into())
}
pub fn publish(job: &Job) -> Result<(), String> {
    if job.target.is_dir() && fingerprint(&job.target)? == job.files {
        if job.source.exists() && fingerprint(&job.source)? != job.files {
            return Err("The source changed outside Purr. Both directories are preserved.".into());
        }
        return Ok(());
    }
    if fingerprint(&job.source)? != job.files || fingerprint(&job.staging)? != job.files {
        return Err(
            "Relocation is incomplete. Retry or cancel the move; source files are preserved."
                .into(),
        );
    }
    if job.target.exists() {
        fs::remove_dir(&job.target)
            .map_err(|_| "The destination is no longer empty; existing files are preserved")?;
    }
    fs::rename(&job.staging, &job.target)
        .map_err(|_| "Cannot publish the copied project; source is preserved".to_string())
}
pub fn cleanup(job: &Job) -> Result<(), String> {
    if fingerprint(&job.target)? != job.files {
        return Err("The destination changed after relocation. Source files are preserved.".into());
    }
    match fs::symlink_metadata(&job.source) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Cannot inspect the original directory; cleanup remains pending".into()),
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
            if fingerprint(&job.source)? != job.files {
                return Err("The original directory changed outside Purr. It is preserved; cleanup remains pending.".into());
            }
            fs::remove_dir_all(&job.source)
                .map_err(|_| "Project moved; original-directory cleanup remains pending".into())
        }
        _ => Err("The original path changed; it is preserved".into()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Job) {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let staging = dir.path().join("staging");
        let target = dir.path().join("target");
        fs::create_dir_all(source.join(".git/objects")).unwrap();
        fs::create_dir_all(source.join("assets")).unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::write(
            source.join(".git/config"),
            "[remote \"origin\"]\nurl = git@example.test:repo",
        )
        .unwrap();
        fs::write(source.join("assets/blob.bin"), [0, 255, 4, 3]).unwrap();
        fs::write(source.join("purr.yaml"), "workspace").unwrap();
        let job = Job {
            version: 1,
            files: fingerprint(&source).unwrap(),
            source,
            target,
            staging,
        };
        (dir, job)
    }
    #[test]
    fn moves_complete_git_and_binary_files_and_resumes_published_copy() {
        let (_dir, job) = fixture();
        copy(&job).unwrap();
        publish(&job).unwrap();
        publish(&job).unwrap();
        cleanup(&job).unwrap();
        assert!(!job.source.exists());
        assert!(job.target.join(".git/config").exists());
        assert_eq!(
            fs::read(job.target.join("assets/blob.bin")).unwrap(),
            [0, 255, 4, 3]
        );
        cleanup(&job).unwrap();
    }
    #[test]
    fn refuses_external_changes_without_deleting_originals() {
        let (_dir, job) = fixture();
        copy(&job).unwrap();
        fs::write(job.source.join("new.txt"), "external").unwrap();
        assert!(publish(&job).is_err());
        assert!(job.source.join("new.txt").exists());
    }
    #[test]
    fn does_not_replace_nonempty_destination_or_cleanup_modified_source() {
        let (_dir, job) = fixture();
        copy(&job).unwrap();
        fs::create_dir(&job.target).unwrap();
        fs::write(job.target.join("user.txt"), "owned").unwrap();
        assert!(publish(&job).is_err());
        fs::remove_file(job.target.join("user.txt")).unwrap();
        publish(&job).unwrap();
        fs::write(job.source.join("later.txt"), "preserved").unwrap();
        assert!(cleanup(&job).is_err());
        assert!(job.source.join("later.txt").exists());
    }
    #[cfg(unix)]
    #[test]
    fn refuses_replaced_directory_roots_before_cleanup() {
        let (_dir, job) = fixture();
        copy(&job).unwrap();
        publish(&job).unwrap();
        fs::remove_dir_all(&job.target).unwrap();
        std::os::unix::fs::symlink(&job.source, &job.target).unwrap();
        assert!(publish(&job).is_err());
        assert!(cleanup(&job).is_err());
        assert!(job.source.join("purr.yaml").exists());
    }
}
