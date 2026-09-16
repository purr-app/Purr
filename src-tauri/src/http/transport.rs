use base64::{engine::general_purpose::STANDARD, Engine};
use hyper_util::client::legacy::connect::HttpInfo;
use reqwest::{
    header::{HeaderName, HeaderValue},
    Client, Method, Url,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    future::pending,
    time::{Duration, Instant},
};
use tokio::sync::watch;

use super::request_body::{stream_file, RequestBodyPart, RequestBodySource, RequestFileRef};
use crate::content::{
    actor::{PendingContentWrite, ResponseContentHandle},
    contracts::{ContentMetadata, ResponseContentRef},
};

const MAX_RESPONSE_BYTES: u64 = 128 * 1024 * 1024;
const WRITE_BATCH_BYTES: usize = 8 * 1024 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const PROGRESS_BYTES: u64 = 1024 * 1024;

#[derive(Default)]
struct LineStatistics {
    bytes: u64,
    newline_count: u64,
    current_line_bytes: u64,
    max_line_bytes: u64,
}

impl LineStatistics {
    fn observe(&mut self, bytes: &[u8]) {
        self.bytes += bytes.len() as u64;
        for byte in bytes {
            if *byte == b'\n' {
                self.max_line_bytes = self.max_line_bytes.max(self.current_line_bytes);
                self.current_line_bytes = 0;
                self.newline_count += 1;
            } else {
                self.current_line_bytes += 1;
            }
        }
    }

    fn apply(self, reference: &mut ResponseContentRef) {
        reference.line_count = Some(if self.bytes == 0 {
            0
        } else {
            self.newline_count + 1
        });
        reference.max_line_bytes = Some(self.max_line_bytes.max(self.current_line_bytes));
    }
}

pub struct HttpClient(pub Client);

