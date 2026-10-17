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
#[cfg(unix)]
#[tokio::test]
async fn cancellation_reaps_git_and_still_records_abortable_recovery() {
    let (_dir, mut git) = repo();
    let token = git.cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        token.cancel();
    });
    let start = std::time::Instant::now();
    assert_eq!(
        git.run(&["-c", "alias.purr-block=!sleep 30", "purr-block"])
            .await
            .unwrap_err()
            .code,
        "cancelled"
    );
    assert!(start.elapsed() < Duration::from_secs(3));
    git.cancel = CancellationToken::new();
    git.begin_checkpoint("merge").await.unwrap();
    std::fs::write(git.root.join("introduced.txt"), "operation output").unwrap();
    git.cancel.cancel();
    assert_eq!(
        git.complete_checkpoint(Err(GitError::new("cancelled", "Cancelled")))
            .await
            .unwrap_err()
            .code,
        "cancelled"
    );
    git.abort_checkpoint().await.unwrap();
    assert!(!git.root.join("introduced.txt").exists());
}
#[tokio::test]
async fn validates_complete_staged_project_and_branch_before_changing_head() {
    let (_dir, mut git) = repo();
    let original = command(&git.root, &["rev-parse", "HEAD"]);
    std::fs::create_dir(git.root.join("documents")).unwrap();
    let path = git.root.join("documents/request.yaml");
    for invalid in [
        "purr: 2\nkind: http\nid: request\nname: Missing URL\nmethod: GET\n",
        "purr: 2\nkind: http\nid: request\nname: Missing folder\nurl: https://example.test\nmethod: GET\nfolderId: missing\n",
        "purr: 2\nkind: schema\nid: schema\nname: Missing sidecar\nsource:\n  type: sdl-file\npinned: schemas/schema.graphql\n",
    ] {
        std::fs::write(&path,invalid).unwrap();
        command(&git.root,&["add","documents/request.yaml"]);
        assert_eq!(git.execute(Action::Commit{message:"Invalid".into(),author:None}).await.unwrap_err().code,"invalid-project");
        assert_eq!(command(&git.root,&["rev-parse","HEAD"]),original);
    }
    // An external client can create invalid commits; switching must still fail
    // before touching the current branch or files.
    command(&git.root, &["switch", "-c", "broken"]);
    command(&git.root, &["commit", "-m", "Invalid external schema"]);
    command(&git.root, &["switch", "main"]);
    assert_eq!(
        git.execute(Action::SwitchBranch {
            name: "broken".into(),
            allow_dirty: false
        })
        .await
        .unwrap_err()
        .code,
        "invalid-project"
    );
    assert_eq!(command(&git.root, &["branch", "--show-current"]), "main");
    assert!(!path.exists());
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
async fn same_identity_with_unrelated_history_cannot_be_pulled_or_pushed_over() {
    let (_dir, mut first, peer) = peers();
    command(&peer.root, &["checkout", "--orphan", "unrelated"]);
    rename_workspace(&peer, "Independent history");
    command(&peer.root, &["push", "origin", "unrelated"]);
    let original = command(&first.root, &["rev-parse", "HEAD"]);
    for action in [
        Action::Pull {
            remote: Some("origin".into()),
            branch: Some("unrelated".into()),
            allow_dirty: false,
        },
        Action::Push {
            remote: Some("origin".into()),
            branch: Some("unrelated".into()),
        },
    ] {
        assert_eq!(first.execute(action).await.unwrap_err().code, "unrelated");
        assert_eq!(command(&first.root, &["rev-parse", "HEAD"]), original);
        assert!(first.status().await.unwrap().files.is_empty());
    }
}
#[tokio::test]
async fn stash_application_restores_the_real_index_and_later_working_copy() {
    let (_dir, mut git) = repo();
    std::fs::write(git.root.join("notes.txt"), "staged").unwrap();
    git.execute(Action::Stage {
        paths: vec!["notes.txt".into()],
    })
    .await
    .unwrap();
    std::fs::write(git.root.join("notes.txt"), "working").unwrap();
    git.execute(Action::Stash {
        message: "Index snapshot".into(),
    })
    .await
    .unwrap();
    let id = git.stashes().await.unwrap()[0].id.clone();
    assert!(!git.root.join("notes.txt").exists());
    git.execute(Action::ApplyStash { id }).await.unwrap();
    assert_eq!(command(&git.root, &["show", ":notes.txt"]), "staged");
    assert_eq!(
        std::fs::read_to_string(git.root.join("notes.txt")).unwrap(),
        "working"
    );
    assert!(git.stashes().await.unwrap().is_empty());
}

#[tokio::test]
async fn stash_then_switch_keeps_new_schema_and_request_changes_in_one_stash() {
    let (_dir, mut git) = repo();
    std::fs::create_dir(git.root.join("documents")).unwrap();
    std::fs::create_dir(git.root.join("schemas")).unwrap();
    let before = "purr: 2\nkind: http\nid: request\nname: Request\nmethod: GET\nurl: https://example.test/before\n";
    let after = before.replace("/before", "/after");
    std::fs::write(git.root.join("documents/request.yaml"), before).unwrap();
    command(&git.root, &["add", "documents/request.yaml"]);
    command(&git.root, &["commit", "-m", "Request baseline"]);
    command(&git.root, &["branch", "test"]);
    std::fs::write(git.root.join("documents/request.yaml"), &after).unwrap();
    let definition = "purr: 2\nkind: schema\nid: schema\nname: Rick and Morty copy\nsource:\n  type: introspection\nendpoint: https://example.test/graphql\npinned: schemas/schema.graphql\n";
    let sdl = "type Query { hello: String }";
    std::fs::write(git.root.join("schemas/schema.yaml"), definition).unwrap();
    std::fs::write(git.root.join("schemas/schema.graphql"), sdl).unwrap();
    git.execute(Action::Stash {
        message: "Before switch".into(),
    })
    .await
    .unwrap();
    assert!(
        git.status().await.unwrap().files.is_empty(),
        "{}",
        command(
            &git.root,
            &["status", "--porcelain=v2", "--untracked-files=all"]
        )
    );
    git.execute(Action::SwitchBranch {
        name: "test".into(),
        allow_dirty: false,
    })
    .await
    .unwrap();
    let stashes = git.stashes().await.unwrap();
    assert_eq!(stashes.len(), 1);
    assert!(!git.root.join("schemas/schema.yaml").exists());
    assert!(!git.root.join("schemas/schema.graphql").exists());
    git.execute(Action::ApplyStash {
        id: stashes[0].id.clone(),
    })
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(git.root.join("documents/request.yaml")).unwrap(),
        after
    );
    assert_eq!(
        std::fs::read_to_string(git.root.join("schemas/schema.yaml")).unwrap(),
        definition
    );
    assert_eq!(
        std::fs::read_to_string(git.root.join("schemas/schema.graphql")).unwrap(),
        sdl
    );
    assert!(git.stashes().await.unwrap().is_empty());
}
#[tokio::test]
async fn submodules_are_rejected_even_outside_canonical_directories() {
    let (_dir, git) = repo();
    let commit = command(&git.root, &["rev-parse", "HEAD"]);
    command(
        &git.root,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{commit},vendor"),
        ],
    );
    assert_eq!(git.status().await.unwrap_err().code, "unsupported");
    let tree = command(&git.root, &["write-tree"]);
    assert_eq!(git.files_at(&tree).await.err().unwrap().code, "unsupported");
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

