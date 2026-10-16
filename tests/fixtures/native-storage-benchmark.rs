// Synthetic, OS-independent S04/S05 comparison. Included only by an ignored test.
use crate::persistence::{
    commit_coordinator,
    local_records::{LocalRecord, LocalStateStore},
    project_files::FilesystemWorkspaceStore,
    secret_commits::SecretBatch,
};
use crate::security::RootCiphers;
use serde_json::json;
use std::time::Instant;
#[test]
#[ignore = "synthetic performance measurement; run explicitly with --nocapture"]
fn native_storage_comparison() {
    for protection in ["encrypted", "plaintext"] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("local-state.sqlite3");
        let keys = RootCiphers::from_root(&[37; 32], false)
            .unwrap()
            .with_scope_keys(
                &dir.path().join("scope-keys.sqlite3"),
                "synthetic-benchmark",
            )
            .unwrap();
        let mut store = LocalStateStore::open_with_ciphers(&path, &keys).unwrap();
        store.prepare_workspace_keys("bench").unwrap();
        let record = |table: &str, id: String, value: serde_json::Value| -> LocalRecord {
            serde_json::from_value(
                json!({"table":table,"id":id,"value":value,"protection":protection}),
            )
            .unwrap()
        };
        let rows=(0..2000).map(|i|record("drafts",format!("r-{i}"),json!({"method":"GET","url":format!("https://example.invalid/{i}"),"body":"x".repeat(2048)}))).collect::<Vec<_>>();
        store.write("bench", &rows).unwrap();
        let start = Instant::now();
        for _ in 0..5 {
            let rows = store.read("bench").unwrap();
            assert_eq!(rows.len(), 2000);
        }
        let load_ms = start.elapsed().as_secs_f64() * 1000.0 / 5.0;
        let project = FilesystemWorkspaceStore {
            directory: dir.path().join("projects/bench"),
        };
        let start = Instant::now();
        for i in 0..100 {
            let row = record(
                "drafts",
                "r-0".into(),
                json!({"url":format!("https://example.invalid/edit-{i}")}),
            );
            commit_coordinator::commit(
                &mut store,
                &project,
                "bench",
                &[],
                &[row],
                &SecretBatch::fresh(vec![]).unwrap(),
            )
            .unwrap();
        }
        let save_ms = start.elapsed().as_secs_f64() * 10.0;
        let history=(0..1000).map(|i|record("request_executions",format!("e-{i}"),json!({"version":1,"documentId":"r","startedAt":9_000_000_000_000_i64+i,"name":format!("Request {i}"),"method":"GET","kind":"http","url":format!("https://example.invalid/search/{i}"),"durationMs":1,"outcome":"response","status":200,"size":4,"response":{"status":200,"text":"body"},"files":{}}))).collect::<Vec<_>>();
        store.write("bench", &history).unwrap();
        let start = Instant::now();
        for _ in 0..5 {
            let page = store
                .request_history(
                    "bench",
                    json!({"operation":"list","query":{"search":"999","limit":100}}),
                )
                .unwrap();
            assert_eq!(page["items"].as_array().unwrap().len(), 1);
        }
        let search_ms = start.elapsed().as_secs_f64() * 1000.0 / 5.0;
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
        unsafe {
            libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr());
        }
        let rss = unsafe { usage.assume_init() }.ru_maxrss;
        println!("PURR_STORAGE_BENCH protection={protection} load_2000_ms={load_ms:.3} autosave_ms={save_ms:.3} search_1000_ms={search_ms:.3} peak_rss_native_units={rss}");
    }
}
