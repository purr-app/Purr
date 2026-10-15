use super::*;
use crate::security::RootCiphers;
const A: &str = "purr/alpha/credentials/requests/r/saved/bearer";
const B: &str = "purr/alpha/credentials/variables/v";
fn store(dir: &Path, root: u8) -> LocalStateStore {
    let roots = RootCiphers::from_root(&[root; 32], false)
        .unwrap()
        .with_scope_keys(&dir.join("scope.sqlite3"), "fixture")
        .unwrap();
    let local = LocalStateStore::open_with_ciphers(&dir.join("local.sqlite3"), &roots).unwrap();
    local.prepare_workspace_keys("alpha").unwrap();
    local
}
fn files(dir: &Path) -> FilesystemWorkspaceStore {
    let project = FilesystemWorkspaceStore {
        directory: dir.join("project"),
    };
    fs::create_dir_all(project.directory.join("documents")).unwrap();
    fs::write(project.directory.join("purr.yaml"),format!("purr: 2\nworkspace:\n  id: alpha\n  name: Alpha\n  variables:\n    - id: v\n      name: suffix\n      kind: static\n      sensitive: true\n      secretRef: {B}\n")).unwrap();
    fs::write(project.directory.join("documents/r.yaml"),format!("purr: 2\nkind: http\nid: r\nname: Bearer\nmethod: GET\nurl: https://example.test\nauth:\n  type: bearer\n  token:\n    kind: secret\n    ref: {A}\n")).unwrap();
    project
}
#[test]
fn saved_inventory_authorizes_only_credential_positions_and_rejects_runtime_refs() {
    let dir = tempfile::tempdir().unwrap();
    let project = files(dir.path());
    fs::create_dir(project.directory.join("integrations")).unwrap();
    fs::write(project.directory.join("integrations/i.yaml"),"purr: 2\nkind: integration\nid: i\nname: Provider\nprovider: example\nconfig:\n  trap: {kind: secret, ref: purr/alpha/runtime/private/value}\ncredentials: {}\n").unwrap();
    let inv = inventory(&project.load().unwrap(), "alpha").unwrap();
    assert_eq!(inv.owners.len(), 2);
    assert!(inv.owners.contains_key(A));
    assert_eq!(inv.owners[A], vec!["Bearer / Bearer token"]);
    assert_eq!(inv.owners[B], vec!["Alpha / suffix"]);
    let mut snapshot = project.load().unwrap();
    snapshot.get_mut("documents/r.yaml").unwrap().content = snapshot["documents/r.yaml"]
        .content
        .replace(A, "purr/alpha/runtime/private/value");
    assert!(inventory(&snapshot, "alpha").is_err());
    assert!(inventory(&project.load().unwrap(), "beta").is_err());
}
#[test]
fn selected_roundtrip_preserves_empty_unicode_and_expression_and_reencrypts_destination() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let source_store = store(source.path(), 42);
    let mut destination_store = store(destination.path(), 89);
    let source_files = files(source.path());
    let destination_files = files(destination.path());
    source_store
        .set_secret(A, "prefix-{{suffix}}-Пароль🐈")
        .unwrap();
    source_store.set_secret(B, "").unwrap();
    let inv = inventory(&source_files.load().unwrap(), "alpha").unwrap();
    let archive = selected(&source_store, &inv, "alpha", &[A.into(), B.into()], &[]).unwrap();
    assert!(archive
        .dependencies
        .iter()
        .any(|d| d.contains("{{suffix}}") && d.contains("selected local secret")));
    let state = TransferState::default();
    let preview = prepare(
        &state,
        &destination_store,
        inventory(&destination_files.load().unwrap(), "alpha").unwrap(),
        "main",
        "alpha",
        archive,
        || Ok(()),
    )
    .unwrap();
    assert!(!preview.to_string().contains("Пароль"));
    assert_eq!(
        reveal_preview_value(&state, "main", "alpha", preview["id"].as_str().unwrap(), A).unwrap(),
        "prefix-{{suffix}}-Пароль🐈"
    );
    let result = commit(
        &state,
        &mut destination_store,
        &destination_files,
        "main",
        "alpha",
        preview["id"].as_str().unwrap(),
        "import-test",
        &[A.into(), B.into()],
        || Ok(()),
    )
    .unwrap();
    assert_eq!(result["status"], "committed");
    assert_eq!(
        destination_store.get_secret(A).unwrap(),
        source_store.get_secret(A).unwrap()
    );
    assert_eq!(destination_store.get_secret(B).unwrap(), Some("".into()));
    assert_eq!(
        destination_store
            .operation_status("import-test")
            .unwrap()
            .status,
        "committed"
    );
    let repeated = commit(
        &state,
        &mut destination_store,
        &destination_files,
        "main",
        "alpha",
        preview["id"].as_str().unwrap(),
        "import-test",
        &[A.into(), B.into()],
        || Ok(()),
    )
    .unwrap();
    assert_eq!(repeated, result);
    let cipher = |store: &LocalStateStore| {
        store
            .db
            .query_row(
                "SELECT ciphertext FROM secret_values WHERE reference=?1",
                [A],
                |r| r.get::<_, Vec<u8>>(0),
            )
            .unwrap()
    };
    assert_ne!(cipher(&source_store), cipher(&destination_store));
}
#[test]
fn selected_import_replaces_existing_values_and_keeps_each_original_value() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let source_store = store(source.path(), 12);
    let mut destination_store = store(destination.path(), 91);
    let source_files = files(source.path());
    let destination_files = files(destination.path());
    source_store.set_secret(A, "Bearer token").unwrap();
    source_store.set_secret(B, "suffix").unwrap();
    destination_store.set_secret(A, "old bearer").unwrap();
    let archive = selected(
        &source_store,
        &inventory(&source_files.load().unwrap(), "alpha").unwrap(),
        "alpha",
        &[A.into(), B.into()],
        &[],
    )
    .unwrap();
    assert_eq!(
        archive.entries[0].label.as_deref(),
        Some("Bearer / Bearer token")
    );
    let state = TransferState::default();
    let preview = prepare(
        &state,
        &destination_store,
        inventory(&destination_files.load().unwrap(), "alpha").unwrap(),
        "main",
        "alpha",
        archive,
        || Ok(()),
    )
    .unwrap();
    assert_eq!(preview["items"][0]["status"], "existing");
    assert_eq!(preview["items"][1]["status"], "missing");
    commit(
        &state,
        &mut destination_store,
        &destination_files,
        "main",
        "alpha",
        preview["id"].as_str().unwrap(),
        "replace-original-values",
        &[A.into(), B.into()],
        || Ok(()),
    )
    .unwrap();
    assert_eq!(
        destination_store.get_secret(A).unwrap().as_deref(),
        Some("Bearer token")
    );
    assert_eq!(
        destination_store.get_secret(B).unwrap().as_deref(),
        Some("suffix")
    );
}