#[tokio::test]
async fn bounds_large_previews_and_uses_the_renamed_index_path() {
    let (_dir, git) = repo();
    std::fs::write(git.root.join("before.txt"), "before\n").unwrap();
    command(&git.root, &["add", "before.txt"]);
    command(&git.root, &["commit", "-m", "Before"]);
    command(&git.root, &["mv", "before.txt", "after.txt"]);
    std::fs::write(git.root.join("after.txt"), "after\n").unwrap();
    let diff = git
        .diff(DiffRequest {
            path: "after.txt".into(),
            old_path: Some("before.txt".into()),
            scope: "working".into(),
            commit: None,
        })
        .await
        .unwrap();
    assert_eq!(diff.before, "before\n");
    let file = std::fs::File::create(git.root.join("large.txt")).unwrap();
    file.set_len(128 * 1024 * 1024).unwrap();
    let preview = git
        .diff(DiffRequest {
            path: "large.txt".into(),
            old_path: None,
            scope: "working".into(),
            commit: None,
        })
        .await
        .unwrap();
    assert!(preview.truncated);
    assert!(preview.after.is_empty());
    assert_eq!(preview.after_bytes, 128 * 1024 * 1024);
}

#[tokio::test]
async fn invalid_external_stash_can_be_aborted_without_losing_the_original_project() {
    let (_dir, mut git) = repo();
    std::fs::write(
        git.root.join("purr.yaml"),
        "purr: 2\nworkspace:\n  id: unrelated\n  name: Other\n",
    )
    .unwrap();
    command(
        &git.root,
        &["stash", "push", "-m", "External invalid identity"],
    );
    let stash = git.stashes().await.unwrap().remove(0);
    assert_eq!(
        git.execute(Action::ApplyStash { id: stash.id })
            .await
            .unwrap_err()
            .code,
        "identity"
    );
    assert!(git.checkpoint.as_ref().unwrap().get("after").is_some());
    git.execute(Action::AbortMerge).await.unwrap();
    git.validate_worktree().unwrap();
    assert_eq!(git.stashes().await.unwrap().len(), 1);
}
#[test]
fn read_queries_can_overlap_but_git_mutations_hold_an_exclusive_lease() {
    let state = native::GitState::default();
    let (read_a, _) = state.acquire("read-a", "workspace", false).unwrap();
    let (read_b, _) = state.acquire("read-b", "workspace", false).unwrap();
    let (write, _) = state.acquire("write", "workspace", true).unwrap();
    assert!(state.acquire("read-c", "workspace", false).is_err());
    assert!(state.acquire("write-b", "workspace", true).is_err());
    drop(write);
    drop(read_a);
    drop(read_b);
    assert!(!state.busy("workspace"));
}
#[tokio::test]
async fn switching_never_overwrites_an_ignored_file() {
    let (_dir, mut git) = repo();
    command(&git.root, &["switch", "-c", "with-file"]);
    std::fs::write(git.root.join("kept.txt"), "tracked").unwrap();
    command(&git.root, &["add", "kept.txt"]);
    command(&git.root, &["commit", "-m", "Track file"]);
    command(&git.root, &["switch", "main"]);
    std::fs::write(git.root.join(".gitignore"), "kept.txt\n").unwrap();
    command(&git.root, &["add", ".gitignore"]);
    command(&git.root, &["commit", "-m", "Ignore file"]);
    std::fs::write(git.root.join("kept.txt"), "local ignored bytes").unwrap();
    assert!(git
        .execute(Action::SwitchBranch {
            name: "with-file".into(),
            allow_dirty: true
        })
        .await
        .is_err());
    assert_eq!(
        std::fs::read_to_string(git.root.join("kept.txt")).unwrap(),
        "local ignored bytes"
    );
}

