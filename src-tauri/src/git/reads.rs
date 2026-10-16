use super::*;
impl Git {
    pub async fn status(&self) -> Result<Status> {
        let version = self.run(&["--version"]).await?;
        let parts: Vec<_> = version
            .trim_start_matches("git version ")
            .split('.')
            .collect();
        let major = parts
            .first()
            .and_then(|part| part.parse::<u32>().ok())
            .unwrap_or(0);
        let minor = parts
            .get(1)
            .and_then(|part| part.parse::<u32>().ok())
            .unwrap_or(0);
        if major < 2 || major == 2 && minor < 38 {
            return Err(GitError::new(
                "unavailable",
                "Git 2.38 or newer is required. Update Git and restart Purr.",
            ));
        }
        let mut status = Status {
            directory: self.root.to_string_lossy().into(),
            initialized: false,
            version,
            branch: None,
            head: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            files: vec![],
            branches: vec![],
            remotes: vec![],
            operation: None,
            last_fetched: None,
            recovery: self.checkpoint.is_some(),
        };
        if !self.root.join(".git").exists() {
            if self
                .output(&["rev-parse", "--show-toplevel"])
                .await?
                .success
            {
                self.repository().await?;
            }
            return Ok(status);
        }
        self.repository().await?;
        status.initialized = true;
        let raw = self
            .output(&[
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
            ])
            .await?;
        if !raw.success {
            return Err(classify(&raw.stderr));
        }
        parse_status(&raw.stdout, &mut status)?;
        let branches = self
            .run(&[
                "for-each-ref",
                "--format=%(refname)%09%(HEAD)%09%(upstream:short)",
                "refs/heads",
                "refs/remotes",
            ])
            .await?;
        for line in branches.lines() {
            let parts: Vec<_> = line.split('\t').collect();
            if parts.len() < 3 || parts[0].ends_with("/HEAD") {
                continue;
            }
            let remote = parts[0].starts_with("refs/remotes/");
            status.branches.push(Branch {
                name: parts[0]
                    .trim_start_matches(if remote {
                        "refs/remotes/"
                    } else {
                        "refs/heads/"
                    })
                    .into(),
                remote,
                current: parts[1] == "*",
                upstream: (!parts[2].is_empty()).then(|| parts[2].into()),
            });
        }
        for name in self.run(&["remote"]).await?.lines() {
            status.remotes.push(Remote {
                name: name.into(),
                url: sanitize(&self.run(&["remote", "get-url", name]).await?),
            });
        }
        for (path, operation) in [
            ("MERGE_HEAD", "merge"),
            ("rebase-merge", "rebase"),
            ("rebase-apply", "rebase"),
            ("CHERRY_PICK_HEAD", "cherry-pick"),
            ("REVERT_HEAD", "revert"),
        ] {
            if self.root.join(".git").join(path).exists() {
                status.operation = Some(operation.into());
                break;
            }
        }
        status.last_fetched = std::fs::metadata(self.root.join(".git/FETCH_HEAD"))
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        Ok(status)
    }
    async fn blob_preview(&self, reference: &str) -> Result<(Vec<u8>, usize)> {
        let size = self.output(&["cat-file", "-s", reference]).await?;
        if !size.success {
            return Ok((vec![], 0));
        }
        let length = size
            .text()
            .parse::<usize>()
            .map_err(|_| GitError::new("git", "Invalid Git blob size."))?;
        if length > 1024 * 1024 {
            return Ok((vec![], length));
        }
        let out = self.output(&["cat-file", "blob", reference]).await?;
        if !out.success {
            return Err(classify(&out.stderr));
        }
        Ok((out.stdout, length))
    }
    pub async fn diff(&self, request: DiffRequest) -> Result<Diff> {
        self.repository().await?;
        let path = self.path(&request.path)?;
        let old = request.old_path.as_deref().unwrap_or(&request.path);
        self.path(old)?;
        let (before, after) = match request.scope.as_str() {
            "working" => {
                let before = self.blob_preview(&format!(":{}", request.path)).await?;
                let after = match std::fs::File::open(path) {
                    Ok(file) => {
                        use std::io::Read;
                        let length = file.metadata()?.len() as usize;
                        if length > 1024 * 1024 {
                            (vec![], length)
                        } else {
                            let mut bytes = vec![];
                            file.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
                            let actual = bytes.len();
                            (bytes, actual)
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => (vec![], 0),
                    Err(error) => return Err(error.into()),
                };
                (before, after)
            }
            "staged" => (
                self.blob_preview(&format!("HEAD:{old}")).await?,
                self.blob_preview(&format!(":{}", request.path)).await?,
            ),
            "commit" => {
                let commit = request
                    .commit
                    .ok_or_else(|| GitError::new("git", "Select a commit."))?;
                validate_oid(&commit)?;
                let parent = self
                    .output(&["rev-parse", "--verify", &format!("{commit}^1")])
                    .await?;
                (
                    if parent.success {
                        self.blob_preview(&format!("{}:{old}", parent.text()))
                            .await?
                    } else {
                        (vec![], 0)
                    },
                    self.blob_preview(&format!("{commit}:{}", request.path))
                        .await?,
                )
            }
            _ => return Err(GitError::new("git", "Invalid diff scope.")),
        };
        let truncated = before.1 > 1024 * 1024 || after.1 > 1024 * 1024;
        let binary = before.0.contains(&0)
            || after.0.contains(&0)
            || std::str::from_utf8(&before.0).is_err()
            || std::str::from_utf8(&after.0).is_err();
        Ok(Diff {
            path: request.path,
            before_bytes: before.1,
            after_bytes: after.1,
            before: if binary || truncated {
                String::new()
            } else {
                String::from_utf8_lossy(&before.0).into()
            },
            after: if binary || truncated {
                String::new()
            } else {
                String::from_utf8_lossy(&after.0).into()
            },
            binary,
            truncated,
        })
    }
    pub async fn history(&self, before: usize, path: Option<String>) -> Result<Vec<Commit>> {
        self.repository().await?;
        if !self
            .output(&["rev-parse", "--verify", "HEAD"])
            .await?
            .success
        {
            return Ok(vec![]);
        }
        let skip = before.to_string();
        let mut args = vec![
            "log",
            "--max-count=50",
            "--skip",
            &skip,
            "--format=%H%x00%h%x00%s%x00%an%x00%at%x00",
        ];
        if let Some(path) = path.as_ref() {
            self.path(path)?;
            args.extend(["--", path]);
        }
        let output = self.run(&args).await?;
        let fields: Vec<_> = output.split('\0').collect();
        Ok(fields
            .chunks(5)
            .filter(|p| p.len() == 5)
            .map(|p| Commit {
                id: p[0].trim().into(),
                short_id: p[1].into(),
                message: p[2].into(),
                author: p[3].into(),
                timestamp: p[4].parse::<u64>().unwrap_or(0) * 1000,
            })
            .collect())
    }
    pub async fn commit_files(&self, commit: &str) -> Result<Vec<FileStatus>> {
        validate_oid(commit)?;
        self.repository().await?;
        let out = self
            .output(&[
                "diff-tree",
                "--diff-merges=first-parent",
                "--root",
                "--no-commit-id",
                "--name-status",
                "-r",
                "-M",
                "-z",
                commit,
            ])
            .await?;
        if !out.success {
            return Err(classify(&out.stderr));
        }
        let mut parts = out.stdout.split(|b| *b == 0).filter(|p| !p.is_empty());
        let mut files = vec![];
        while let Some(kind) = parts.next() {
            let first = parts
                .next()
                .ok_or_else(|| GitError::new("git", "Invalid change list."))?;
            let renamed = kind[0] == b'R' || kind[0] == b'C';
            let path = if renamed {
                parts
                    .next()
                    .ok_or_else(|| GitError::new("git", "Invalid rename."))?
            } else {
                first
            };
            files.push(FileStatus {
                path: String::from_utf8_lossy(path).into(),
                old_path: renamed.then(|| String::from_utf8_lossy(first).into()),
                index: String::from_utf8_lossy(&kind[..1]).into(),
                worktree: ".".into(),
                conflicted: false,
            });
        }
        Ok(files)
    }
    pub async fn stashes(&self) -> Result<Vec<Stash>> {
        let out = self.run(&["stash", "list", "--format=%H%x00%s"]).await?;
        Ok(out
            .lines()
            .filter_map(|line| {
                let (id, message) = line.split_once('\0')?;
                Some(Stash {
                    id: id.into(),
                    message: message.into(),
                })
            })
            .collect())
    }
    pub async fn conflicts(&self) -> Result<Vec<Conflict>> {
        let status = self.status().await?;
        let mut result = vec![];
        for file in status.files.iter().filter(|f| f.conflicted) {
            let mut binary = false;
            let mut sides = vec![];
            for n in 1..=3 {
                let reference = format!(":{n}:{}", file.path);
                let size = self.output(&["cat-file", "-s", &reference]).await?;
                if size.success && size.text().parse::<usize>().unwrap_or(usize::MAX) > 1024 * 1024
                {
                    binary = true;
                    sides.push(None);
                    continue;
                }
                let out = self
                    .output(&["cat-file", "blob", &format!(":{n}:{}", file.path)])
                    .await?;
                let content = if !out.success {
                    None
                } else {
                    binary |= out.stdout.contains(&0) || std::str::from_utf8(&out.stdout).is_err();
                    Some(String::from_utf8_lossy(&out.stdout).into_owned())
                };
                sides.push(content);
            }
            let bytes = std::fs::read(self.path(&file.path)?).unwrap_or_default();
            result.push(Conflict {
                path: file.path.clone(),
                base: if binary { None } else { sides[0].clone() },
                local: if binary { None } else { sides[1].clone() },
                incoming: if binary { None } else { sides[2].clone() },
                binary,
                revision: revision(&bytes),
            });
        }
        Ok(result)
    }
}
fn validate_oid(value: &str) -> Result<()> {
    if !(7..=64).contains(&value.len()) || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        Err(GitError::new("git", "Invalid commit identifier."))
    } else {
        Ok(())
    }
}
fn parse_status(bytes: &[u8], status: &mut Status) -> Result<()> {
    let mut records = bytes.split(|b| *b == 0).filter(|p| !p.is_empty());
    while let Some(record) = records.next() {
        let text = std::str::from_utf8(record)
            .map_err(|_| GitError::new("unsupported", "Repository paths must use UTF-8."))?;
        if let Some(value) = text.strip_prefix("# branch.oid ") {
            if value != "(initial)" {
                status.head = Some(value.into());
            }
        } else if let Some(value) = text.strip_prefix("# branch.head ") {
            if value != "(detached)" {
                status.branch = Some(value.into());
            }
        } else if let Some(value) = text.strip_prefix("# branch.upstream ") {
            status.upstream = Some(value.into());
        } else if let Some(value) = text.strip_prefix("# branch.ab ") {
            let p: Vec<_> = value.split(' ').collect();
            if p.len() == 2 {
                status.ahead = p[0].trim_start_matches('+').parse().unwrap_or(0);
                status.behind = p[1].trim_start_matches('-').parse().unwrap_or(0);
            }
        } else if text.starts_with("? ") {
            status.files.push(FileStatus {
                path: text[2..].into(),
                old_path: None,
                index: "?".into(),
                worktree: "?".into(),
                conflicted: false,
            });
        } else if matches!(text.as_bytes().first(), Some(b'1' | b'2' | b'u')) {
            let kind = text.as_bytes()[0];
            let p: Vec<_> = text
                .splitn(
                    if kind == b'1' {
                        9
                    } else if kind == b'2' {
                        10
                    } else {
                        11
                    },
                    ' ',
                )
                .collect();
            let xy = p.get(1).unwrap_or(&"..").as_bytes();
            if xy.len() != 2 {
                return Err(GitError::new("git", "Invalid Git status."));
            }
            let old_path = if kind == b'2' {
                records
                    .next()
                    .map(|s| String::from_utf8_lossy(s).into_owned())
            } else {
                None
            };
            status.files.push(FileStatus {
                path: p.last().unwrap_or(&"").to_string(),
                old_path,
                index: (xy[0] as char).to_string(),
                worktree: (xy[1] as char).to_string(),
                conflicted: kind == b'u',
            });
        }
    }
    Ok(())
}