#[test]
fn selected_package_capability_is_bound_to_window_workspace_and_expiry() {
    let state = TransferState::default();
    let id = state
        .stage_import(StagedImport {
            backup: None,
            window: "main".into(),
            workspace: "alpha".into(),
            expires: now() + TTL,
            bytes: Arc::new(Zeroizing::new(vec![1, 2, 3])),
        })
        .unwrap();
    assert!(state.staged_import(&id, "other", "alpha").is_err());
    assert!(state.staged_import(&id, "main", "beta").is_err());
    assert_eq!(
        state
            .staged_import(&id, "main", "alpha")
            .unwrap()
            .as_slice(),
        &[1, 2, 3]
    );
    cancel(&state, "main", Some(&id), None).unwrap();
    assert!(state.staged_import(&id, "main", "alpha").is_err());
    let expired = state
        .stage_import(StagedImport {
            backup: None,
            window: "main".into(),
            workspace: "alpha".into(),
            expires: now().saturating_sub(1),
            bytes: Arc::new(Zeroizing::new(vec![4])),
        })
        .unwrap();
    assert!(state.staged_import(&expired, "main", "alpha").is_err());
}
#[test]
fn old_selected_package_without_display_labels_remains_readable() {
    let archive: SecretArchive = serde_json::from_str(&format!(
        "{{\"version\":1,\"workspaceId\":\"alpha\",\"entries\":[{{\"ref\":\"{A}\",\"value\":\"old-value\"}}],\"omissions\":[],\"dependencies\":[]}}"
    )).unwrap();
    assert!(archive.entries[0].label.is_none());
    assert_eq!(&*archive.entries[0].value, "old-value");
}
#[test]
fn stale_revision_and_declaration_reject_all_rows_and_other_window_cannot_use_preview() {
    let dir = tempfile::tempdir().unwrap();
    let mut local = store(dir.path(), 42);
    let files = files(dir.path());
    let state = TransferState::default();
    let archive = || SecretArchive {
        version: 1,
        workspace_id: "alpha".into(),
        entries: vec![
            SecretEntry {
                reference: A.into(),
                label: None,
                value: Zeroizing::new("first".into()),
            },
            SecretEntry {
                reference: B.into(),
                label: None,
                value: Zeroizing::new("second".into()),
            },
        ],
        omissions: vec![],
        dependencies: vec![],
    };
    let p = prepare(
        &state,
        &local,
        inventory(&files.load().unwrap(), "alpha").unwrap(),
        "one",
        "alpha",
        archive(),
        || Ok(()),
    )
    .unwrap();
    let pid = p["id"].as_str().unwrap();
    assert!(commit(
        &state,
        &mut local,
        &files,
        "two",
        "alpha",
        pid,
        "op",
        &[A.into()],
        || Ok(())
    )
    .is_err());
    local.set_secret(A, "concurrent").unwrap();
    assert!(commit(
        &state,
        &mut local,
        &files,
        "one",
        "alpha",
        pid,
        "op",
        &[A.into(), B.into()],
        || Ok(())
    )
    .is_err());
    assert_eq!(local.get_secret(A).unwrap().as_deref(), Some("concurrent"));
    assert_eq!(local.get_secret(B).unwrap(), None);
    let p = prepare(
        &state,
        &local,
        inventory(&files.load().unwrap(), "alpha").unwrap(),
        "one",
        "alpha",
        archive(),
        || Ok(()),
    )
    .unwrap();
    fs::write(
        files.directory.join("purr.yaml"),
        "purr: 2\nworkspace: {id: alpha, name: changed}\n",
    )
    .unwrap();
    assert!(commit(
        &state,
        &mut local,
        &files,
        "one",
        "alpha",
        p["id"].as_str().unwrap(),
        "op2",
        &[A.into()],
        || Ok(())
    )
    .is_err());
}
#[test]
fn unknown_rows_skip_and_missing_export_requires_explicit_exclusion() {
    let dir = tempfile::tempdir().unwrap();
    let local = store(dir.path(), 42);
    let files = files(dir.path());
    let inv = inventory(&files.load().unwrap(), "alpha").unwrap();
    local.set_secret(A, "").unwrap();
    assert!(selected(&local, &inv, "alpha", &[A.into(), B.into()], &[]).is_err());
    let export = selected(&local, &inv, "alpha", &[A.into()], &[B.into()]).unwrap();
    assert_eq!(export.omissions, vec![B.to_string()]);
    let archive = SecretArchive {
        version: 1,
        workspace_id: "alpha".into(),
        entries: vec![SecretEntry {
            reference: "purr/alpha/credentials/new/ref".into(),
            label: Some("Source / unknown".into()),
            value: Zeroizing::new("unknown".into()),
        }],
        omissions: vec![],
        dependencies: vec![],
    };
    let p = prepare(
        &TransferState::default(),
        &local,
        inv,
        "main",
        "alpha",
        archive,
        || Ok(()),
    )
    .unwrap();
    assert_eq!(p["items"][0]["status"], "unknown");
    assert_eq!(p["items"][0]["owners"][0], "Source / unknown");
}
#[test]
fn recovery_uses_backup_without_source_installation_and_scopes_destination() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let source_store = store(source.path(), 21);
    let source_files = files(source.path());
    source_store.set_secret(A, "backup-secret").unwrap();
    let inv = inventory(&source_files.load().unwrap(), "alpha").unwrap();
    let backup = backup(&source_store, &inv, "alpha").unwrap();
    let keys = source_store
        .secret_cipher
        .export_credential_recovery_keys("alpha")
        .unwrap();
    drop(source_store);
    drop(source);
    let mut dest = store(destination.path(), 72);
    let destination_files = files(destination.path());
    let mut entries = vec![];
    for row in backup.rows {
        let bytes = crate::security::decrypt_recovery_secret(
            &keys,
            "alpha",
            &row.reference,
            row.version,
            &row.nonce,
            &row.ciphertext,
        )
        .unwrap();
        assert!(crate::security::decrypt_recovery_secret(
            &keys,
            "beta",
            &row.reference,
            row.version,
            &row.nonce,
            &row.ciphertext
        )
        .is_err());
        entries.push(SecretEntry {
            reference: row.reference,
            label: None,
            value: Zeroizing::new(std::str::from_utf8(&bytes).unwrap().into()),
        });
    }
    let state = TransferState::default();
    let p = prepare(
        &state,
        &dest,
        inventory(&destination_files.load().unwrap(), "alpha").unwrap(),
        "main",
        "alpha",
        SecretArchive {
            version: 1,
            workspace_id: "alpha".into(),
            entries,
            omissions: backup.omissions,
            dependencies: vec![],
        },
        || Ok(()),
    )
    .unwrap();
    commit(
        &state,
        &mut dest,
        &destination_files,
        "main",
        "alpha",
        p["id"].as_str().unwrap(),
        "recovery",
        &[A.into()],
        || Ok(()),
    )
    .unwrap();
    assert_eq!(
        dest.get_secret(A).unwrap().as_deref(),
        Some("backup-secret")
    );
}
#[test]
fn expired_cancelled_and_destroyed_previews_cannot_publish() {
    let state = TransferState::default();
    let dir = tempfile::tempdir().unwrap();
    let mut local = store(dir.path(), 42);
    let files = files(dir.path());
    let build = || SecretArchive {
        version: 1,
        workspace_id: "alpha".into(),
        entries: vec![SecretEntry {
            reference: A.into(),
            label: None,
            value: Zeroizing::new("never".into()),
        }],
        omissions: vec![],
        dependencies: vec![],
    };
    let p = prepare(
        &state,
        &local,
        inventory(&files.load().unwrap(), "alpha").unwrap(),
        "main",
        "alpha",
        build(),
        || Ok(()),
    )
    .unwrap();
    state
        .previews
        .lock()
        .unwrap()
        .get_mut(p["id"].as_str().unwrap())
        .unwrap()
        .expires = 0;
    assert!(commit(
        &state,
        &mut local,
        &files,
        "main",
        "alpha",
        p["id"].as_str().unwrap(),
        "expired",
        &[A.into()],
        || Ok(())
    )
    .is_err());
    let p = prepare(
        &state,
        &local,
        inventory(&files.load().unwrap(), "alpha").unwrap(),
        "main",
        "alpha",
        build(),
        || Ok(()),
    )
    .unwrap();
    state.clear_window("main");
    assert!(commit(
        &state,
        &mut local,
        &files,
        "main",
        "alpha",
        p["id"].as_str().unwrap(),
        "closed",
        &[A.into()],
        || Ok(())
    )
    .is_err());
    assert!(prepare(
        &state,
        &local,
        inventory(&files.load().unwrap(), "alpha").unwrap(),
        "main",
        "alpha",
        build(),
        || Err("cancelled".into())
    )
    .is_err());
    assert_eq!(local.get_secret(A).unwrap(), None);
    let job = state.start_job("main", "job").unwrap();
    assert!(state.cancel_job("other", "job").is_err());
    state.cancel_job("main", "job").unwrap();
    assert!(job.check().is_err());
}
#[test]
fn configuration_rejects_protected_literals_and_export_is_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let files = files(dir.path());
    let mut snapshot = files.load().unwrap();
    snapshot.get_mut("documents/r.yaml").unwrap().content =
        snapshot["documents/r.yaml"].content.replace(
            &format!("kind: secret\n    ref: {A}"),
            "kind: plain\n    value: leaked-token",
        );
    assert!(inventory(&snapshot, "alpha").is_err());
    let destination = dir.path().join("export");
    fs::create_dir(&destination).unwrap();
    assert!(configuration(&files.load().unwrap(), &destination, || Err(
        "cancelled".into()
    ))
    .is_err());
    assert!(fs::read_dir(&destination).unwrap().next().is_none());
    configuration(&files.load().unwrap(), &destination, || Ok(())).unwrap();
    assert!(destination.join("purr.yaml").exists());
    assert!(configuration(&files.load().unwrap(), &destination, || Ok(())).is_err());
}

