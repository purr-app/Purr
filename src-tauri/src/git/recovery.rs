//! Recovery snapshots stay in the encrypted local store, never in project YAML.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
impl Git {
    async fn tracked_paths(&self) -> Result<Vec<String>> {
        let out = self
            .output(&[
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
            ])
            .await?;
        if !out.success {
            return Err(classify(&out.stderr));
        }
        let mut paths = std::collections::BTreeSet::new();
        for part in out.stdout.split(|b| *b == 0).filter(|p| !p.is_empty()) {
            let path = std::str::from_utf8(part)
                .map_err(|_| GitError::new("unsupported", "Repository paths must use UTF-8."))?;
            self.path(path)?;
            paths.insert(path.to_owned());
        }
        Ok(paths.into_iter().collect())
    }
    async fn fingerprint(&self) -> Result<Value> {
        let mut files = BTreeMap::new();
        for path in self.tracked_paths().await? {
            let target = self.path(&path)?;
            files.insert(
                path,
                match std::fs::read(&target) {
                    Ok(bytes) => {
                        let mut signature = bytes;
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::PermissionsExt;
                            signature.extend_from_slice(
                                &std::fs::metadata(&target)?
                                    .permissions()
                                    .mode()
                                    .to_le_bytes(),
                            );
                        }
                        Some(revision(&signature))
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                    Err(e) => return Err(e.into()),
                },
            );
        }
        let index = self
            .output(&["ls-files", "--stage", "-v", "-z"])
            .await?
            .stdout;
        let head = self.output(&["rev-parse", "--verify", "HEAD"]).await?;
        Ok(json!({"files":files,"index":revision(&index),"head":head.success.then(||head.text())}))
    }
    pub async fn begin_checkpoint(&mut self, kind: &str) -> Result<()> {
        if self.checkpoint.is_some() {
            return Err(GitError::new(
                "conflict",
                "Finish or abort the previous operation first.",
            ));
        }
        let status = self.status().await?;
        let mut backup = BTreeMap::new();
        let mut total = 0;
        let mut modes = BTreeMap::<String, u32>::new();
        for file in &status.files {
            for path in std::iter::once(&file.path).chain(file.old_path.as_ref()) {
                let bytes = match std::fs::read(self.path(path)?) {
                    Ok(bytes) => Some(bytes),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                    Err(e) => return Err(e.into()),
                };
                total += bytes.as_ref().map_or(0, Vec::len);
                if total > 64 * 1024 * 1024 {
                    return Err(GitError::new("git","Uncommitted files exceed the 64 MiB recovery budget. Commit or stash them before continuing."));
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Ok(meta) = std::fs::metadata(self.path(path)?) {
                        modes.insert(path.clone(), meta.permissions().mode());
                    }
                }
                backup.insert(path.clone(), bytes.map(|b| STANDARD.encode(b)));
            }
        }
        let index = std::fs::read(self.root.join(".git/index")).ok();
        let project_files = FilesystemWorkspaceStore {
            directory: self.root.clone(),
        }
        .load()
        .map_err(GitError::from)?;
        let checkpoint = json!({"version":1,"projectFiles":project_files,"kind":kind,"head":status.head,"branch":status.branch,"originalPaths":self.tracked_paths().await?,"backup":backup,"modes":modes,"index":index.map(|b|STANDARD.encode(b)),"before":self.fingerprint().await?});
        self.persist_checkpoint(Some(&checkpoint))?;
        self.checkpoint = Some(checkpoint);
        Ok(())
    }
    fn persist_checkpoint(&self, value: Option<&Value>) -> Result<()> {
        if let Some(journal) = &self.journal {
            journal(value.cloned()).map_err(|_| {
                GitError::new(
                    "git",
                    "Cannot protect the Git recovery checkpoint. No new Git operation was started.",
                )
            })?;
        }
        Ok(())
    }
    pub async fn update_checkpoint(&mut self) -> Result<()> {
        if self.checkpoint.is_some() {
            let after = self.fingerprint().await?;
            if let Some(checkpoint) = self.checkpoint.as_mut() {
                checkpoint["after"] = after;
            }
            self.persist_checkpoint(self.checkpoint.as_ref())?;
        }
        Ok(())
    }
    pub fn clear_checkpoint(&mut self) -> Result<()> {
        self.persist_checkpoint(None)?;
        self.checkpoint = None;
        Ok(())
    }
    pub async fn complete_checkpoint(&mut self, result: Result<()>) -> Result<()> {
        // Cancellation stops the Git child, not the short recovery bookkeeping.
        // Otherwise the cancelled token would prevent recording the new state.
        if self.cancel.is_cancelled() {
            self.cancel = CancellationToken::new();
        }
        match result {
            Ok(()) => self.clear_checkpoint(),
            Err(error) => {
                // A refusal before mutation needs no recovery UI; cancellation and
                // conflicts do, including a stash conflict without MERGE_HEAD.
                let fingerprint = self.fingerprint().await?;
                if self
                    .checkpoint
                    .as_ref()
                    .is_some_and(|c| c["before"] == fingerprint)
                {
                    self.clear_checkpoint()?;
                } else {
                    self.update_checkpoint().await?;
                }
                Err(error)
            }
        }
    }
    pub async fn abort_checkpoint(&mut self) -> Result<()> {
        let Some(checkpoint) = self.checkpoint.clone() else {
            if self.root.join(".git/MERGE_HEAD").exists() {
                self.run(&["merge", "--abort"]).await?;
                return Ok(());
            }
            return Err(GitError::new("git","There is no Purr operation to abort. Finish any external rebase or cherry-pick in your Git client."));
        };
        if checkpoint["version"] != 1 {
            return Err(GitError::new(
                "unsupported",
                "This recovery record requires a newer Purr version.",
            ));
        }
        let current = self.fingerprint().await?;
        if checkpoint.get("after").is_none() || checkpoint["after"] != current {
            return Err(GitError::new("stale","Files changed outside this operation. They are preserved. Resolve or abort with your external Git client, then finish recovery in Purr."));
        }
        let status = self.status().await?;
        if status.branch.as_deref() != checkpoint["branch"].as_str() {
            return Err(GitError::new("stale","The branch changed outside the pending merge. Review it externally before finishing recovery."));
        }
        let head = checkpoint["head"]
            .as_str()
            .ok_or_else(|| GitError::new("git", "The original commit is unavailable."))?;
        let original: std::collections::HashSet<String> =
            serde_json::from_value(checkpoint["originalPaths"].clone())
                .map_err(|_| GitError::new("git", "The recovery record is damaged."))?;
        let added = self
            .tracked_paths()
            .await?
            .into_iter()
            .filter(|p| !original.contains(p))
            .collect::<Vec<_>>();
        // The complete post-operation fingerprint above authorizes restoring
        // precisely our own outputs. External bytes are never discarded.
        self.run(&["reset", "--hard", head]).await?;
        for path in added {
            let target = self.path(&path)?;
            if target.is_file() {
                std::fs::remove_file(target)?;
            }
        }
        let backup = checkpoint["backup"]
            .as_object()
            .ok_or_else(|| GitError::new("git", "The recovery record is damaged."))?;
        for (path, value) in backup {
            let target = self.path(path)?;
            if let Some(content) = value.as_str() {
                let bytes = STANDARD
                    .decode(content)
                    .map_err(|_| GitError::new("git", "The recovery record is damaged."))?;
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(&target, bytes)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Some(mode) = checkpoint["modes"][path].as_u64() {
                        std::fs::set_permissions(
                            &target,
                            std::fs::Permissions::from_mode(mode as u32),
                        )?;
                    }
                }
            } else if target.is_file() {
                std::fs::remove_file(target)?;
            }
        }
        if let Some(index) = checkpoint["index"].as_str() {
            std::fs::write(
                self.root.join(".git/index"),
                STANDARD
                    .decode(index)
                    .map_err(|_| GitError::new("git", "The recovery index is damaged."))?,
            )?;
        }
        self.clear_checkpoint()
    }
}
