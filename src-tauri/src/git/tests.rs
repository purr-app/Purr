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
    command(dir.path(), &["init", "-b", "main"]);
    command(dir.path(), &["config", "user.name", "Purr Fixture"]);
    command(dir.path(), &["config", "user.email", "purr@example.test"]);
    std::fs::write(
        dir.path().join("purr.yaml"),
        "purr: 2\nworkspace:\n  id: fixture\n  name: Fixture\n",
    )
    .unwrap();
    command(dir.path(), &["add", "purr.yaml"]);
    command(dir.path(), &["commit", "-m", "Initial"]);
    let git = Git::new(std::fs::canonicalize(dir.path()).unwrap(), "fixture".into());
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
