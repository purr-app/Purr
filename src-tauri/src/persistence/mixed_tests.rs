use super::{
    commit_coordinator,
    local_records::{LocalRecord, LocalStateStore, RecordProtection},
    project_files::{FileChange, FilesystemWorkspaceStore},
    secret_commits::SecretBatch,
};
use crate::security::{inventory::EncryptedInventory, RootCiphers};
use serde_json::json;
fn public(table: &str, id: &str, value: serde_json::Value) -> LocalRecord {
    LocalRecord {
        table: table.into(),
        id: id.into(),
        value,
        protection: RecordProtection::Plaintext,
    }
}
#[test]
fn public_profile_commits_recovers_and_replays_without_any_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("local-state.sqlite3");
    let project = FilesystemWorkspaceStore {
        directory: dir.path().join("projects/alpha"),
    };
    let ciphers = RootCiphers::unavailable();
    let mut store = LocalStateStore::open_with_ciphers(&path, &ciphers).unwrap();
    let records = vec![public(
        "drafts",
        "request",
        json!({"url":"https://example.invalid/public","method":"GET"}),
    )];
    let changes = vec![FileChange {
        path: "purr.yaml".into(),
        content: Some("name: Public\n".into()),
        expected_revision: None,
    }];
    let batch = SecretBatch::fresh(vec![]).unwrap();
    commit_coordinator::commit(&mut store, &project, "alpha", &changes, &records, &batch).unwrap();
    assert_eq!(
        store.operation_status(&batch.operation_id).unwrap().status,
        "committed"
    );
    assert_eq!(store.read("alpha").unwrap()[0].value, records[0].value);
    assert_eq!(
        store
            .db
            .query_row("SELECT protection FROM secret_operations", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "plaintext"
    );
    drop(store);
    let mut store = LocalStateStore::open_with_ciphers(&path, &ciphers).unwrap();
    commit_coordinator::commit(&mut store, &project, "alpha", &changes, &records, &batch).unwrap();
    let inventory = EncryptedInventory::inspect(dir.path()).unwrap();
    assert!(!inventory.has_encrypted_data());
    assert!(inventory.is_public_profile());
    assert!(!dir.path().join("scope-keys.sqlite3").exists());
}
#[test]
fn unavailable_records_are_described_and_never_overwritten_by_public_projection() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("local-state.sqlite3");
    let keys = RootCiphers::from_root(&[91; 32], false)
        .unwrap()
        .with_scope_keys(&dir.path().join("scope-keys.sqlite3"), "synthetic-mixed")
        .unwrap();
    let mut store = LocalStateStore::open_with_ciphers(&path, &keys).unwrap();
    store.prepare_workspace_keys("alpha").unwrap();
    store
        .write(
            "alpha",
            &[
                public("drafts", "public", json!({"url":"public"})),
                LocalRecord {
                    table: "cookie_jar".into(),
                    id: "cookie".into(),
                    value: json!({"value":"protected-cookie-marker"}),
                    protection: RecordProtection::Encrypted,
                },
            ],
        )
        .unwrap();
    drop(store);
    let mut store = LocalStateStore::open_with_ciphers(&path, &RootCiphers::unavailable()).unwrap();
    let (records, unavailable) = store.read_partial("alpha").unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(unavailable[0]["id"], "cookie");
    assert_eq!(unavailable[0]["state"]["status"], "unavailable");
    store
        .write(
            "alpha",
            &[public("drafts", "public", json!({"url":"edited"}))],
        )
        .unwrap();
    assert!(store
        .write(
            "alpha",
            &[public("cookie_jar", "cookie", serde_json::Value::Null)]
        )
        .is_err());
    assert_eq!(
        store
            .db
            .query_row("SELECT COUNT(*) FROM cookie_jar", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(EncryptedInventory::inspect(dir.path())
        .unwrap()
        .has_encrypted_data());
}
#[test]
fn public_history_roundtrips_body_summary_and_receipt_without_key() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = LocalStateStore::open_with_ciphers(
        &dir.path().join("local-state.sqlite3"),
        &RootCiphers::unavailable(),
    )
    .unwrap();
    let entry = json!({"version":1,"protection":"plaintext","id":"execution","documentId":"r","startedAt":1,"name":"Public request","kind":"http","method":"GET","url":"https://example.invalid","outcome":"response","size":4,"status":200,"durationMs":1,"editor":{},"response":{"status":200,"text":"body","bodyBase64":"Ym9keQ=="},"files":{},"error":""});
    store
        .request_history("alpha", json!({"operation":"append","entry":entry}))
        .unwrap();
    let loaded = store
        .request_history("alpha", json!({"operation":"read","id":"execution"}))
        .unwrap();
    assert_eq!(loaded["response"]["text"], "body");
    assert_eq!(
        store
            .request_history("alpha", json!({"operation":"list","query":{}}))
            .unwrap()["items"][0]["name"],
        "Public request"
    );
    assert!(!EncryptedInventory::inspect(dir.path())
        .unwrap()
        .has_encrypted_data());
}
#[test]
fn public_commit_interruption_recovers_without_publishing_protected_state() {
    use super::commit_coordinator::{commit_with_hook, CommitStep};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("local-state.sqlite3");
    let project = FilesystemWorkspaceStore {
        directory: dir.path().join("projects/alpha"),
    };
    let mut store = LocalStateStore::open_with_ciphers(&path, &RootCiphers::unavailable()).unwrap();
    let records = vec![public("drafts", "r", json!({"url":"public"}))];
    let files = vec![FileChange {
        path: "purr.yaml".into(),
        content: Some("name: Public\n".into()),
        expected_revision: None,
    }];
    let batch = SecretBatch::fresh(vec![]).unwrap();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = commit_with_hook(
            &mut store,
            &project,
            "alpha",
            &files,
            &records,
            &batch,
            |step| {
                if step == CommitStep::BeforePublication {
                    panic!("synthetic interruption")
                };
                Ok(())
            },
        );
    }));
    assert_eq!(
        store
            .db
            .query_row("SELECT protection FROM pending_commits", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "plaintext"
    );
    drop(store);
    let mut store = LocalStateStore::open_with_ciphers(&path, &RootCiphers::unavailable()).unwrap();
    for (id, journal) in store.pending().unwrap() {
        commit_coordinator::recover(&mut store, &project, &id, journal).unwrap();
    }
    assert!(store.read("alpha").unwrap().is_empty());
    assert!(project.read("purr.yaml").unwrap().is_none());
    assert_eq!(
        store.operation_status(&batch.operation_id).unwrap().status,
        "aborted"
    );
}
#[test]
fn unreadable_ciphertext_cannot_be_deleted_or_downgraded_and_history_policy_is_immutable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("local-state.sqlite3");
    let keys = RootCiphers::from_root(&[81; 32], false)
        .unwrap()
        .with_scope_keys(
            &dir.path().join("scope-keys.sqlite3"),
            "synthetic-corruption",
        )
        .unwrap();
    let mut store = LocalStateStore::open_with_ciphers(&path, &keys).unwrap();
    store.prepare_workspace_keys("alpha").unwrap();
    store
        .write(
            "alpha",
            &[LocalRecord {
                protection: RecordProtection::Encrypted,
                table: "drafts".into(),
                id: "r".into(),
                value: json!({"protected":"marker"}),
            }],
        )
        .unwrap();
    store
        .db
        .execute("UPDATE drafts SET payload=X'00'", [])
        .unwrap();
    for value in [json!({"public":"replacement"}), serde_json::Value::Null] {
        assert!(store
            .write("alpha", &[public("drafts", "r", value)])
            .is_err());
    }
    assert_eq!(
        store
            .db
            .query_row("SELECT payload FROM drafts", [], |r| r.get::<_, Vec<u8>>(0))
            .unwrap(),
        [0]
    );
    store.write("alpha",&[LocalRecord{protection:RecordProtection::Encrypted,table:"request_executions".into(),id:"e".into(),value:json!({"documentId":"r","response":{"status":200,"text":"original protected body"}})}]).unwrap();
    assert!(store
        .write(
            "alpha",
            &[public(
                "request_executions",
                "e",
                json!({"documentId":"r","response":{"status":200,"text":"public body"}})
            )]
        )
        .is_err());
    assert_eq!(
        store
            .db
            .query_row("SELECT protection FROM request_executions", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "encrypted"
    );
}
#[test]
fn missing_reference_requires_available_scope_before_secret_preparation() {
    let dir = tempfile::tempdir().unwrap();
    let store = LocalStateStore::open_with_ciphers(
        &dir.path().join("local-state.sqlite3"),
        &RootCiphers::unavailable(),
    )
    .unwrap();
    assert_eq!(
        store
            .read_secret_typed("purr/alpha/runtime/history/id/snapshot")
            .err()
            .unwrap()
            .status,
        crate::security::ProtectedStatus::Unavailable
    );
    assert_eq!(
        store
            .db
            .query_row("SELECT COUNT(*) FROM secret_values", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