#[test]
fn inventory_covers_saved_shared_schema_environment_integration_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let files = files(dir.path());
    let make = |part: &str| format!("purr/alpha/credentials/{part}");
    fs::write(files.directory.join("purr.yaml"),format!("purr: 2\nworkspace: {{id: alpha, name: Alpha}}\ndefaults:\n  auth:\n    - id: shared\n      name: Shared\n      scope: all\n      enabled: true\n      config:\n        type: basic\n        username: user\n        password: {{kind: secret, ref: {}}}\n  headers:\n    - id: h\n      name: X-Private\n      sensitive: true\n      scope: all\n      value: {{kind: secret, ref: {}}}\n",make("shared/password"),make("shared/header"))).unwrap();
    for (path,definition) in [
 ("documents/schema.yaml",format!("purr: 2\nkind: schema\nid: schema\nname: Schema\nauth: {{type: bearer, token: {{kind: secret, ref: {}}}}}\nsource: {{type: registry, provider: example, resource: api, credential: {{kind: secret, ref: {}}}}}\nintrospectionHeaders:\n  - id: h\n    name: X-Private\n    sensitive: true\n    value: {{kind: secret, ref: {}}}\n",make("schema/bearer"),make("schema/registry"),make("schema/header"))),
 ("documents/environment.yaml",format!("purr: 2\nkind: environment\nid: e\nname: Env\nvariables:\n  - id: v\n    name: TOKEN\n    kind: static\n    sensitive: true\n    secretRef: {}\n",make("environment/token"))),
 ("documents/integration.yaml",format!("purr: 2\nkind: integration\nid: i\nname: Integration\nprovider: example\ncredentials:\n  password: {{kind: secret, ref: {}}}\nconfig: {{secretRef: purr/global/credentials/not-an-owned-ref}}\n",make("integration/password"))),
 ] {fs::write(files.directory.join(path),definition).unwrap();}
    let inv = inventory(&files.load_transfer_definitions().unwrap(), "alpha").unwrap();
    assert_eq!(inv.owners.len(), 8);
    assert_eq!(
        inv.owners[&make("shared/password")],
        vec!["Alpha / Shared / Password"]
    );
    assert_eq!(
        inv.owners[&make("shared/header")],
        vec!["Alpha / Header x-private"]
    );
    assert_eq!(
        inv.owners[&make("integration/password")],
        vec!["Integration / password"]
    );
    for expected in [
        "shared/password",
        "shared/header",
        "schema/bearer",
        "schema/registry",
        "schema/header",
        "environment/token",
        "integration/password",
    ] {
        assert!(inv.owners.contains_key(&make(expected)));
    }
}
#[test]
fn configuration_only_copies_referenced_assets_and_rejects_symlinks() {
    let dir = tempfile::tempdir().unwrap();
    let files = files(dir.path());
    fs::create_dir(files.directory.join("assets")).unwrap();
    fs::write(files.directory.join("assets/used.bin"), b"used bytes").unwrap();
    fs::write(
        files.directory.join("assets/orphan.bin"),
        b"unreferenced secret marker",
    )
    .unwrap();
    let path = files.directory.join("documents/r.yaml");
    let mut definition = fs::read_to_string(&path).unwrap();
    definition.push_str("body:\n  type: binary\n  file: {id: used, name: upload.bin, mediaType: application/octet-stream}\n");
    fs::write(&path, definition).unwrap();
    let snapshot = configuration_snapshot(&files, "alpha").unwrap();
    assert!(snapshot.contains_key("assets/used.bin"));
    assert!(!snapshot.contains_key("assets/orphan.bin"));
    assert!(!files
        .load_transfer_definitions()
        .unwrap()
        .contains_key("assets/used.bin"));
    #[cfg(unix)]
    {
        fs::remove_file(files.directory.join("assets/used.bin")).unwrap();
        std::os::unix::fs::symlink(
            files.directory.join("assets/orphan.bin"),
            files.directory.join("assets/used.bin"),
        )
        .unwrap();
        assert!(configuration_snapshot(&files, "alpha").is_err());
    }
}
#[test]
fn cancelled_cipher_export_preserves_existing_file_and_removes_temporary_ciphertext() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("secrets.purrsecrets");
    fs::write(&target, b"previous archive").unwrap();
    let calls = std::cell::Cell::new(0);
    let result = atomic_cipher_file(
        &target,
        ContainerKind::SelectedSecrets,
        "synthetic-password-123",
        b"private marker",
        || {
            calls.set(calls.get() + 1);
            if calls.get() == 2 {
                Err("cancelled".into())
            } else {
                Ok(())
            }
        },
    );
    assert!(result.is_err());
    assert_eq!(fs::read(&target).unwrap(), b"previous archive");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}