#[tokio::test]
async fn lists_every_branch_with_an_empty_upstream() {
    let (_dir, mut git) = repo();
    git.execute(Action::CreateBranch {
        name: "test".into(),
    })
    .await
    .unwrap();
    git.execute(Action::SwitchBranch {
        name: "test".into(),
        allow_dirty: false,
    })
    .await
    .unwrap();
    let status = git.status().await.unwrap();
    assert_eq!(
        status
            .branches
            .iter()
            .map(|branch| branch.name.as_str())
            .collect::<Vec<_>>(),
        vec!["main", "test"]
    );
    assert!(
        status
            .branches
            .iter()
            .find(|branch| branch.name == "test")
            .unwrap()
            .current
    );
}

#[tokio::test]
async fn binary_stash_accepts_identical_assets_and_preserves_a_partial_index() {
    let (_dir, mut git) = repo();
    std::fs::create_dir(git.root.join("documents")).unwrap();
    std::fs::create_dir(git.root.join("assets")).unwrap();
    let asset = "assets/attachment.bin";
    let bytes = b"\x00binary fixture\xff";
    std::fs::write(git.root.join(asset), bytes).unwrap();
    std::fs::write(git.root.join("documents/request.yaml"),
        "purr: 2\nkind: http\nid: request\nname: Binary\nmethod: POST\nurl: https://example.test\nbody:\n  type: binary\n  file:\n    id: attachment\n    name: fixture.bin\n    mediaType: application/octet-stream\n").unwrap();
    git.execute(Action::Stage {
        paths: vec!["documents/request.yaml".into()],
    })
    .await
    .unwrap();
    git.execute(Action::Stash {
        message: "Binary".into(),
    })
    .await
    .unwrap();
    let id = git.stashes().await.unwrap()[0].id.clone();
    // A previously restored/recreated identical content-addressed asset is safe.
    std::fs::create_dir_all(git.root.join("assets")).unwrap();
    std::fs::write(git.root.join(asset), bytes).unwrap();
    git.execute(Action::ApplyStash { id }).await.unwrap();
    assert_eq!(std::fs::read(git.root.join(asset)).unwrap(), bytes);
    assert!(git.stashes().await.unwrap().is_empty());
    assert_eq!(command(&git.root, &["ls-files", "--", asset]), "");
    // Older versions left a recovery checkpoint after Git restored these files.
    git.begin_checkpoint("stash").await.unwrap();
    git.execute(Action::FinishMerge { message: "".into() })
        .await
        .unwrap();
    assert!(git.checkpoint.is_none());
}

