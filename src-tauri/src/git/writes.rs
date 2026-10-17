use super::*;
use serde_json::json;

impl Git {
    /// Restore untracked files separately so an identical existing asset does
    /// not make Git report a failed apply after restoring the tracked request.
    async fn restore_stash(&self, id: &str) -> Result<()> {
        let untracked = self
            .output(&["rev-parse", "--verify", &format!("{id}^3")])
            .await?;
        let mut pending = Vec::new();
        let mut total = 0usize;
        let reference = if untracked.success {
            let listing = self
                .output(&["ls-tree", "-rz", "--full-tree", &untracked.text()])
                .await?;
            if !listing.success {
                return Err(classify(&listing.stderr));
            }
            for (path, oid, mode) in parse_tree(&listing.stdout)? {
                if !["100644", "100755"].contains(&mode.as_str()) {
                    return Err(GitError::new(
                        "unsupported",
                        "Stashed symbolic links and submodules are not supported.",
                    ));
                }
                let target = self.path(&path)?;
                let size: usize = self
                    .run(&["cat-file", "-s", &oid])
                    .await?
                    .parse()
                    .map_err(|_| GitError::new("git", "Invalid stash blob size."))?;
                total = total.saturating_add(size);
                if total > 64 * 1024 * 1024 {
                    return Err(GitError::new(
                        "git",
                        "Stashed files exceed the 64 MiB recovery budget.",
                    ));
                }
                let blob = self.output(&["cat-file", "blob", &oid]).await?;
                if !blob.success {
                    return Err(classify(&blob.stderr));
                }
                match std::fs::read(&target) {
                    Ok(existing) if existing == blob.stdout => (),
                    Ok(_) => return Err(GitError::new("dirty", "A stashed file already exists with different contents. Move or save it before applying this stash.")),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => pending.push((path, blob.stdout, mode)),
                    Err(error) => return Err(error.into()),
                }
            }
            let tree = self.run(&["rev-parse", &format!("{id}^{{tree}}")]).await?;
            // A two-parent stash commit applies only tracked/index changes. It
            // creates no refs and leaves the original stash intact until success.
            self.run(&[
                "-c",
                "user.name=Purr",
                "-c",
                "user.email=purr@localhost",
                "commit-tree",
                &tree,
                "-p",
                &format!("{id}^1"),
                "-p",
                &format!("{id}^2"),
                "-m",
                "Restore Purr stash",
            ])
            .await?
        } else {
            id.to_owned()
        };
        let applied = self
            .output(&["stash", "apply", "--index", &reference])
            .await?;
        for (path, bytes, mode) in pending {
            let target = self.path(&path)?;
            std::fs::create_dir_all(
                target
                    .parent()
                    .ok_or_else(|| GitError::new("git", "Invalid stash path."))?,
            )?;
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)?;
            file.write_all(&bytes)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(std::fs::Permissions::from_mode(if mode == "100755" {
                    0o755
                } else {
                    0o644
                }))?;
            }
            #[cfg(not(unix))]
            let _ = mode;
        }
        if applied.success {
            Ok(())
        } else if self
            .status()
            .await?
            .files
            .iter()
            .any(|file| file.conflicted)
        {
            Err(GitError::new(
                "conflict",
                "Stash has conflicts. The stash is preserved until you finish resolving them.",
            ))
        } else {
            Err(classify(&applied.stderr))
        }
    }
    pub async fn execute(&mut self, action: Action) -> Result<()> {
        if matches!(action, Action::Init) {
            self.validate_worktree()?;
            if self
                .output(&["rev-parse", "--show-toplevel"])
                .await?
                .success
            {
                self.repository().await?;
            } else {
                self.run(&["init", "-b", "main"]).await?;
            }
            self.write_ignore()?;
            return Ok(());
        }
        self.repository().await?;
        let status = self.status().await?;
        if status.operation.is_some()
            && !matches!(
                action,
                Action::ResolveConflict { .. } | Action::FinishMerge { .. } | Action::AbortMerge
            )
        {
            return Err(GitError::new(
                "conflict",
                "Finish or abort the current Git operation before starting another one.",
            ));
        }
        if self.checkpoint.is_some()
            && !matches!(
                action,
                Action::ResolveConflict { .. } | Action::FinishMerge { .. } | Action::AbortMerge
            )
        {
            return Err(GitError::new(
                "conflict",
                "Finish or abort the pending recovery before starting another Git operation.",
            ));
        }
        match action {
            Action::Init => unreachable!(),
            Action::Stage { paths } => {
                self.paths(&paths)?;
                let mut args = vec!["add", "--all", "--"];
                args.extend(paths.iter().map(String::as_str));
                self.run(&args).await?;
            }
            Action::Unstage { paths } => {
                self.paths(&paths)?;
                let mut args = if status.head.is_some() {
                    vec!["reset", "-q", "HEAD", "--"]
                } else {
                    vec!["rm", "--cached", "-r", "--ignore-unmatch", "--"]
                };
                args.extend(paths.iter().map(String::as_str));
                self.run(&args).await?;
            }
            Action::Discard { paths } => {
                self.paths(&paths)?;
                let tree = self.run(&["write-tree"]).await?;
                let staged = self.files_at(&tree).await?;
                let mut candidate = FilesystemWorkspaceStore {
                    directory: self.root.clone(),
                }
                .load()
                .map_err(GitError::from)?;
                for path in &paths {
                    if let Some(file) = staged.get(path) {
                        candidate.insert(path.clone(), file.clone());
                    } else {
                        candidate.remove(path);
                    }
                }
                // Refuse removal of an asset/schema still required by another file.
                self.validate_files(&candidate)?;
                self.begin_checkpoint("discard").await?;
                let result = async {
                    for path in &paths {
                        if self
                            .output(&["ls-files", "--error-unmatch", "--", path])
                            .await?
                            .success
                        {
                            self.run(&["restore", "--worktree", "--", path]).await?;
                        } else {
                            let target = self.path(path)?;
                            match std::fs::remove_file(target) {
                                Ok(()) => (),
                                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                                Err(error) => return Err(error.into()),
                            }
                        }
                    }
                    self.validate_worktree()
                }
                .await;
                self.complete_checkpoint(result).await?;
            }
            Action::Commit { message, author } => {
                self.validate_worktree()?;
                Self::message(&message)?;
                let tree = self.run(&["write-tree"]).await?;
                self.validate_files(&self.files_at(&tree).await?)?;
                if let Some(author) = author {
                    if author.name.trim().is_empty()
                        || author.email.trim().is_empty()
                        || author.name.contains(['\n', '\r'])
                        || author.email.contains(['\n', '\r'])
                    {
                        return Err(GitError::new(
                            "author",
                            "Enter your Git author name and email.",
                        ));
                    }
                    self.run(&["config", "--local", "user.name", author.name.trim()])
                        .await?;
                    self.run(&["config", "--local", "user.email", author.email.trim()])
                        .await?;
                }
                self.run(&["commit", "-m", &message]).await?;
            }
            Action::CreateBranch { name } => {
                self.validate_worktree()?;
                self.branch_name(&name).await?;
                if status.head.is_none() {
                    return Err(GitError::new(
                        "git",
                        "Create the first commit before adding another branch.",
                    ));
                }
                self.run(&["branch", &name]).await?;
            }
            Action::SwitchBranch { name, allow_dirty } => {
                self.validate_worktree()?;
                let target = self.resolve_branch(&name, &status).await?;
                self.validate_target(&target).await?;
                if !status.files.is_empty() && !allow_dirty {
                    return Err(dirty());
                }
                self.begin_checkpoint("switch").await?;
                let result = if name.starts_with("refs/") {
                    Err(GitError::new(
                        "git",
                        "Select a branch from the branch list.",
                    ))
                } else if status.branches.iter().any(|b| !b.remote && b.name == name) {
                    self.run(&["switch", "--no-overwrite-ignore", &name])
                        .await
                        .map(|_| ())
                } else {
                    self.run(&["switch", "--no-overwrite-ignore", "--track", &name])
                        .await
                        .map(|_| ())
                };
                self.complete_checkpoint(result).await?;
            }
            Action::SetRemote { name, url } => {
                self.validate_worktree()?;
                remote_name(&name)?;
                validate_url(&url)?;
                self.inspect_url(&url).await?;
                if status.remotes.iter().any(|r| r.name == name) {
                    self.run(&["remote", "set-url", &name, &url]).await?;
                } else {
                    self.run(&["remote", "add", &name, &url]).await?;
                }
            }
            Action::RemoveRemote { name } => {
                remote_name(&name)?;
                self.run(&["remote", "remove", &name]).await?;
            }
            Action::Fetch { remote, branch } => {
                let (remote, branch) = self.remote_branch(&status, remote, branch).await?;
                self.fetch(&remote, branch.as_deref()).await?;
            }
            Action::Push { remote, branch } => {
                self.validate_worktree()?;
                let (remote, branch) = self.remote_branch(&status, remote, branch).await?;
                let branch = branch.or(status.branch.clone()).ok_or_else(|| {
                    GitError::new("git", "Create or select a local branch before pushing.")
                })?;
                self.branch_name(&branch).await?;
                self.verify_remote(&remote, &branch).await?;
                let source = status.branch.ok_or_else(|| {
                    GitError::new("git", "Create a branch before pushing from detached HEAD.")
                })?;
                self.run(&[
                    "push",
                    "--set-upstream",
                    &remote,
                    &format!("refs/heads/{source}:refs/heads/{branch}"),
                ])
                .await?;
            }
            Action::Pull {
                remote,
                branch,
                allow_dirty,
            } => {
                self.validate_worktree()?;
                if status.branch.is_none() {
                    return Err(GitError::new(
                        "git",
                        "Select a local branch before pulling.",
                    ));
                }
                let (remote, branch) = self.remote_branch(&status, remote, branch).await?;
                let branch = branch
                    .or(status.branch.clone())
                    .ok_or_else(|| GitError::new("git", "Choose a remote branch."))?;
                let target = self.fetch(&remote, Some(&branch)).await?.ok_or_else(|| {
                    GitError::new("git", "The selected remote branch does not exist.")
                })?;
                self.validate_target(&target).await?;
                if !status.files.is_empty() && !allow_dirty {
                    return Err(dirty());
                }
                // Compute the merged project before changing either index or worktree.
                let candidate = self
                    .output(&["merge-tree", "--write-tree", "HEAD", &target])
                    .await?;
                if candidate.success {
                    let tree = candidate.text().lines().next().unwrap_or("").to_string();
                    self.validate_files(&self.files_at(&tree).await?)?;
                }
                self.begin_checkpoint("merge").await?;
                let out = self
                    .output(&[
                        "merge",
                        "--no-overwrite-ignore",
                        "--ff",
                        "--no-edit",
                        "--no-commit",
                        &target,
                    ])
                    .await;
                let result = async {
                    match out {
                        Ok(out) if out.success => {
                            if self.root.join(".git/MERGE_HEAD").exists() {
                                let tree = self.run(&["write-tree"]).await?;
                                self.validate_files(&self.files_at(&tree).await?)?;
                                self.run(&["commit", "--no-edit"]).await.map(|_| ())
                            } else {
                                Ok(())
                            }
                        }
                        Ok(out) => {
                            if self.status().await?.files.iter().any(|f| f.conflicted) {
                                Err(GitError::new(
                                "conflict",
                                "Pull has merge conflicts. Resolve the files or abort the merge.",
                            ))
                            } else {
                                Err(classify(&out.stderr))
                            }
                        }
                        Err(error) => Err(error),
                    }
                }
                .await;
                self.complete_checkpoint(result).await?;
            }
            Action::Stash { message } => {
                self.validate_worktree()?;
                if status.head.is_none() {
                    return Err(GitError::new(
                        "git",
                        "Create a first commit before stashing.",
                    ));
                }
                // Stash uses directory pathspecs internally to clean untracked files.
                // Literal mode leaves new directories on disk (Git 2.50); this
                // command takes no user-supplied paths, so let Git expand its own.
                self.run(&[
                    "--no-literal-pathspecs",
                    "stash",
                    "push",
                    "--include-untracked",
                    "--message",
                    &format!(
                        "Purr [{}]: {}",
                        status.branch.as_deref().unwrap_or("detached"),
                        message.trim()
                    ),
                ])
                .await?;
            }
            Action::ApplyStash { id } => {
                self.validate_worktree()?;
                self.stash_ref(&id).await?;
                self.begin_checkpoint("stash").await?;
                let result = async {
                    self.restore_stash(&id).await?;
                    self.validate_worktree()?;
                    let reference = self.stash_ref(&id).await?;
                    self.run(&["stash", "drop", &reference]).await.map(|_| ())
                }
                .await;
                if let Some(checkpoint) = self.checkpoint.as_mut() {
                    checkpoint["stashId"] = json!(id);
                }
                self.complete_checkpoint(result).await?;
            }
            Action::DropStash { id } => {
                let reference = self.stash_ref(&id).await?;
                self.run(&["stash", "drop", &reference]).await?;
            }
            Action::ResolveConflict {
                path,
                content,
                side,
                revision: expected,
            } => {
                if status
                    .operation
                    .as_deref()
                    .is_some_and(|operation| operation != "merge")
                {
                    return Err(GitError::new(
                        "unsupported",
                        "Resolve this operation in your external Git client.",
                    ));
                }
                if !status.files.iter().any(|f| f.path == path && f.conflicted) {
                    return Err(GitError::new(
                        "stale",
                        "This file is no longer conflicted. Refresh the changes.",
                    ));
                }
                let target = self.path(&path)?;
                let current = std::fs::read(&target).unwrap_or_default();
                if revision(&current) != expected {
                    return Err(GitError::new(
                        "stale",
                        "The conflict file changed. Refresh before resolving it.",
                    ));
                }
                let bytes = if let Some(side) = side {
                    let stage = match side.as_str() {
                        "local" => "2",
                        "incoming" => "3",
                        _ => return Err(GitError::new("git", "Invalid conflict side.")),
                    };
                    let out = self
                        .output(&["cat-file", "blob", &format!(":{stage}:{path}")])
                        .await?;
                    out.success.then_some(out.stdout)
                } else {
                    content.map(String::into_bytes)
                };
                if let Some(bytes) = bytes {
                    let parent = target
                        .parent()
                        .ok_or_else(|| GitError::new("git", "Invalid path."))?;
                    std::fs::create_dir_all(parent)?;
                    let mut file = tempfile::NamedTempFile::new_in(parent)?;
                    if let Ok(metadata) = std::fs::metadata(&target) {
                        file.as_file().set_permissions(metadata.permissions())?;
                    }
                    use std::io::Write;
                    file.write_all(&bytes)?;
                    file.persist(&target)
                        .map_err(|_| GitError::new("git", "Cannot save conflict resolution."))?;
                    self.run(&["add", "--", &path]).await?;
                } else {
                    if target.exists() {
                        std::fs::remove_file(&target)?;
                    }
                    self.run(&["add", "--all", "--", &path]).await?;
                }
                self.update_checkpoint().await?;
            }
            Action::FinishMerge { message } => {
                if status.files.iter().any(|f| f.conflicted) {
                    return Err(GitError::new(
                        "conflict",
                        "Resolve every conflict before finishing.",
                    ));
                }
                self.validate_worktree()?;
                if status.operation.as_deref() == Some("merge") {
                    // Only a merge commit needs a complete canonical index. A stash
                    // intentionally restores staged and unstaged files separately.
                    let tree = self.run(&["write-tree"]).await?;
                    self.validate_files(&self.files_at(&tree).await?)?;
                    Self::message(&message)?;
                    self.run(&["commit", "-m", &message]).await?;
                } else if self.checkpoint.as_ref().and_then(|c| c["kind"].as_str()) == Some("stash")
                {
                    if let Some(id) = self
                        .checkpoint
                        .as_ref()
                        .and_then(|c| c["stashId"].as_str())
                        .map(str::to_owned)
                    {
                        let reference = self.stash_ref(&id).await?;
                        self.run(&["stash", "drop", &reference]).await?;
                    }
                } else if status.operation.is_some() {
                    return Err(GitError::new(
                        "unsupported",
                        "Finish this rebase/cherry-pick operation in your external Git client.",
                    ));
                }
                self.clear_checkpoint()?;
            }
            Action::AbortMerge => {
                self.abort_checkpoint().await?;
            }
        }
        Ok(())
    }
    fn paths(&self, paths: &[String]) -> Result<()> {
        if paths.is_empty() {
            return Err(GitError::new("git", "Select one or more files."));
        }
        for path in paths {
            self.path(path)?;
        }
        Ok(())
    }
    fn message(message: &str) -> Result<()> {
        if message.trim().is_empty() || message.contains('\0') {
            Err(GitError::new("git", "Enter a commit message."))
        } else {
            Ok(())
        }
    }
    async fn branch_name(&self, name: &str) -> Result<()> {
        if name.starts_with('-')
            || name.contains(['\0', '\n', '\r'])
            || !self
                .output(&["check-ref-format", "--branch", name])
                .await?
                .success
        {
            Err(GitError::new("git", "Enter a valid Git branch name."))
        } else {
            Ok(())
        }
    }
    async fn resolve_branch(&self, name: &str, status: &Status) -> Result<String> {
        let branch = status
            .branches
            .iter()
            .find(|b| b.name == name)
            .ok_or_else(|| GitError::new("stale", "This branch is no longer available."))?;
        let reference = format!(
            "refs/{}/{}",
            if branch.remote { "remotes" } else { "heads" },
            branch.name
        );
        self.run(&["rev-parse", "--verify", &reference]).await
    }
    async fn validate_target(&self, reference: &str) -> Result<()> {
        self.validate_files(&self.files_at(reference).await?)?;
        if !self
            .output(&["rev-parse", "--verify", "HEAD"])
            .await?
            .success
            || !self
                .output(&["merge-base", "HEAD", reference])
                .await?
                .success
        {
            return Err(GitError::new(
                "unrelated",
                "This repository has unrelated history. Clone it as a separate workspace instead.",
            ));
        }
        Ok(())
    }
    async fn remote_branch(
        &self,
        status: &Status,
        remote: Option<String>,
        branch: Option<String>,
    ) -> Result<(String, Option<String>)> {
        let upstream = status.upstream.as_deref().and_then(|s| s.split_once('/'));
        let remote = remote
            .or_else(|| upstream.map(|(r, _)| r.into()))
            .or_else(|| {
                status
                    .remotes
                    .iter()
                    .find(|r| r.name == "origin")
                    .or_else(|| status.remotes.first())
                    .map(|r| r.name.clone())
            })
            .ok_or_else(|| GitError::new("git", "Add a remote repository first."))?;
        remote_name(&remote)?;
        if !status.remotes.iter().any(|r| r.name == remote) {
            return Err(GitError::new("git", "Select a configured remote."));
        }
        let branch = branch.or_else(|| {
            upstream
                .filter(|(r, _)| *r == remote)
                .map(|(_, b)| b.into())
        });
        if let Some(b) = &branch {
            self.branch_name(b).await?;
        }
        Ok((remote, branch))
    }
    async fn inspect_url(&self, url: &str) -> Result<()> {
        let out = self.output(&["ls-remote", "--refs", url]).await?;
        if !out.success {
            return Err(classify(&out.stderr));
        }
        if out.stdout.is_empty() {
            return Ok(());
        }
        self.run(&["fetch", "--no-tags", "--", url, "HEAD"]).await?;
        let target = self.run(&["rev-parse", "FETCH_HEAD"]).await?;
        self.validate_target(&target).await?;
        if !self
            .output(&["rev-parse", "--verify", "HEAD"])
            .await?
            .success
        {
            return Err(GitError::new("unrelated","Create local history only for an empty remote. Clone this existing workspace instead."));
        }
        Ok(())
    }
    async fn verify_remote(&self, remote: &str, branch: &str) -> Result<()> {
        let out = self.output(&["ls-remote", "--refs", remote]).await?;
        if !out.success {
            return Err(classify(&out.stderr));
        }
        if out.stdout.is_empty() {
            return Ok(());
        }
        let url = self.run(&["remote", "get-url", remote]).await?;
        self.inspect_url(&url).await?;
        let target_name = format!("refs/heads/{branch}");
        if out.text().lines().any(|line| {
            line.split_once('\t')
                .is_some_and(|(_, name)| name == target_name)
        }) {
            if let Some(target) = self.fetch(remote, Some(branch)).await? {
                self.validate_target(&target).await?;
            }
        }
        Ok(())
    }
    async fn fetch(&self, remote: &str, branch: Option<&str>) -> Result<Option<String>> {
        if let Some(branch) = branch {
            let refspec = format!("+refs/heads/{branch}:refs/remotes/{remote}/{branch}");
            let out = self
                .output(&["fetch", "--no-tags", remote, &refspec])
                .await?;
            if !out.success {
                return Err(classify(&out.stderr));
            }
            let target = self
                .run(&[
                    "rev-parse",
                    "--verify",
                    &format!("refs/remotes/{remote}/{branch}"),
                ])
                .await?;
            self.validate_target(&target).await?;
            Ok(Some(target))
        } else {
            self.run(&["fetch", "--prune", "--no-tags", remote]).await?;
            Ok(None)
        }
    }
    async fn stash_ref(&self, id: &str) -> Result<String> {
        let list = self.run(&["stash", "list", "--format=%H%x00%gd"]).await?;
        list.lines()
            .filter_map(|line| line.split_once('\0'))
            .find(|(oid, _)| *oid == id)
            .map(|(_, reference)| reference.to_string())
            .ok_or_else(|| GitError::new("stale", "This stash is no longer available."))
    }
    fn write_ignore(&self) -> Result<()> {
        let path = self.path(".gitignore")?;
        let mut content = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.into()),
        };
        let rules = [
            ".DS_Store",
            "._*",
            "Thumbs.db",
            "Desktop.ini",
            "*.swp",
            "*.swo",
            "*~",
            "*.purrsecrets",
        ];
        let missing: Vec<_> = rules
            .into_iter()
            .filter(|rule| !content.lines().any(|l| l.trim() == *rule))
            .collect();
        if !missing.is_empty() {
            if !content.is_empty() && !content.ends_with('\n') {
                content.push('\n');
            }
            content.push_str("\n# Purr: local system and editor files\n");
            content.push_str(&missing.join("\n"));
            content.push('\n');
            std::fs::write(path, content)?;
        }
        Ok(())
    }
}
fn dirty() -> GitError {
    GitError::new("dirty","There are uncommitted changes. Commit or stash them, or continue if Git can preserve them.")
}
fn remote_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.starts_with('-')
        || name.len() > 128
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        Err(GitError::new(
            "git",
            "Use letters, numbers, underscores or hyphens for the remote name.",
        ))
    } else {
        Ok(())
    }
}