#[test]
fn malformed_protected_values_and_duplicate_package_entries_never_publish() {
    let dir = tempfile::tempdir().unwrap();
    let files = files(dir.path());
    let local = store(dir.path(), 42);
    let mut snapshot = files.load_transfer_definitions().unwrap();
    let original = snapshot["documents/r.yaml"].content.clone();
    snapshot.get_mut("documents/r.yaml").unwrap().content = original.replace(
        &format!("ref: {A}"),
        &format!("ref: {A}\n    value: leaked"),
    );
    assert!(inventory(&snapshot, "alpha").is_err());
    let archive = SecretArchive {
        version: 1,
        workspace_id: "alpha".into(),
        entries: vec![
            SecretEntry {
                reference: A.into(),
                label: None,
                value: Zeroizing::new("one".into()),
            },
            SecretEntry {
                reference: A.into(),
                label: None,
                value: Zeroizing::new("two".into()),
            },
        ],
        omissions: vec![],
        dependencies: vec![],
    };
    let state = TransferState::default();
    assert!(prepare(
        &state,
        &local,
        inventory(&files.load_transfer_definitions().unwrap(), "alpha").unwrap(),
        "main",
        "alpha",
        archive,
        || Ok(())
    )
    .is_err());
    assert!(state.previews.lock().unwrap().is_empty());
    assert_eq!(local.get_secret(A).unwrap(), None);
}