impl Default for HttpClient {
    fn default() -> Self {
        Self(
            Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(60))
                .build()
                .expect("HTTP client"),
        )
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body_base64: Option<String>,
    #[serde(default)]
    body_source: Option<RequestBodySource>,
    #[serde(default)]
    response_storage: ResponseStoragePolicy,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResponseStoragePolicy {
    #[serde(default)]
    protection: ResponseContentProtection,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResponseContentProtection {
    #[default]
    Encrypted,
    Plaintext,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpPipelineTimings {
    setup_ms: f64,
    network_ms: f64,
    encryption_ms: f64,
    sqlite_write_ms: f64,
    storage_backpressure_ms: f64,
    native_total_ms: f64,
}

impl HttpResponse {
    pub fn include_setup_timing(&mut self, setup: Duration) {
        self.pipeline_timings.setup_ms += milliseconds(setup);
        self.pipeline_timings.native_total_ms += milliseconds(setup);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    content: ResponseContentRef,
    duration_ms: u128,
    headers_duration_ms: u128,
    download_duration_ms: u128,
    http_version: String,
    local_address: Option<String>,
    remote_address: Option<String>,
    pipeline_timings: HttpPipelineTimings,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HttpEvent {
    Headers {
        status: u16,
        headers: Vec<(String, String)>,
        #[serde(skip_serializing_if = "Option::is_none")]
        total_bytes: Option<u64>,
    },
    Progress {
        received_bytes: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        total_bytes: Option<u64>,
    },
    Complete {
        response: Box<HttpResponse>,
    },
}

pub fn http_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Enter a valid HTTP or HTTPS URL.")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Only HTTP and HTTPS URLs are supported.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Use the Auth tab for credentials instead of putting them in the URL.".into());
    }
    Ok(url)
}

async fn cancelled(receiver: &mut watch::Receiver<bool>) {
    loop {
        if *receiver.borrow() {
            return;
        }
        if receiver.changed().await.is_err() {
            pending::<()>().await;
        }
    }
}

fn request_error(error: reqwest::Error) -> String {
    // Never include reqwest's URL-bearing errors: query strings can contain API keys.
    if error.is_timeout() {
        "Request timed out."
    } else if error.is_connect() {
        "Connection failed. Check the host, network and TLS certificate."
    } else {
        "Could not send the HTTP request."
    }
    .into()
}

fn content_metadata(headers: &[(String, String)]) -> ContentMetadata {
    let Some(value) = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
        .map(|(_, value)| value)
    else {
        return ContentMetadata {
            media_type: None,
            charset: None,
        };
    };
    let mut parts = value.split(';');
    let media_type = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);
    let charset = parts.find_map(|part| {
        let (name, value) = part.split_once('=')?;
        name.trim()
            .eq_ignore_ascii_case("charset")
            .then(|| value.trim().trim_matches('"').to_ascii_lowercase())
            .filter(|value| !value.is_empty())
    });
    ContentMetadata {
        media_type,
        charset,
    }
}

async fn enqueue_batch(
    content: &ResponseContentHandle,
    content_id: &str,
    bytes: Vec<u8>,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<(PendingContentWrite, Duration), String> {
    let started = Instant::now();
    let enqueue = content.enqueue_append(content_id.into(), bytes);
    tokio::pin!(enqueue);
    tokio::select! {
        _ = cancelled(cancellation) => Err("Request cancelled.".into()),
        result = &mut enqueue => result.map(|pending| (pending, started.elapsed())),
    }
}

async fn await_write(
    pending: PendingContentWrite,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<(crate::content::store::ContentWriteTiming, Duration), String> {
    let started = Instant::now();
    let wait = pending.wait();
    tokio::pin!(wait);
    tokio::select! {
        _ = cancelled(cancellation) => Err("Request cancelled.".into()),
        result = &mut wait => result.map(|timing| (timing, started.elapsed())),
    }
}

fn milliseconds(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

#[cfg(test)]
async fn perform_http(
    request: HttpRequest,
    client: &Client,
    content: &ResponseContentHandle,
    cancellation: watch::Receiver<bool>,
    emit: impl Fn(HttpEvent),
) -> Result<HttpResponse, String> {
    perform_http_with_files(
        request,
        client,
        content,
        &|_reference| Err("Native request file service is unavailable.".into()),
        cancellation,
        emit,
    )
    .await
}

pub async fn perform_http_with_files(
    request: HttpRequest,
    client: &Client,
    content: &ResponseContentHandle,
    resolve_file: &(impl Fn(&RequestFileRef) -> Result<std::path::PathBuf, String> + Sync),
    mut cancellation: watch::Receiver<bool>,
    emit: impl Fn(HttpEvent),
) -> Result<HttpResponse, String> {
    if *cancellation.borrow() {
        return Err("Request cancelled.".into());
    }
    let url = http_url(&request.url)?;
    if request.response_storage.protection != ResponseContentProtection::Encrypted {
        return Err("Plaintext response storage is not enabled in this build.".into());
    }
    let method =
        Method::from_bytes(request.method.as_bytes()).map_err(|_| "Invalid HTTP method.")?;
    if request.body_base64.is_some() && request.body_source.is_some() {
        return Err("Request body has multiple sources.".into());
    }
    let multipart = matches!(
        request.body_source,
        Some(RequestBodySource::Multipart { .. })
    );
    let streamed_body = request.body_source.is_some();
    let mut builder = client.request(method, url);
    for (name, value) in request.headers {
        if (multipart && name.eq_ignore_ascii_case("content-type"))
            || (streamed_body && name.eq_ignore_ascii_case("content-length"))
        {
            continue;
        }
        let name =
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| "Invalid HTTP header name.")?;
        let value = HeaderValue::from_str(&value).map_err(|_| "Invalid HTTP header value.")?;
        builder = builder.header(name, value);
    }
    if let Some(body) = request.body_base64 {
        builder = builder.body(
            STANDARD
                .decode(body)
                .map_err(|_| "Invalid body encoding.")?,
        );
    }
    if let Some(source) = request.body_source {
        builder = match source {
            RequestBodySource::File { reference } => {
                let path = resolve_file(&reference)?;
                builder
                    .header(reqwest::header::CONTENT_LENGTH, reference.size)
                    .body(stream_file(&path)?)
            }
            RequestBodySource::Multipart { parts } => {
                let mut form = reqwest::multipart::Form::new();
                for part in parts {
                    form = match part {
                        RequestBodyPart::Text {
                            name,
                            value,
                            media_type,
                        } => {
                            let part = reqwest::multipart::Part::text(value)
                                .mime_str(&media_type)
                                .map_err(|_| "Invalid multipart media type.")?;
                            form.part(name, part)
                        }
                        RequestBodyPart::File { name, reference } => {
                            let path = resolve_file(&reference)?;
                            let part = reqwest::multipart::Part::stream_with_length(
                                stream_file(&path)?,
                                reference.size,
                            )
                            .file_name(reference.name.clone())
                            .mime_str(&reference.media_type)
                            .map_err(|_| "Invalid multipart file media type.")?;
                            form.part(name, part)
                        }
                    };
                }
                builder.multipart(form)
            }
        };
    }

    let started = Instant::now();
    let send = builder.send();
    tokio::pin!(send);
    let mut response = tokio::select! {
        _ = cancelled(&mut cancellation) => return Err("Request cancelled.".into()),
        result = &mut send => result.map_err(request_error)?,
    };
    let headers_duration = started.elapsed();
    let remote_address = response.remote_addr().map(|address| address.to_string());
    let local_address = response
        .extensions()
        .get::<HttpInfo>()
        .map(|info| info.local_addr().to_string());
    let status = response.status();
    let http_version = match response.version() {
        reqwest::Version::HTTP_09 => "HTTP/0.9",
        reqwest::Version::HTTP_10 => "HTTP/1.0",
        reqwest::Version::HTTP_11 => "HTTP/1.1",
        reqwest::Version::HTTP_2 => "HTTP/2",
        reqwest::Version::HTTP_3 => "HTTP/3",
        _ => "HTTP",
    }
    .to_string();
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.to_string(),
                String::from_utf8_lossy(value.as_bytes()).into_owned(),
            )
        })
        .collect();
    let total_bytes = response.content_length();
    emit(HttpEvent::Headers {
        status: status.as_u16(),
        headers: headers.clone(),
        total_bytes,
    });

