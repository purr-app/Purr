use super::{
    commit_coordinator,
    local_records::{LocalRecord, LocalStateStore},
    project_files::{FileChange, FilesystemWorkspaceStore},
    secret_commits::{SecretBatch, SecretMutation},
};
use crate::security::{scoped::ProtectionScope, RootCiphers};
use serde_json::json;

static ROOT_KEY: std::sync::LazyLock<[u8; 32]> =
    std::sync::LazyLock::new(crate::security::test_key);

fn keys(directory: &std::path::Path) -> RootCiphers {
    RootCiphers::from_root(&*ROOT_KEY, false)
        .unwrap()
        .with_scope_keys(&directory.join("scope-keys.sqlite3"), "synthetic-vault")
        .unwrap()
}

#[test]
fn scoped_publication_keeps_credentials_runtime_and_receipts_separate_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("local-state.sqlite3");
    let reference = "purr/alpha/credentials/requests/r/saved/bearer";
    {
        let keys = keys(directory.path());
        let mut store = LocalStateStore::open_with_ciphers(&database, &keys).unwrap();
        store.prepare_workspace_keys("alpha").unwrap();
        store.prepare_workspace_keys("beta").unwrap();
        let project = FilesystemWorkspaceStore {
            directory: directory.path().join("projects/alpha"),
        };
        let batch = SecretBatch::fresh(vec![SecretMutation {
            reference: reference.into(),
            scope: Some(ProtectionScope::from_secret_ref(reference).unwrap()),
            expected_revision: 0,
            value: Some("synthetic-auth".into()),
        }])
        .unwrap();
        let rows = vec![LocalRecord {
            protection: Default::default(),
            table: "drafts".into(),
            id: "draft".into(),
            value: json!({"value":"private-draft"}),
        }];
        commit_coordinator::commit(
            &mut store,
            &project,
            "alpha",
            &[FileChange {
                path: "purr.yaml".into(),
                content: Some("version: 2\n".into()),
                expected_revision: None,
            }],
            &rows,
            &batch,
        )
        .unwrap();
        assert_eq!(
            store.get_secret(reference).unwrap().as_deref(),
            Some("synthetic-auth")
        );
        assert_eq!(
            store.operation(&batch.operation_id).unwrap().unwrap().0,
            "committed"
        );
        let bytes: Vec<u8> = store
            .db
            .query_row("SELECT payload FROM drafts", [], |r| r.get(0))
            .unwrap();
        let aad = "alpha/drafts/draft";
        assert!(keys
            .database
            .for_scope(ProtectionScope::WorkspaceCredential {
                workspace_id: "alpha".into()
            })
            .unwrap()
            .decrypt(&bytes, aad)
            .is_err());
        assert!(store
            .runtime_cipher("beta")
            .unwrap()
            .decrypt(&bytes, aad)
            .is_err());
        assert!(store.cipher.decrypt(&bytes, aad).is_err());
        let receipt: Vec<u8> = store
            .db
            .query_row("SELECT payload FROM secret_operations", [], |r| r.get(0))
            .unwrap();
        assert!(store
            .runtime_cipher("alpha")
            .unwrap()
            .decrypt(
                &receipt,
                &format!("purr:operation:v1|{}", batch.operation_id)
            )
            .is_err());
        let mut stale = batch.clone();
        stale.operation_id = "stale-scoped-save".into();
        stale.mutations[0].value = Some("replacement".into());
        assert!(commit_coordinator::commit(
            &mut store,
            &project,
            "alpha",
            &[],
            &[LocalRecord {
                protection: Default::default(),
                table: "drafts".into(),
                id: "draft".into(),
                value: json!({"value":"lost"})
            }],
            &stale
        )
        .is_err());
        assert_eq!(
            store.read("alpha").unwrap()[0].value["value"],
            "private-draft"
        );
        assert_eq!(
            store.get_secret(reference).unwrap().as_deref(),
            Some("synthetic-auth")
        );
        stale.mutations[0].expected_revision = 1;
        stale.mutations[0].scope = Some(ProtectionScope::runtime("alpha"));
        assert!(store.commit_secrets(&stale).is_err());
        stale.mutations[0].scope = None;
        assert!(store.commit_secrets(&stale).is_err());
        assert_eq!(store.read_secret(reference).unwrap().revision, 1);
    }
    let keys = keys(directory.path());
    let store = LocalStateStore::open_with_ciphers(&database, &keys).unwrap();
    assert_eq!(
        store.get_secret(reference).unwrap().as_deref(),
        Some("synthetic-auth")
    );
    assert_eq!(
        store.read("alpha").unwrap()[0].value["value"],
        "private-draft"
    );
    assert!(store
        .get_secret("purr/alpha/requests/old/saved/bearer")
        .is_err());
}

