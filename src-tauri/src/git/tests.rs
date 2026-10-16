use super::*;
#[test]
fn rejects_unsafe_urls_and_paths() {
    for url in [
        "-u",
        "https://token@github.com/a/b",
        "https://github.com/a/b?token=secret",
        "file:///tmp/a",
        "ext::sh -c bad",
    ] {
        assert!(validate_url(url).is_err(), "{url}");
    }
    for url in [
        "https://github.com/a/b.git",
        "git@github.com:a/b.git",
        "ssh://git@github.com/a/b",
    ] {
        validate_url(url).unwrap();
    }
    let git = Git::new(PathBuf::from("/tmp"), "workspace".into());
    for path in [
        "../secret",
        "/secret",
        ".git/config",
        "a/../../secret",
        "a\\b",
        "a/.git/index",
    ] {
        assert!(git.path(path).is_err(), "{path}");
    }
    assert_eq!(
        sanitize("https://my-token@example.com/repo"),
        "https://[redacted]@example.com/repo"
    );
}
fn command(root: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .current_dir(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Purr Fixture")
        .env("GIT_AUTHOR_EMAIL", "purr@example.test")
        .env("GIT_COMMITTER_NAME", "Purr Fixture")
        .env("GIT_COMMITTER_EMAIL", "purr@example.test")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().into()
}
fn repo() -> (tempfile::TempDir, Git) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    std::fs::create_dir(&root).unwrap();
    command(&root, &["init", "-b", "main"]);
    command(&root, &["config", "user.name", "Purr Fixture"]);
    command(&root, &["config", "user.email", "purr@example.test"]);
    std::fs::write(
        root.join("purr.yaml"),
        "purr: 2\nworkspace:\n  id: fixture\n  name: Fixture\n",
    )
    .unwrap();
    command(&root, &["add", "purr.yaml"]);
    command(&root, &["commit", "-m", "Initial"]);
    let git = Git::new(std::fs::canonicalize(&root).unwrap(), "fixture".into());
    (dir, git)
}
#[tokio::test]
async fn reads_real_index_worktree_renames_and_history() {
    let (_dir, git) = repo();
    let initial = git.status().await.unwrap();
    assert_eq!(initial.branch.as_deref(), Some("main"));
    assert!(initial.files.is_empty());
    std::fs::write(git.root.join("file with space.yaml"), "before\n").unwrap();
    command(&git.root, &["add", "."]);
    command(&git.root, &["commit", "-m", "Add a file"]);
    command(
        &git.root,
        &["mv", "file with space.yaml", "renamed file.yaml"],
    );
    std::fs::write(git.root.join("renamed file.yaml"), "after\n").unwrap();
    let state = git.status().await.unwrap();
    let file = &state.files[0];
    assert_eq!(file.path, "renamed file.yaml");
    assert_eq!(file.old_path.as_deref(), Some("file with space.yaml"));
    assert_eq!(file.index, "R");
    assert_eq!(file.worktree, "M");
    let diff = git
        .diff(DiffRequest {
            path: file.path.clone(),
            old_path: None,
            scope: "working".into(),
            commit: None,
        })
        .await
        .unwrap();
    assert_eq!(diff.before, "before\n");
    assert_eq!(diff.after, "after\n");
    let history = git.history(0, None).await.unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].message, "Add a file");
    assert_eq!(
        git.commit_files(&history[0].id).await.unwrap()[0].path,
        "file with space.yaml"
    );
    git.validate_worktree().unwrap();
}
#[tokio::test]
async fn refuses_containing_repositories_and_symlink_paths() {
    let (_dir, git) = repo();
    std::fs::create_dir(git.root.join("nested")).unwrap();
    let nested = Git::new(git.root.join("nested"), "fixture".into());
    assert_eq!(nested.status().await.unwrap_err().code, "unsupported");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("/tmp", git.root.join("link")).unwrap();
        assert!(git.path("link/secret").is_err());
    }
}
#[tokio::test]
async fn commits_only_the_index_and_initializes_ignore_without_losing_rules() {
    let (_dir, mut git) = repo();
    std::fs::write(git.root.join(".gitignore"), "custom\n").unwrap();
    git.execute(Action::Init).await.unwrap();
    let ignore = std::fs::read_to_string(git.root.join(".gitignore")).unwrap();
    assert!(ignore.starts_with("custom\n"));
    assert!(ignore.contains(".DS_Store"));
    assert!(!ignore.contains("*.yaml"));
    std::fs::write(git.root.join("notes.txt"), "staged\n").unwrap();
    git.execute(Action::Stage {
        paths: vec!["notes.txt".into()],
    })
    .await
    .unwrap();
    std::fs::write(git.root.join("notes.txt"), "working\n").unwrap();
    git.execute(Action::Commit {
        message: "Stage snapshot".into(),
        author: None,
    })
    .await
    .unwrap();
    assert_eq!(command(&git.root, &["show", "HEAD:notes.txt"]), "staged");
    assert_eq!(
        std::fs::read_to_string(git.root.join("notes.txt")).unwrap(),
        "working\n"
    );
}
fn peers() -> (tempfile::TempDir, Git, Git) {
    let (dir, first) = repo();
    let remote = dir.path().join("remote.git");
    command(
        &first.root,
        &["init", "--bare", "-b", "main", remote.to_str().unwrap()],
    );
    command(
        &first.root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    command(&first.root, &["push", "-u", "origin", "main"]);
    let peer = dir.path().join("peer");
    command(
        &first.root,
        &["clone", remote.to_str().unwrap(), peer.to_str().unwrap()],
    );
    command(&peer, &["config", "user.name", "Purr Fixture"]);
    command(&peer, &["config", "user.email", "purr@example.test"]);
    (
        dir,
        first,
        Git::new(std::fs::canonicalize(peer).unwrap(), "fixture".into()),
    )
}
fn rename_workspace(git: &Git, name: &str) {
    std::fs::write(
        git.root.join("purr.yaml"),
        format!("purr: 2\nworkspace:\n  id: fixture\n  name: {name}\n"),
    )
    .unwrap();
    command(&git.root, &["add", "purr.yaml"]);
    command(&git.root, &["commit", "-m", name]);
}
#[tokio::test]
async fn pulls_fast_forward_and_blocks_other_workspace_identity() {
    let (_dir, mut first, mut peer) = peers();
    rename_workspace(&peer, "Incoming");
    peer.execute(Action::Push {
        remote: None,
        branch: None,
    })
    .await
    .unwrap();
    first
        .execute(Action::Pull {
            remote: None,
            branch: None,
            allow_dirty: false,
        })
        .await
        .unwrap();
    assert!(std::fs::read_to_string(first.root.join("purr.yaml"))
        .unwrap()
        .contains("Incoming"));
    let before = first.status().await.unwrap().head;
    std::fs::write(
        peer.root.join("purr.yaml"),
        "purr: 2\nworkspace:\n  id: other\n  name: Other\n",
    )
    .unwrap();
    command(&peer.root, &["add", "purr.yaml"]);
    command(&peer.root, &["commit", "-m", "Replace identity"]);
    command(&peer.root, &["push"]);
    assert_eq!(
        first
            .execute(Action::Pull {
                remote: None,
                branch: None,
                allow_dirty: false
            })
            .await
            .unwrap_err()
            .code,
        "identity"
    );
    assert_eq!(first.status().await.unwrap().head, before);
}
#[tokio::test]
async fn merge_conflicts_resolve_and_abort_preserves_preexisting_bytes() {
    let (_dir, mut first, mut peer) = peers();
    rename_workspace(&first, "Local");
    rename_workspace(&peer, "Remote");
    peer.execute(Action::Push {
        remote: None,
        branch: None,
    })
    .await
    .unwrap();
    std::fs::write(first.root.join("untracked.txt"), "keep me").unwrap();
    assert_eq!(
        first
            .execute(Action::Pull {
                remote: None,
                branch: None,
                allow_dirty: false
            })
            .await
            .unwrap_err()
            .code,
        "dirty"
    );
    assert_eq!(
        first
            .execute(Action::Pull {
                remote: None,
                branch: None,
                allow_dirty: true
            })
            .await
            .unwrap_err()
            .code,
        "conflict"
    );
    let conflicts = first.conflicts().await.unwrap();
    assert_eq!(conflicts.len(), 1);
    assert!(conflicts[0].local.as_deref().unwrap().contains("Local"));
    assert!(conflicts[0].incoming.as_deref().unwrap().contains("Remote"));
    first.execute(Action::AbortMerge).await.unwrap();
    assert!(std::fs::read_to_string(first.root.join("purr.yaml"))
        .unwrap()
        .contains("Local"));
    assert_eq!(
        std::fs::read_to_string(first.root.join("untracked.txt")).unwrap(),
        "keep me"
    );
    assert_eq!(
        first
            .execute(Action::Pull {
                remote: None,
                branch: None,
                allow_dirty: true
            })
            .await
            .unwrap_err()
            .code,
        "conflict"
    );
    let conflict = first.conflicts().await.unwrap().remove(0);
    first
        .execute(Action::ResolveConflict {
            path: conflict.path,
            content: conflict.incoming,
            side: None,
            revision: conflict.revision,
        })
        .await
        .unwrap();
    first
        .execute(Action::FinishMerge {
            message: "Merge incoming".into(),
        })
        .await
        .unwrap();
    assert!(first.status().await.unwrap().operation.is_none());
    assert!(first.checkpoint.is_none());
}
#[tokio::test]
async fn rejects_abort_after_external_edits_and_preserves_stash_on_conflict() {
    let (_dir, mut git) = repo();
    std::fs::write(
        git.root.join("purr.yaml"),
        "purr: 2\nworkspace:\n  id: fixture\n  name: Draft\n",
    )
    .unwrap();
    git.execute(Action::Stash {
        message: "Work".into(),
    })
    .await
    .unwrap();
    let stash = git.stashes().await.unwrap().remove(0);
    rename_workspace(&git, "Changed");
    assert_eq!(
        git.execute(Action::ApplyStash {
            id: stash.id.clone()
        })
        .await
        .unwrap_err()
        .code,
        "conflict"
    );
    assert_eq!(git.stashes().await.unwrap()[0].id, stash.id);
    std::fs::write(git.root.join("external.txt"), "outside edit").unwrap();
    assert_eq!(
        git.execute(Action::AbortMerge).await.unwrap_err().code,
        "stale"
    );
    assert!(git.root.join("external.txt").exists());
}