    let staging = content.create_staging(content_metadata(&headers)).await?;
    let content_id = staging.id;
    let capture = async {
        let mut pending_bytes = Vec::with_capacity(WRITE_BATCH_BYTES);
        let mut pending_writes = VecDeque::new();
        let mut received_bytes = 0_u64;
        let mut reported_bytes = 0_u64;
        let mut last_progress = Instant::now();
        let mut storage_backpressure = Duration::ZERO;
        let mut encryption = Duration::ZERO;
        let mut sqlite_write = Duration::ZERO;
        let mut line_statistics = LineStatistics::default();
        loop {
            let next = tokio::select! {
                _ = cancelled(&mut cancellation) => return Err("Request cancelled.".into()),
                result = response.chunk() => result.map_err(|_| "Could not read the response body.")?,
            };
            let Some(chunk) = next else { break };
            received_bytes = received_bytes
                .checked_add(chunk.len() as u64)
                .ok_or("Response exceeds the 128 MiB capture limit.")?;
            if received_bytes > MAX_RESPONSE_BYTES {
                return Err("Response exceeds the 128 MiB capture limit.".into());
            }
            line_statistics.observe(&chunk);
            pending_bytes.extend_from_slice(&chunk);
            while pending_bytes.len() >= WRITE_BATCH_BYTES {
                let remainder = pending_bytes.split_off(WRITE_BATCH_BYTES);
                let (pending, waited) =
                    enqueue_batch(content, &content_id, pending_bytes, &mut cancellation).await?;
                storage_backpressure += waited;
                pending_writes.push_back(pending);
                if pending_writes.len() >= 2 {
                    let (timing, waited) = await_write(
                        pending_writes
                            .pop_front()
                            .expect("pending response write"),
                        &mut cancellation,
                    )
                    .await?;
                    storage_backpressure += waited;
                    encryption += timing.encryption;
                    sqlite_write += timing.sqlite;
                }
                pending_bytes = remainder;
            }
            if received_bytes.saturating_sub(reported_bytes) >= PROGRESS_BYTES
                || last_progress.elapsed() >= PROGRESS_INTERVAL
            {
                emit(HttpEvent::Progress {
                    received_bytes,
                    total_bytes,
                });
                reported_bytes = received_bytes;
                last_progress = Instant::now();
            }
        }
        let network_completed = started.elapsed().saturating_sub(storage_backpressure);
        if !pending_bytes.is_empty() {
            let (pending, waited) =
                enqueue_batch(content, &content_id, pending_bytes, &mut cancellation).await?;
            storage_backpressure += waited;
            pending_writes.push_back(pending);
        }
        if received_bytes != reported_bytes {
            emit(HttpEvent::Progress {
                received_bytes,
                total_bytes,
            });
        }
        for pending in pending_writes {
            let (timing, waited) = await_write(pending, &mut cancellation).await?;
            storage_backpressure += waited;
            encryption += timing.encryption;
            sqlite_write += timing.sqlite;
        }
        let finish = content.finish(content_id.clone());
        tokio::pin!(finish);
        tokio::select! {
            _ = cancelled(&mut cancellation) => Err("Request cancelled.".into()),
            result = &mut finish => result,
        }.map(|mut reference| {
            line_statistics.apply(&mut reference);
            (reference, network_completed, encryption, sqlite_write, storage_backpressure)
        })
    }
    .await;

