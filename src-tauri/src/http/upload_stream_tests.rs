use super::stream_reader;
use crate::{
    content::{actor::ResponseContentHandle, store::ResponseContentStore},
    http::{perform_http_with_files, HttpClient, HttpRequest},
    persistence::{
        attachments::{AttachmentMetadata, AttachmentSource, CHUNK_BYTES},
        local_records::{LocalRecord, LocalStateStore, RecordProtection},
    },
    security::tests::MemoryRootKeyStore,
};
use serde_json::{json, Value};
use std::{
    io::{self, Read},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
#[path = "../../../tests/fixtures/upload-http-server.rs"]
mod server;

fn protected_source(
    directory: &tempfile::TempDir,
    chunks: usize,
) -> (LocalStateStore, AttachmentSource, Vec<u8>) {
    let mut store = LocalStateStore::open(
        &directory.path().join("attachments.sqlite3"),
        &MemoryRootKeyStore::default(),
    )
    .unwrap();
    let stage = "99999999-9999-4999-8999-999999999999";
    let bytes = (0..CHUNK_BYTES * chunks + 19)
        .map(|i| (i % 251) as u8)
        .collect::<Vec<_>>();
    store
        .begin_attachment(
            "workspace",
            "main",
            stage,
            AttachmentMetadata {
                name: "protected.bin".into(),
                media_type: "application/octet-stream".into(),
                size: bytes.len() as u64,
                last_modified: 0,
            },
        )
        .unwrap();
    for (i, chunk) in bytes.chunks(CHUNK_BYTES).enumerate() {
        store
            .append_attachment("workspace", "main", stage, i as u64, chunk)
            .unwrap();
    }
    let prepared = store.finish_attachment("workspace", "main", stage).unwrap();
    store
        .write(
            "workspace",
            &[LocalRecord {
                table: "attachments".into(),
                id: prepared.attachment_id.clone(),
                protection: RecordProtection::Encrypted,
                value: prepared.record,
            }],
        )
        .unwrap();
    let source = store
        .prepare_attachment("workspace", &prepared.attachment_id)
        .unwrap();
    (store, source, bytes)
}
fn reference(source: &AttachmentSource) -> Value {
    json!({"id":"protected-test-handle","name":source.name,"size":source.byte_length,"mediaType":source.media_type})
}
fn request(url: String, body: Value) -> HttpRequest {
    serde_json::from_value(json!({"workspaceId":"workspace","method":"POST","url":url,"headers":[["Content-Length","999"]],"bodyBase64":null,"bodySource":body,"responseStorage":{"protection":"plaintext"}})).unwrap()
}
fn content(directory: &tempfile::TempDir) -> ResponseContentHandle {
    ResponseContentHandle::for_test(
        ResponseContentStore::open(
            &directory.path().join("responses.sqlite3"),
            &MemoryRootKeyStore::default(),
        )
        .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn protected_binary_reopens_after_307_and_308_with_exact_length() {
    let directory = tempfile::tempdir().unwrap();
    let (_store, source, expected) = protected_source(&directory, 3);
    let server = server::UploadServer::start(vec![307, 308, 200]);
    let content = content(&directory);
    for status in [307, 308, 200] {
        let (_cancel, cancellation) = tokio::sync::watch::channel(false);
        let response = perform_http_with_files(
            request(
                format!("http://{}/upload", server.address),
                json!({"kind":"file","reference":reference(&source)}),
            ),
            &HttpClient::default().0,
            &content,
            &|_| Ok(stream_reader(Box::new(source.open()?))),
            cancellation,
            |_| {},
        )
        .await
        .unwrap();
        let value = serde_json::to_value(&response).unwrap();
        assert_eq!(value["status"], status);
        content
            .release(
                serde_json::to_value(&response).unwrap()["content"]["id"]
                    .as_str()
                    .unwrap()
                    .into(),
            )
            .await
            .unwrap();
    }
    for captured in server.finish() {
        assert_eq!(captured.body, expected);
        assert_eq!(captured.declared_length, expected.len());
        assert!(!captured
            .headers
            .to_ascii_lowercase()
            .contains("transfer-encoding"));
    }
}

#[tokio::test]
async fn protected_multipart_sends_exact_payload_and_known_total_length() {
    let directory = tempfile::tempdir().unwrap();
    let (_store, source, expected) = protected_source(&directory, 2);
    let server = server::UploadServer::start(vec![200]);
    let content = content(&directory);
    let (_cancel, cancellation) = tokio::sync::watch::channel(false);
    let response=perform_http_with_files(request(format!("http://{}/multipart",server.address),json!({"kind":"multipart","parts":[{"kind":"text","name":"note","value":"synthetic note","mediaType":"text/plain"},{"kind":"file","name":"upload","reference":reference(&source)}]})),&HttpClient::default().0,&content,&|_|Ok(stream_reader(Box::new(source.open()?))),cancellation,|_|{}).await.unwrap();
    content
        .release(
            serde_json::to_value(&response).unwrap()["content"]["id"]
                .as_str()
                .unwrap()
                .into(),
        )
        .await
        .unwrap();
    let captured = server.finish().pop().unwrap();
    assert_eq!(captured.body.len(), captured.declared_length);
    assert!(captured
        .body
        .windows(expected.len())
        .any(|window| window == expected));
    let body = String::from_utf8_lossy(&captured.body);
    assert!(body.contains("filename=\"protected.bin\""));
    assert!(body.contains("name=\"note\""));
    assert!(body.contains("synthetic note"));
}
struct ObservedReader {
    reader: Box<dyn Read + Send>,
    dropped: Arc<AtomicBool>,
}
impl Read for ObservedReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        self.reader.read(out)
    }
}
impl Drop for ObservedReader {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
    }
}
#[tokio::test]
async fn cancelling_a_protected_upload_drops_the_decrypting_reader() {
    let directory = tempfile::tempdir().unwrap();
    let (_store, source, _) = protected_source(&directory, 64);
    let mut server = server::PausedUpload::start();
    let content = content(&directory);
    let (cancel, cancellation) = tokio::sync::watch::channel(false);
    let dropped = Arc::new(AtomicBool::new(false));
    let resolver = |_: &crate::http::request_body::RequestFileRef| {
        Ok(stream_reader(Box::new(ObservedReader {
            reader: Box::new(source.open()?),
            dropped: dropped.clone(),
        })))
    };
    let client = HttpClient::default();
    let operation = perform_http_with_files(
        request(
            format!("http://{}/paused", server.address),
            json!({"kind":"file","reference":reference(&source)}),
        ),
        &client.0,
        &content,
        &resolver,
        cancellation,
        |_| {},
    );
    tokio::pin!(operation);
    tokio::select! {result=&mut operation=>panic!("upload completed before cancellation: {:?}",result.err()),_=&mut server.started=>{}}
    cancel.send(true).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), &mut operation)
            .await
            .unwrap()
            .unwrap_err(),
        "Request cancelled."
    );
    tokio::time::timeout(Duration::from_secs(3), async {
        while !dropped.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    server.finish();
}