#[test]
fn dependency_summary_is_transitive_cycle_safe_and_never_exports_unselected_values() {
    let dir = tempfile::tempdir().unwrap();
    let files = files(dir.path());
    let local = store(dir.path(), 42);
    local.set_secret(A, "prefix-{{suffix}}").unwrap();
    local
        .set_secret(B, "literal-must-not-appear-{{globalToken}}-{{suffix}}")
        .unwrap();
    let inv = inventory(&files.load_transfer_definitions().unwrap(), "alpha").unwrap();
    let archive = selected(&local, &inv, "alpha", &[A.into()], &[]).unwrap();
    assert_eq!(archive.entries.len(), 1);
    assert!(archive
        .dependencies
        .iter()
        .any(|d| d.contains("suffix") && d.contains("omitted local secret")));
    assert!(archive
        .dependencies
        .iter()
        .any(|d| d.contains("globalToken") && d.contains("not included")));
    let json = serde_json::to_string(&archive).unwrap();
    assert!(!json.contains("literal-must-not-appear"));
}

#[test]
fn wrong_protected_container_types_and_explicit_nulls_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let files = files(dir.path());
    let original = files.load_transfer_definitions().unwrap();
    for replacement in [
 "headers: {name: Authorization, sensitive: true, value: leaked}","headers: null","headers: [{id: h, name: X-Secret, sensitive: 'true', value: {kind: plain, value: leaked}}]", "auth: []", "auth: null",
 ]{let mut snapshot=original.clone();let mut value:Value=serde_yaml::from_str(&snapshot["documents/r.yaml"].content).unwrap();let patch:Value=serde_yaml::from_str(replacement).unwrap();for(k,v)in patch.as_object().unwrap(){value[k]=v.clone();}snapshot.get_mut("documents/r.yaml").unwrap().content=serde_yaml::to_string(&value).unwrap();assert!(inventory(&snapshot,"alpha").is_err(),"{replacement}");}
    for defaults in [
        "auth: {password: leaked}",
        "auth: null",
        "headers: {value: leaked}",
        "headers: null",
        "auth: [{id: a, config: null}]",
        "auth: [{id: a, config: {type: none}, enabled: 'false'}]",
    ] {
        let mut snapshot = original.clone();
        let mut manifest: Value = serde_yaml::from_str(&snapshot["purr.yaml"].content).unwrap();
        manifest["defaults"] = serde_yaml::from_str(defaults).unwrap();
        snapshot.get_mut("purr.yaml").unwrap().content = serde_yaml::to_string(&manifest).unwrap();
        assert!(inventory(&snapshot, "alpha").is_err(), "{defaults}");
    }
    for (kind, patch) in [
        ("environment", "variables: {value: leaked}"),
        ("environment", "variables: null"),
        ("integration", "credentials: [{kind: plain, value: leaked}]"),
        ("integration", "credentials: null"),
        (
            "schema",
            "source: {type: unknown, credential: {kind: plain, value: leaked}}",
        ),
        (
            "schema",
            "source: {type: introspection, credential: {kind: plain, value: leaked}}",
        ),
        ("schema", "source: {type: registry, credential: null}"),
        ("schema", "source: null"),
        (
            "schema",
            "source: {type: introspection}\nintrospectionHeaders: {value: leaked}",
        ),
    ] {
        let mut snapshot = original.clone();
        snapshot.get_mut("documents/r.yaml").unwrap().content =
            format!("purr: 2\nid: r\nname: malformed\nkind: {kind}\n{patch}\n");
        assert!(inventory(&snapshot, "alpha").is_err(), "{patch}");
    }
}
#[test]
fn transfer_template_classification_uses_shared_ecmascript_fixture() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/secret-classification.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let mut inv = Inventory::default();
        let result = inv.credential(
            "alpha",
            &json!({"kind":"template","value":case["value"]}),
            "owner",
        );
        assert_eq!(result.is_ok(), case["pure"].as_bool().unwrap());
    }
}
#[test]
fn late_cancel_removes_preview_and_completed_cancel_returns_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let mut local = store(dir.path(), 42);
    let files = files(dir.path());
    let state = TransferState::default();
    let archive = || SecretArchive {
        version: 1,
        workspace_id: "alpha".into(),
        entries: vec![SecretEntry {
            reference: A.into(),
            label: None,
            value: Zeroizing::new("late".into()),
        }],
        omissions: vec![],
        dependencies: vec![],
    };
    let calls = std::cell::Cell::new(0);
    let result = prepare(
        &state,
        &local,
        inventory(&files.load_transfer_definitions().unwrap(), "alpha").unwrap(),
        "main",
        "alpha",
        archive(),
        || {
            calls.set(calls.get() + 1);
            if calls.get() == 3 {
                Err(CANCELLED.into())
            } else {
                Ok(())
            }
        },
    );
    assert!(result.is_err());
    assert!(state.previews.lock().unwrap().is_empty());
    let p = prepare(
        &state,
        &local,
        inventory(&files.load_transfer_definitions().unwrap(), "alpha").unwrap(),
        "main",
        "alpha",
        archive(),
        || Ok(()),
    )
    .unwrap();
    let pid = p["id"].as_str().unwrap();
    commit(
        &state,
        &mut local,
        &files,
        "main",
        "alpha",
        pid,
        "complete",
        &[A.into()],
        || Ok(()),
    )
    .unwrap();
    assert_eq!(
        cancel(&state, "main", Some(pid), Some("complete")).unwrap()["status"],
        "committed"
    );
    assert!(state.start_job("main", "complete").is_ok());
}
#[test]
fn definite_cancellation_has_nonerror_protocol_outcomes() {
    let export = Action::ExportConfiguration {
        operation_id: "export".into(),
        workspace_id: "alpha".into(),
    };
    assert_eq!(
        cancellation_result(&export, Err(CANCELLED.into()), |_| Ok("missing".into())).unwrap()
            ["status"],
        "cancelled"
    );
    assert_eq!(
        cancellation_result(&export, Ok(json!({"status":"written"})), |_| Ok(
            "missing".into()
        ))
        .unwrap()["status"],
        "written"
    );
    let import = Action::PrepareImport {
        operation_id: "import".into(),
        workspace_id: "alpha".into(),
        staged_id: "selected".into(),
        password: "synthetic-password".into(),
    };
    assert_eq!(
        cancellation_result(&import, Err(CANCELLED.into()), |_| Ok("missing".into())).unwrap(),
        Value::Null
    );
    let select = Action::SelectImportFile {
        operation_id: "select-file".into(),
        workspace_id: "alpha".into(),
    };
    assert_eq!(
        cancellation_result(&select, Err(CANCELLED.into()), |_| Ok("missing".into())).unwrap(),
        Value::Null
    );
    assert!(cancellation_result(
        &import,
        Err("bad password".into()),
        |_| Ok("missing".into())
    )
    .is_err());
    let state = TransferState::default();
    state.cancel_job("main", "before-start").unwrap();
    assert!(state
        .start_job("main", "before-start")
        .err()
        .is_some_and(|e| e == CANCELLED));
}

