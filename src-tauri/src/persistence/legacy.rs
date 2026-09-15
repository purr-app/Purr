// Read-only adapter for the v1 monolith. New saves use persistence/project_files.
use crate::security::LocalCipher;
use serde_json::{json, Value};
use std::{fs, io::Write, path::Path};

fn read_json(path: &Path) -> Result<Value, String> {
    let bytes = fs::read(path).map_err(|_| "Cannot read legacy workspace")?;
    serde_json::from_slice(&bytes).map_err(|_| {
        "Cannot parse legacy workspace. The original file has not been changed.".into()
    })
}
pub fn load_legacy(root: &Path) -> Result<Value, String> {
    if !root.exists() {
        return Ok(json!({ "activeWorkspaceId": "", "workspaces": [] }));
    }
    let mut workspaces = Vec::new();
    for entry in fs::read_dir(root).map_err(|_| "Cannot read legacy workspace directory")? {
        let entry = entry.map_err(|_| "Cannot read legacy workspace directory")?;
        if !entry
            .file_type()
            .map_err(|_| "Cannot read legacy workspace directory")?
            .is_dir()
        {
            continue;
        }
        let path = entry.path().join("workspace.json");
        if path.exists() {
            if fs::symlink_metadata(&path)
                .map_err(|_| "Cannot read legacy workspace")?
                .file_type()
                .is_symlink()
            {
                return Err("Legacy workspace cannot be a symbolic link".into());
            }
            let workspace = read_json(&path)?;
            if workspace["id"].as_str() != entry.file_name().to_str() {
                return Err("Workspace folder and identifier do not match".into());
            }
            workspaces.push(workspace);
        }
    }
    workspaces.sort_by_key(|workspace| workspace["name"].as_str().unwrap_or("").to_lowercase());
    let index = root.join("index.json");
    let active = if index.exists() {
        read_json(&index)?["activeWorkspaceId"].clone()
    } else {
        Value::Null
    };
    Ok(json!({ "activeWorkspaceId": active, "workspaces": workspaces }))
}
// An authenticated archive is verified before any original file is retired.
// A restart after partial retirement accepts only unchanged surviving documents.
pub fn archive_and_retire(
    root: &Path,
    archive: &Path,
    cipher: &LocalCipher,
    expected: &Value,
) -> Result<(), String> {
    if &load_legacy(root)? != expected {
        return Err("Legacy data changed during migration; original files are preserved".into());
    }
    let error =
        || "Cannot verify the encrypted legacy backup; original files are preserved".to_string();
    if !archive.exists() {
        let bytes = cipher.encrypt(
            &serde_json::to_vec(expected).map_err(|_| error())?,
            "purr/legacy-archive",
        )?;
        let mut temporary = tempfile::NamedTempFile::new_in(archive.parent().ok_or_else(error)?)
            .map_err(|_| error())?;
        temporary.write_all(&bytes).map_err(|_| error())?;
        temporary.as_file().sync_all().map_err(|_| error())?;
        temporary.persist_noclobber(archive).map_err(|_| error())?;
        #[cfg(unix)]
        fs::File::open(archive.parent().ok_or_else(error)?)
            .and_then(|file| file.sync_all())
            .map_err(|_| error())?;
    }
    let backup: Value = serde_json::from_slice(&cipher.decrypt(
        &fs::read(archive).map_err(|_| error())?,
        "purr/legacy-archive",
    )?)
    .map_err(|_| error())?;
    let documents = expected["workspaces"].as_array().ok_or_else(error)?;
    let archived = backup["workspaces"].as_array().ok_or_else(error)?;
    if documents
        .iter()
        .any(|document| !archived.contains(document))
    {
        return Err(error());
    }
    if &load_legacy(root)? != expected {
        return Err("Legacy data changed during backup verification; files are preserved".into());
    }
    for document in documents {
        let id = document["id"].as_str().ok_or_else(error)?;
        if id.is_empty()
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        {
            return Err(error());
        }
        let path = root.join(id).join("workspace.json");
        if read_json(&path)? != *document {
            return Err(error());
        }
        fs::remove_file(path).map_err(|_| "Cannot retire archived legacy workspace")?;
    }
    let index = root.join("index.json");
    if index.exists() {
        fs::remove_file(index).map_err(|_| "Cannot retire archived legacy index")?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::{tests::MemoryRootKeyStore, RootCiphers};
    #[test]
    fn legacy_archive_is_authenticated_recoverable_and_retirement_is_restart_safe() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("workspaces");
        fs::create_dir_all(root.join("personal")).unwrap();
        let path = root.join("personal/workspace.json");
        let value = json!({"id":"personal","name":"Legacy","secret":"legacy-credential"});
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let expected = load_legacy(&root).unwrap();
        let cipher = RootCiphers::open(&MemoryRootKeyStore::default(), false, false)
            .unwrap()
            .database;
        let archive = directory.path().join("legacy.encrypted");
        archive_and_retire(&root, &archive, &cipher, &expected).unwrap();
        assert!(!path.exists());
        let encrypted = fs::read(&archive).unwrap();
        assert!(!String::from_utf8_lossy(&encrypted).contains("legacy-credential"));
        let recovered: Value =
            serde_json::from_slice(&cipher.decrypt(&encrypted, "purr/legacy-archive").unwrap())
                .unwrap();
        assert_eq!(recovered, expected);
        // Simulate a restart after only part of the old directory was retired.
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        archive_and_retire(&root, &archive, &cipher, &expected).unwrap();
        // An old app subsequently changing its data is never silently discarded.
        fs::write(
            &path,
            serde_json::to_vec(&json!({"id":"personal","name":"Changed"})).unwrap(),
        )
        .unwrap();
        let changed = load_legacy(&root).unwrap();
        assert!(archive_and_retire(&root, &archive, &cipher, &changed).is_err());
        assert!(path.exists());
        fs::write(&archive, b"corrupt archive").unwrap();
        assert!(archive_and_retire(&root, &archive, &cipher, &changed).is_err());
        assert!(path.exists());
    }
    #[test]
    fn legacy_reader_preserves_source_and_rejects_corruption_without_echoing_values() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("personal")).unwrap();
        let path = root.path().join("personal/workspace.json");
        let value =
            json!({"id":"personal","name":"Personal","documents":[],"environments":[],"ui":{}});
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(load_legacy(root.path()).unwrap()["workspaces"][0], value);
        fs::write(&path, "{ secret-sensitive-value ").unwrap();
        let error = load_legacy(root.path()).unwrap_err();
        assert!(!error.contains("secret-sensitive-value"));
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "{ secret-sensitive-value "
        );
    }
}