#[test]
fn corrupt_workspace_key_does_not_rekey_or_hide_other_workspace() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("local-state.sqlite3");
    {
        let keys = keys(directory.path());
        let mut store = LocalStateStore::open_with_ciphers(&database, &keys).unwrap();
        for workspace in ["alpha", "beta"] {
            store.prepare_workspace_keys(workspace).unwrap();
            store
                .register(workspace, &directory.path().join(workspace))
                .unwrap();
            store
                .write(
                    workspace,
                    &[LocalRecord {
                        protection: Default::default(),
                        table: "drafts".into(),
                        id: "draft".into(),
                        value: json!({"owner":workspace}),
                    }],
                )
                .unwrap();
        }
    }
    let registry = rusqlite::Connection::open(directory.path().join("scope-keys.sqlite3")).unwrap();
    let scope = serde_json::to_string(&ProtectionScope::runtime("alpha")).unwrap();
    registry
        .execute(
            "UPDATE wrapped_scope_keys SET wrapped=X'00' WHERE scope=?1",
            [&scope],
        )
        .unwrap();
    drop(registry);
    let keys = keys(directory.path());
    let store = LocalStateStore::open_with_ciphers(&database, &keys).unwrap();
    assert!(store.read("alpha").is_err());
    assert!(store.prepare_workspace_keys("alpha").is_err());
    assert_eq!(store.read("beta").unwrap()[0].value["owner"], "beta");
    assert_eq!(store.workspaces().unwrap().len(), 2);
    assert_eq!(
        store
            .db
            .query_row("SELECT COUNT(*) FROM drafts", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn unavailable_runtime_stops_history_reads_and_pruning_without_deleting_expired_data() {
    for damage in ["missing", "corrupt"] {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("local-state.sqlite3");
        let reference = "purr/alpha/runtime/history/expired/editor/auth/token";
        let before = {
            let keys = keys(directory.path());
            let mut store = LocalStateStore::open_with_ciphers(&database, &keys).unwrap();
            store.prepare_workspace_keys("alpha").unwrap();
            // Write directly so this deliberately expired fixture is not pruned by append.
            store.write("alpha", &[LocalRecord {
                protection: Default::default(),
                table: "request_executions".into(), id: "expired".into(),
                value: json!({"version":1,"documentId":"request","startedAt":1,"outcome":"response",
                    "method":"GET","url":"https://example.invalid","response":{"status":200,"text":"retained body"}}),
            }]).unwrap();
            store
                .set_secret(reference, "retained historical credential")
                .unwrap();
            [
                "SELECT payload FROM request_executions",
                "SELECT payload FROM response_bodies",
                "SELECT ciphertext FROM secret_values",
            ]
            .map(|query| {
                store
                    .db
                    .query_row(query, [], |row| row.get::<_, Vec<u8>>(0))
                    .unwrap()
            })
        };
        let registry =
            rusqlite::Connection::open(directory.path().join("scope-keys.sqlite3")).unwrap();
        let scope = serde_json::to_string(&ProtectionScope::runtime("alpha")).unwrap();
        if damage == "missing" {
            registry
                .execute("DELETE FROM wrapped_scope_keys WHERE scope=?1", [&scope])
                .unwrap();
            registry
                .execute("DELETE FROM protection_scopes WHERE scope=?1", [&scope])
                .unwrap();
        } else {
            registry
                .execute(
                    "UPDATE wrapped_scope_keys SET wrapped=X'00' WHERE scope=?1",
                    [&scope],
                )
                .unwrap();
        }
        drop(registry);
        let keys = keys(directory.path());
        let mut store = LocalStateStore::open_with_ciphers(&database, &keys).unwrap();
        assert!(
            store
                .request_history("alpha", json!({"operation":"read","id":"expired"}))
                .is_err(),
            "{damage}"
        );
        assert!(store.prune_history("alpha").is_ok(), "{damage}");
        let page = store
            .request_history("alpha", json!({"operation":"list","query":{}}))
            .unwrap();
        assert_eq!(page["items"][0]["name"], "Protected response unavailable");
        let after = [
            "SELECT payload FROM request_executions",
            "SELECT payload FROM response_bodies",
            "SELECT ciphertext FROM secret_values",
        ]
        .map(|query| {
            store
                .db
                .query_row(query, [], |row| row.get::<_, Vec<u8>>(0))
                .unwrap()
        });
        assert_eq!(
            after, before,
            "{damage} scope must preserve all expired history data"
        );
        assert_eq!(
            store
                .db
                .query_row(
                    "SELECT revision FROM secret_revisions WHERE reference=?1",
                    [reference],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }
}

#[test]
fn unregistered_ciphertext_prevents_replacement_scope_keys() {
    use crate::content::{contracts::ContentMetadata, store::ResponseContentStore};

    for owner_data in ["draft", "response", "credential"] {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("local-state.sqlite3");
        let surviving_query = match owner_data {
            "draft" => "SELECT payload FROM drafts",
            "response" => "SELECT ciphertext FROM response_content_chunks",
            _ => "SELECT ciphertext FROM secret_values",
        };
        let before = {
            let keys = keys(directory.path());
            let mut store = LocalStateStore::open_with_ciphers(&database, &keys).unwrap();
            store.prepare_workspace_keys("alpha").unwrap();
            match owner_data {
                "draft" => store
                    .write(
                        "alpha",
                        &[LocalRecord {
                            protection: Default::default(),
                            table: "drafts".into(),
                            id: "draft".into(),
                            value: json!({"text":"retained draft"}),
                        }],
                    )
                    .unwrap(),
                "response" => {
                    let mut content =
                        ResponseContentStore::open_with_ciphers(&database, &keys).unwrap();
                    let staged = content
                        .create_staging(ContentMetadata {
                            protection: Default::default(),
                            workspace_id: "alpha".into(),
                            media_type: None,
                            charset: None,
                        })
                        .unwrap();
                    content
                        .append(&staged.id, b"retained unadopted response")
                        .unwrap();
                }
                _ => store
                    .set_secret(
                        "purr/alpha/credentials/requests/r/saved/token",
                        "retained credential",
                    )
                    .unwrap(),
            }
            assert!(store.workspaces().unwrap().is_empty());
            store
                .db
                .query_row(surviving_query, [], |row| row.get::<_, Vec<u8>>(0))
                .unwrap()
        };
        let registry =
            rusqlite::Connection::open(directory.path().join("scope-keys.sqlite3")).unwrap();
        let scopes = [
            ProtectionScope::WorkspaceCredential {
                workspace_id: "alpha".into(),
            },
            ProtectionScope::runtime("alpha"),
        ]
        .map(|scope| serde_json::to_string(&scope).unwrap());
        for scope in &scopes {
            registry
                .execute("DELETE FROM wrapped_scope_keys WHERE scope=?1", [scope])
                .unwrap();
            registry
                .execute("DELETE FROM protection_scopes WHERE scope=?1", [scope])
                .unwrap();
        }
        let keys = keys(directory.path());
        let store = LocalStateStore::open_with_ciphers(&database, &keys).unwrap();
        assert!(
            store.prepare_workspace_keys("alpha").is_err(),
            "{owner_data}"
        );
        for scope in &scopes {
            assert_eq!(
                registry
                    .query_row(
                        "SELECT COUNT(*) FROM protection_scopes WHERE scope=?1",
                        [scope],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
            assert_eq!(
                registry
                    .query_row(
                        "SELECT COUNT(*) FROM wrapped_scope_keys WHERE scope=?1",
                        [scope],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
        }
        assert_eq!(
            store
                .db
                .query_row(surviving_query, [], |row| row.get::<_, Vec<u8>>(0))
                .unwrap(),
            before
        );
        store
            .prepare_workspace_keys("beta")
            .expect("unrelated fresh workspace can still provision");
    }
}

#[test]
fn scoped_schema_rejects_every_previous_schema_without_migration() {
    for populated in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let keys = keys(directory.path());
        let database = directory.path().join("local-state.sqlite3");
        let mut old = rusqlite::Connection::open(&database).unwrap();
        LocalStateStore::migrate(&mut old).unwrap();
        if populated {
            old.execute(
                "INSERT INTO drafts(workspace_id,id,payload) VALUES('old','draft',X'010203')",
                [],
            )
            .unwrap();
        }
        drop(old);
        assert!(LocalStateStore::open_with_ciphers(&database, &keys).is_err());
        let old = rusqlite::Connection::open(&database).unwrap();
        assert_eq!(
            old.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            6
        );
    }
}

#[test]
fn credential_key_failure_is_detected_before_workspace_restore_or_autosave() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("local-state.sqlite3");
    {
        let keys = keys(directory.path());
        let store = LocalStateStore::open_with_ciphers(&database, &keys).unwrap();
        store.prepare_workspace_keys("alpha").unwrap();
        store.prepare_workspace_keys("beta").unwrap();
    }
    let registry = rusqlite::Connection::open(directory.path().join("scope-keys.sqlite3")).unwrap();
    let scope = serde_json::to_string(&ProtectionScope::WorkspaceCredential {
        workspace_id: "alpha".into(),
    })
    .unwrap();
    registry
        .execute(
            "UPDATE wrapped_scope_keys SET wrapped=X'00' WHERE scope=?1",
            [&scope],
        )
        .unwrap();
    drop(registry);
    let keys = keys(directory.path());
    let store = LocalStateStore::open_with_ciphers(&database, &keys).unwrap();
    assert!(store.runtime_cipher("alpha").is_ok());
    assert!(store.validate_owner_keys("alpha").is_err());
    assert!(store.validate_owner_keys("beta").is_ok());
    assert!(store.validate_owner_keys("__global__").is_ok());
}