#[test]
fn operation_only_cancel_and_expired_preview_reconcile_durable_commit() {
    let dir = tempfile::tempdir().unwrap();
    let mut local = store(dir.path(), 42);
    let files = files(dir.path());
    let state = TransferState::default();
    let archive = SecretArchive {
        version: 1,
        workspace_id: "alpha".into(),
        entries: vec![SecretEntry {
            reference: A.into(),
            label: None,
            value: Zeroizing::new("durable".into()),
        }],
        omissions: vec![],
        dependencies: vec![],
    };
    let p = prepare(
        &state,
        &local,
        inventory(&files.load_transfer_definitions().unwrap(), "alpha").unwrap(),
        "main",
        "alpha",
        archive,
        || Ok(()),
    )
    .unwrap();
    let pid = p["id"].as_str().unwrap();
    commit(
        &state,
        &mut local,
        &files,
        "main",
        "alpha",
        pid,
        "durable",
        &[A.into()],
        || Ok(()),
    )
    .unwrap();
    assert_eq!(
        cancel(&state, "main", None, Some("durable")).unwrap()["status"],
        "committed"
    );
    assert!(state.start_job("main", "durable").is_ok());
    state.previews.lock().unwrap().clear();
    cancel(&state, "main", None, Some("durable")).unwrap();
    let error = state.start_job("main", "durable").err().unwrap();
    assert_eq!(error, CANCELLED);
    let action = Action::CommitImport {
        workspace_id: "alpha".into(),
        preview_id: pid.into(),
        operation_id: "durable".into(),
        references: vec![A.into()],
    };
    let result = cancellation_result(&action, Err(error), |id| {
        local.operation_status(id).map(|receipt| receipt.status)
    })
    .unwrap();
    assert_eq!(result["status"], "committed");
    assert_eq!(
        cancellation_result(&action, Err(CANCELLED.into()), |_| Ok(
            "recovery-required".into()
        ))
        .unwrap()["status"],
        "recovery-required"
    );
    assert!(cancellation_result(&action, Err(CANCELLED.into()), |_| Err(
        "storage unavailable".into()
    ))
    .is_err());
}