    let (reference, network_duration, encryption, sqlite_write, storage_backpressure) =
        match capture {
            Ok(result) => result,
            Err(error) => {
                let _ = content.release(content_id).await;
                return Err(error);
            }
        };
    let native_total = started.elapsed();
    let result = HttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").into(),
        headers,
        content: reference,
        duration_ms: network_duration.as_millis(),
        headers_duration_ms: headers_duration.as_millis(),
        download_duration_ms: network_duration
            .saturating_sub(headers_duration)
            .as_millis(),
        http_version,
        local_address,
        remote_address,
        pipeline_timings: HttpPipelineTimings {
            setup_ms: 0.0,
            network_ms: milliseconds(network_duration),
            encryption_ms: milliseconds(encryption),
            sqlite_write_ms: milliseconds(sqlite_write),
            storage_backpressure_ms: milliseconds(storage_backpressure),
            native_total_ms: milliseconds(native_total),
        },
    };
    emit(HttpEvent::Complete {
        response: Box::new(result.clone()),
    });
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{content::store::ResponseContentStore, security::RootKeyStore};
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
        thread,
    };
    use tempfile::TempDir;

    fn read_request(stream: &mut std::net::TcpStream) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let count = stream.read(&mut buffer).unwrap();
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..count]);
            let Some(headers_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n")
            else {
                continue;
            };
            let header_text = String::from_utf8_lossy(&bytes[..headers_end]);
            let length = header_text
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            if bytes.len() >= headers_end + 4 + length {
                break;
            }
        }
        bytes
    }

    #[derive(Default)]
    struct MemoryRootKey(Mutex<Option<String>>);
    impl RootKeyStore for MemoryRootKey {
        fn get_root_key(&self) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn set_root_key(&self, value: &str) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(value.into());
            Ok(())
        }
    }

    fn content_handle(directory: &TempDir) -> ResponseContentHandle {
        ResponseContentHandle::for_test(
            ResponseContentStore::open(
                &directory.path().join("state.sqlite3"),
                &MemoryRootKey::default(),
            )
            .unwrap(),
        )
        .unwrap()
    }

    fn request(url: String) -> HttpRequest {
        HttpRequest {
            url,
            method: "GET".into(),
            headers: Vec::new(),
            body_base64: None,
            body_source: None,
            response_storage: ResponseStoragePolicy::default(),
        }
    }

    #[test]
    fn progress_events_use_frontend_camel_case_fields() {
        let value = serde_json::to_value(HttpEvent::Progress {
            received_bytes: 1024,
            total_bytes: Some(2048),
        })
        .unwrap();
        assert_eq!(value["type"], "progress");
        assert_eq!(value["receivedBytes"], 1024);
        assert_eq!(value["totalBytes"], 2048);
        assert!(value.get("received_bytes").is_none());
    }

    #[test]
    fn response_storage_policy_defaults_encrypted_and_accepts_future_plaintext_value() {
        let encrypted: HttpRequest = serde_json::from_value(serde_json::json!({
            "url": "https://example.com",
            "method": "GET",
            "headers": [],
            "bodyBase64": null
        }))
        .unwrap();
        assert_eq!(
            encrypted.response_storage.protection,
            ResponseContentProtection::Encrypted
        );
        let plaintext: HttpRequest = serde_json::from_value(serde_json::json!({
            "url": "https://example.com",
            "method": "GET",
            "headers": [],
            "bodyBase64": null,
            "responseStorage": { "protection": "plaintext" }
        }))
        .unwrap();
        assert_eq!(
            plaintext.response_storage.protection,
            ResponseContentProtection::Plaintext
        );
    }

    #[tokio::test]
    async fn native_file_body_is_byte_exact_and_repeatable() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let expected = vec![0, 1, 2, 127, 128, 254, 255, 42];
        let expected_for_server = expected.clone();
        let server = thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_request(&mut stream);
                let split = request
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .unwrap()
                    + 4;
                let headers = String::from_utf8_lossy(&request[..split]);
                let content_lengths: Vec<_> = headers
                    .lines()
                    .filter(|line| line.to_ascii_lowercase().starts_with("content-length:"))
                    .collect();
                assert_eq!(
                    content_lengths,
                    [format!("content-length: {}", expected_for_server.len())]
                );
                assert_eq!(&request[split..], expected_for_server.as_slice());
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .unwrap();
            }
        });
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("payload.bin");
        std::fs::write(&path, &expected).unwrap();
        let reference = RequestFileRef {
            id: "request-file-test".into(),
            name: "payload.bin".into(),
            size: expected.len() as u64,
            media_type: "application/octet-stream".into(),
        };
        let content = content_handle(&directory);
        for _ in 0..2 {
            let (_, cancellation) = watch::channel(false);
            let result = perform_http_with_files(
                HttpRequest {
                    url: format!("http://{address}/upload"),
                    method: "POST".into(),
                    headers: vec![
                        ("Content-Type".into(), "application/octet-stream".into()),
                        ("Content-Length".into(), "999".into()),
                    ],
                    body_base64: None,
                    body_source: Some(RequestBodySource::File {
                        reference: reference.clone(),
                    }),
                    response_storage: ResponseStoragePolicy::default(),
                },
                &HttpClient::default().0,
                &content,
                &|candidate| {
                    (candidate == &reference)
                        .then(|| path.clone())
                        .ok_or("stale".into())
                },
                cancellation,
                |_| {},
            )
            .await
            .unwrap();
            content.release(result.content.id).await.unwrap();
        }
        server.join().unwrap();
    }

    #[tokio::test]
    async fn multipart_file_stream_preserves_name_type_and_bytes() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            let text = String::from_utf8_lossy(&request);
            assert!(!text.contains("Content-Length: 999"));
            assert!(text.contains("name=\"note\""));
            assert!(text.contains("hello multipart"));
            assert!(text.contains("name=\"upload\""));
            assert!(text.contains("filename=\"payload.txt\""));
            assert!(text.contains("Content-Type: text/plain"));
            assert!(request.windows(6).any(|window| window == b"a\0b\xffz\n"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .unwrap();
        });
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("payload.txt");
        std::fs::write(&path, b"a\0b\xffz\n").unwrap();
        let reference = RequestFileRef {
            id: "request-file-multipart".into(),
            name: "payload.txt".into(),
            size: 6,
            media_type: "text/plain".into(),
        };
        let content = content_handle(&directory);
        let (_, cancellation) = watch::channel(false);
        let result = perform_http_with_files(
            HttpRequest {
                url: format!("http://{address}/multipart"),
                method: "POST".into(),
                headers: vec![(
                    "Content-Type".into(),
                    "multipart/form-data; boundary=ignored".into(),
                )],
                body_base64: None,
                body_source: Some(RequestBodySource::Multipart {
                    parts: vec![
                        RequestBodyPart::Text {
                            name: "note".into(),
                            value: "hello multipart".into(),
                            media_type: "text/plain".into(),
                        },
                        RequestBodyPart::File {
                            name: "upload".into(),
                            reference: reference.clone(),
                        },
                    ],
                }),
                response_storage: ResponseStoragePolicy::default(),
            },
            &HttpClient::default().0,
            &content,
            &|candidate| {
                (candidate == &reference)
                    .then(|| path.clone())
                    .ok_or("stale".into())
            },
            cancellation,
            |_| {},
        )
        .await
        .unwrap();
        content.release(result.content.id).await.unwrap();
        server.join().unwrap();
    }

    #[tokio::test]
    async fn plaintext_response_storage_fails_closed_until_implemented() {
        let directory = TempDir::new().unwrap();
        let content = content_handle(&directory);
        let (_, cancellation) = watch::channel(false);
        let error = perform_http(
            HttpRequest {
                response_storage: ResponseStoragePolicy {
                    protection: ResponseContentProtection::Plaintext,
                },
                ..request("https://example.com".into())
            },
            &HttpClient::default().0,
            &content,
            cancellation,
            |_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(
            error,
            "Plaintext response storage is not enabled in this build."
        );
    }

    #[tokio::test]
    async fn native_completion_uses_a_content_reference_and_preserves_binary_metadata() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..count]).to_ascii_lowercase();
            assert!(request.contains("authorization: bearer test-token"));
            assert!(request.contains("cookie: sid=session"));
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nSet-Cookie: first=1; Path=/\r\nSet-Cookie: second=2; HttpOnly\r\nContent-Length: 4\r\nConnection: close\r\n\r\n\0\x01\xff\x80").unwrap();
        });
        let directory = TempDir::new().unwrap();
        let content = content_handle(&directory);
        let (_, cancellation) = watch::channel(false);
        let events = Arc::new(Mutex::new(Vec::new()));
        let emitted = events.clone();
        let result = perform_http(
            HttpRequest {
                url: format!("http://{address}/echo"),
                method: "POST".into(),
                headers: vec![
                    ("Authorization".into(), "Bearer test-token".into()),
                    ("Cookie".into(), "sid=session".into()),
                ],
                body_base64: Some(STANDARD.encode([0, 1, 255, 128])),
                body_source: None,
                response_storage: ResponseStoragePolicy::default(),
            },
            &HttpClient::default().0,
            &content,
            cancellation,
            move |event| emitted.lock().unwrap().push(event),
        )
        .await
        .unwrap();
        assert_eq!(result.status, 200);
        assert_eq!(result.content.byte_length, 4);
        assert_eq!(result.content.line_count, Some(1));
        assert_eq!(result.content.max_line_bytes, Some(4));
        assert!(result.pipeline_timings.native_total_ms >= result.pipeline_timings.network_ms);
        assert!(result.content.complete);
        assert_eq!(
            result.content.media_type.as_deref(),
            Some("application/octet-stream")
        );
        assert_eq!(
            result
                .headers
                .iter()
                .filter(|(name, _)| name == "set-cookie")
                .count(),
            2
        );
        let serialized = serde_json::to_value(&result).unwrap();
        assert!(serialized.get("bodyBase64").is_none());
        let window = content
            .read_range(
                result.content.id.clone(),
                crate::content::contracts::ByteRange {
                    offset: 0,
                    length: 4,
                },
                "base64".into(),
            )
            .await
            .unwrap();
        assert_eq!(STANDARD.decode(window.content).unwrap(), [0, 1, 255, 128]);
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, HttpEvent::Complete { .. })));
        assert_eq!(result.http_version, "HTTP/1.1");
        assert_eq!(result.remote_address, Some(address.to_string()));
        assert!(result
            .local_address
            .as_deref()
            .is_some_and(|value| value.starts_with("127.0.0.1:")));
        assert!(result.headers_duration_ms <= result.duration_ms);
        assert!(result.download_duration_ms <= result.duration_ms);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn cancellation_before_headers_aborts_the_request() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
        let server = thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            accepted_tx.send(()).unwrap();
            thread::sleep(Duration::from_millis(250));
        });
        let directory = TempDir::new().unwrap();
        let content = content_handle(&directory);
        let (cancel, cancellation) = watch::channel(false);
        let task = tokio::spawn({
            let content = content.clone();
            async move {
                perform_http(
                    request(format!("http://{address}/slow")),
                    &HttpClient::default().0,
                    &content,
                    cancellation,
                    |_| {},
                )
                .await
            }
        });
        tokio::time::timeout(Duration::from_secs(2), accepted_rx)
            .await
            .unwrap()
            .unwrap();
        cancel.send(true).unwrap();
        assert_eq!(task.await.unwrap().unwrap_err(), "Request cancelled.");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn cancellation_during_download_releases_partial_content() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (first_tx, first_rx) = tokio::sync::oneshot::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            stream.write_all(&vec![b'x'; 64 * 1024]).unwrap();
            first_tx.send(()).unwrap();
            thread::sleep(Duration::from_millis(250));
            let _ = stream.write_all(&vec![b'y'; 64 * 1024]);
        });
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("state.sqlite3");
        let content = content_handle(&directory);
        let (cancel, cancellation) = watch::channel(false);
        let task = tokio::spawn({
            let content = content.clone();
            async move {
                perform_http(
                    request(format!("http://{address}/stream")),
                    &HttpClient::default().0,
                    &content,
                    cancellation,
                    |_| {},
                )
                .await
            }
        });
        tokio::time::timeout(Duration::from_secs(2), first_rx)
            .await
            .unwrap()
            .unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        cancel.send(true).unwrap();
        assert_eq!(task.await.unwrap().unwrap_err(), "Request cancelled.");
        let database = rusqlite::Connection::open(path).unwrap();
        let rows: u64 = database
            .query_row("SELECT COUNT(*) FROM response_contents", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(rows, 0);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn completed_content_remains_valid_when_cancel_arrives_at_completion() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });
        let directory = TempDir::new().unwrap();
        let content = content_handle(&directory);
        let (cancel, cancellation) = watch::channel(false);
        let cancel_at_completion = cancel.clone();
        let result = perform_http(
            request(format!("http://{address}/complete")),
            &HttpClient::default().0,
            &content,
            cancellation,
            move |event| {
                if matches!(event, HttpEvent::Complete { .. }) {
                    let _ = cancel_at_completion.send(true);
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(result.status, 204);
        assert_eq!(result.content.byte_length, 0);
        assert_eq!(content.inspect(result.content.id).await.unwrap().size, 0);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn response_capture_rejects_one_byte_over_limit_without_leaking_content() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).unwrap();
            let size = MAX_RESPONSE_BYTES as usize + 1;
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n").as_bytes()).unwrap();
            let chunk = [b'x'; 64 * 1024];
            let mut remaining = size;
            while remaining > 0 {
                let length = remaining.min(chunk.len());
                if stream.write_all(&chunk[..length]).is_err() {
                    break;
                }
                remaining -= length;
            }
        });
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("state.sqlite3");
        let content = content_handle(&directory);
        let (_, cancellation) = watch::channel(false);
        let error = perform_http(
            request(format!("http://{address}/oversized")),
            &HttpClient::default().0,
            &content,
            cancellation,
            |_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(error, "Response exceeds the 128 MiB capture limit.");
        let database = rusqlite::Connection::open(path).unwrap();
        let rows: u64 = database
            .query_row("SELECT COUNT(*) FROM response_contents", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(rows, 0);
        server.join().unwrap();
    }

    #[test]
    fn transport_rejects_non_http_and_url_credentials() {
        for value in [
            "file:///etc/passwd",
            "ftp://example.com",
            "https://user:password@example.com",
        ] {
            assert!(http_url(value).is_err(), "{value}");
        }
    }
}