#[tokio::test]
async fn stash_refuses_different_untracked_contents_without_mutation() {
    let (_dir, mut git) = repo();
    std::fs::write(git.root.join("notes.txt"), "stashed").unwrap();
    git.execute(Action::Stash {
        message: "Notes".into(),
    })
    .await
    .unwrap();
    let id = git.stashes().await.unwrap()[0].id.clone();
    std::fs::write(git.root.join("notes.txt"), "keep external").unwrap();
    assert_eq!(
        git.execute(Action::ApplyStash { id })
            .await
            .unwrap_err()
            .code,
        "dirty"
    );
    assert_eq!(
        std::fs::read_to_string(git.root.join("notes.txt")).unwrap(),
        "keep external"
    );
    assert!(git.checkpoint.is_none());
    assert_eq!(git.stashes().await.unwrap().len(), 1);
}

#[tokio::test]
async fn discard_restores_only_working_changes_and_validates_asset_dependencies() {
    let (_dir, mut git) = repo();
    std::fs::write(git.root.join("notes.txt"), "staged").unwrap();
    git.execute(Action::Stage {
        paths: vec!["notes.txt".into()],
    })
    .await
    .unwrap();
    std::fs::write(git.root.join("notes.txt"), "working").unwrap();
    std::fs::write(git.root.join("new.txt"), "new").unwrap();
    git.execute(Action::Discard {
        paths: vec!["notes.txt".into(), "new.txt".into()],
    })
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(git.root.join("notes.txt")).unwrap(),
        "staged"
    );
    assert_eq!(command(&git.root, &["show", ":notes.txt"]), "staged");
    assert!(!git.root.join("new.txt").exists());
    assert!(git.checkpoint.is_none());
    // Discarding the manifest cannot make the saved project unreadable.
    assert!(git
        .execute(Action::Discard {
            paths: vec!["../private".into()]
        })
        .await
        .is_err());
}

#[tokio::test]
async fn diff_distinguishes_an_empty_existing_file_from_a_new_file() {
    let (_dir, git) = repo();
    std::fs::write(git.root.join("empty.txt"), "").unwrap();
    command(&git.root, &["add", "empty.txt"]);
    std::fs::write(git.root.join("empty.txt"), "new content").unwrap();
    let diff = git
        .diff(DiffRequest {
            path: "empty.txt".into(),
            old_path: None,
            scope: "working".into(),
            commit: None,
        })
        .await
        .unwrap();
    assert!(diff.before_exists && diff.after_exists);
    assert_eq!(diff.before_bytes, 0);
    let new = git
        .diff(DiffRequest {
            path: "empty.txt".into(),
            old_path: None,
            scope: "staged".into(),
            commit: None,
        })
        .await
        .unwrap();
    assert!(!new.before_exists && new.after_exists);
}