#[test]
fn preview_reveal_is_bound_to_window_workspace_reference_and_lifecycle() {
    let state = TransferState::default();
    state.previews.lock().unwrap().insert(
        "preview".into(),
        Preview {
            window: "main".into(),
            workspace: "alpha".into(),
            expires: now() + TTL,
            rows: vec![PreparedRow {
                reference: A.into(),
                value: Zeroizing::new("incoming-value".into()),
                revision: 0,
                known: true,
            }],
            files: BTreeMap::new(),
            receipt: None,
        },
    );
    assert_eq!(
        reveal_preview_value(&state, "main", "alpha", "preview", A).unwrap(),
        "incoming-value"
    );
    assert!(reveal_preview_value(&state, "other", "alpha", "preview", A).is_err());
    assert!(reveal_preview_value(&state, "main", "other", "preview", A).is_err());
    assert!(reveal_preview_value(&state, "main", "alpha", "preview", B).is_err());
    assert!(reveal_preview_value(&state, "main", "alpha", "unknown", A).is_err());
    state
        .previews
        .lock()
        .unwrap()
        .get_mut("preview")
        .unwrap()
        .receipt = Some(("operation".into(), vec![A.into()], "committed".into()));
    assert!(reveal_preview_value(&state, "main", "alpha", "preview", A).is_err());
    let mut entries = state.previews.lock().unwrap();
    let preview = entries.get_mut("preview").unwrap();
    preview.receipt = None;
    preview.expires = now().saturating_sub(1);
    drop(entries);
    assert!(reveal_preview_value(&state, "main", "alpha", "preview", A).is_err());
    assert!(state.previews.lock().unwrap().is_empty());
}

#[test]
fn recovery_selection_is_scoped_cancellable_bounded_and_not_an_import_package() {
    let state = TransferState::default();
    let stage = || StagedImport {
        window: "main".into(),
        workspace: "alpha".into(),
        expires: now() + TTL,
        bytes: Arc::new(Zeroizing::new(vec![1])),
        backup: Some(Arc::new(Zeroizing::new(vec![2]))),
    };
    let id = state.stage_import(stage()).unwrap();
    assert!(state.staged_package(&id, "other", "alpha").is_err());
    assert!(state.staged_package(&id, "main", "beta").is_err());
    assert!(state.staged_import(&id, "main", "alpha").is_err());
    let (key, backup) = state.staged_package(&id, "main", "alpha").unwrap();
    assert_eq!(key.as_slice(), &[1]);
    assert_eq!(backup.unwrap().as_slice(), &[2]);
    assert!(cancel(&state, "other", Some(&id), None).is_err());
    assert!(state.staged_package(&id, "main", "alpha").is_ok());
    cancel(&state, "main", Some(&id), None).unwrap();
    assert!(state.staged_package(&id, "main", "alpha").is_err());
    let mut expired = stage();
    expired.expires = now().saturating_sub(1);
    let expired = state.stage_import(expired).unwrap();
    assert!(state.staged_package(&expired, "main", "alpha").is_err());
    for _ in 0..4 {
        state.stage_import(stage()).unwrap();
    }
    assert!(state.stage_import(stage()).is_err());
    state.clear_window("main");
    assert!(state.staged_imports.lock().unwrap().is_empty());
    let mut oversized = stage();
    oversized.backup = Some(Arc::new(Zeroizing::new(vec![0; 64 * 1024 * 1024 + 1])));
    assert!(state.stage_import(oversized).is_err());
}

#[test]
fn encrypted_recovery_pair_survives_workspace_deletion_and_reversed_selection() {
    const KP: &str = "recovery key password";
    const BP: &str = "backup file password";
    let source = tempfile::tempdir().unwrap();
    let mut local = store(source.path(), 15);
    let definitions = files(source.path());
    local.set_secret(A, "detached-bearer").unwrap();
    local.set_secret(B, "detached-variable").unwrap();
    let snapshot = definitions.load().unwrap();
    let keys = KeyArchive {
        version: 1,
        workspace_id: "alpha".into(),
        keys: local
            .secret_cipher
            .export_credential_recovery_keys("alpha")
            .unwrap(),
    };
    let source_ids: Vec<_> = keys.keys.iter().map(|k| k.key_id().to_owned()).collect();
    let backup = backup(&local, &inventory(&snapshot, "alpha").unwrap(), "alpha").unwrap();
    let mut key_bytes = vec![];
    codec::encode(
        &mut key_bytes,
        ContainerKind::RecoveryKeys,
        KP,
        &serde_json::to_vec(&keys).unwrap(),
    )
    .unwrap();
    let mut backup_bytes = vec![];
    codec::encode(
        &mut backup_bytes,
        ContainerKind::CredentialBackup,
        BP,
        &serde_json::to_vec(&backup).unwrap(),
    )
    .unwrap();
    local.delete_workspace("alpha").unwrap();
    assert!(local.get_secret(A).unwrap().is_none());
    drop(local);
    drop(keys);
    drop(source); // No source database or scoped key registry survives.
    let (key, backup) = recovery_pair(
        SelectedImportFile {
            name: "backup.purrsecrets".into(),
            bytes: Zeroizing::new(backup_bytes),
        },
        SelectedImportFile {
            name: "key.purrsecrets".into(),
            bytes: Zeroizing::new(key_bytes),
        },
    )
    .unwrap();
    assert_eq!(key.name, "key.purrsecrets");
    assert_eq!(backup.name, "backup.purrsecrets");
    assert_eq!(
        decode_recovery(
            &key.bytes,
            &backup.bytes,
            "alpha",
            "wrong password",
            BP,
            || Ok(())
        )
        .err()
        .unwrap(),
        "recovery-key-unlock-failed"
    );
    assert_eq!(
        decode_recovery(
            &key.bytes,
            &backup.bytes,
            "alpha",
            KP,
            "wrong password",
            || Ok(())
        )
        .err()
        .unwrap(),
        "recovery-backup-unlock-failed"
    );
    assert_eq!(
        decode_recovery(&key.bytes, &backup.bytes, "beta", KP, BP, || Ok(()))
            .err()
            .unwrap(),
        "recovery-workspace-mismatch"
    );
    let dest = tempfile::tempdir().unwrap();
    let mut destination = store(dest.path(), 93);
    let destination_files = files(dest.path());
    // The portable definitions are exactly the same, including stable workspace and secret IDs.
    assert_eq!(
        destination_files.load().unwrap().keys().collect::<Vec<_>>(),
        snapshot.keys().collect::<Vec<_>>()
    );
    let destination_ids: Vec<_> = destination
        .secret_cipher
        .export_credential_recovery_keys("alpha")
        .unwrap()
        .iter()
        .map(|k| k.key_id().to_owned())
        .collect();
    assert_ne!(source_ids, destination_ids);
    let mismatched_keys = KeyArchive {
        version: 1,
        workspace_id: "alpha".into(),
        keys: destination
            .secret_cipher
            .export_credential_recovery_keys("alpha")
            .unwrap(),
    };
    let mut mismatched_bytes = vec![];
    codec::encode(
        &mut mismatched_bytes,
        ContainerKind::RecoveryKeys,
        KP,
        &serde_json::to_vec(&mismatched_keys).unwrap(),
    )
    .unwrap();
    assert_eq!(
        decode_recovery(&mismatched_bytes, &backup.bytes, "alpha", KP, BP, || Ok(()))
            .err()
            .unwrap(),
        "recovery-key-mismatch"
    );

    let archive = decode_recovery(&key.bytes, &backup.bytes, "alpha", KP, BP, || Ok(())).unwrap();
    let state = TransferState::default();
    let preview = prepare(
        &state,
        &destination,
        inventory(&destination_files.load().unwrap(), "alpha").unwrap(),
        "main",
        "alpha",
        archive,
        || Ok(()),
    )
    .unwrap();
    commit(
        &state,
        &mut destination,
        &destination_files,
        "main",
        "alpha",
        preview["id"].as_str().unwrap(),
        "detached-recovery",
        &[A.into(), B.into()],
        || Ok(()),
    )
    .unwrap();
    assert_eq!(
        destination.get_secret(A).unwrap().as_deref(),
        Some("detached-bearer")
    );
    assert_eq!(
        destination.get_secret(B).unwrap().as_deref(),
        Some("detached-variable")
    );
    assert_eq!(
        destination
            .secret_cipher
            .export_credential_recovery_keys("alpha")
            .unwrap()
            .iter()
            .map(|k| k.key_id().to_owned())
            .collect::<Vec<_>>(),
        destination_ids
    );
    // Purpose bytes only route files: tampering them never bypasses full authentication.
    let mut forged_key = backup.bytes.to_vec();
    forged_key[9] = ContainerKind::RecoveryKeys as u8;
    assert_eq!(
        codec::kind_hint(&forged_key).unwrap(),
        ContainerKind::RecoveryKeys
    );
    assert!(codec::decode(forged_key.as_slice(), ContainerKind::RecoveryKeys, BP).is_err());
}

#[test]
fn recovery_pair_rejects_wrong_kinds_duplicate_purposes_and_invalid_headers() {
    let file = |kind: ContainerKind| {
        let mut bytes = vec![0; 133];
        bytes[..8].copy_from_slice(b"PURRSEC\0");
        bytes[8] = 1;
        bytes[9] = kind as u8;
        SelectedImportFile {
            name: "untrusted-name".into(),
            bytes: Zeroizing::new(bytes),
        }
    };
    for (first, second) in [
        (ContainerKind::SelectedSecrets, ContainerKind::RecoveryKeys),
        (ContainerKind::RecoveryKeys, ContainerKind::RecoveryKeys),
        (
            ContainerKind::CredentialBackup,
            ContainerKind::CredentialBackup,
        ),
    ] {
        assert_eq!(
            recovery_pair(file(first), file(second)).err().unwrap(),
            "recovery-files-invalid"
        );
    }
    let mut invalid = file(ContainerKind::RecoveryKeys);
    invalid.bytes[0] = 0;
    assert_eq!(
        recovery_pair(invalid, file(ContainerKind::CredentialBackup))
            .err()
            .unwrap(),
        "recovery-files-invalid"
    );
    assert!(codec::kind_hint(&[0; 9]).is_err());
}
