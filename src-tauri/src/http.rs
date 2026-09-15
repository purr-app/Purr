use base64::{engine::general_purpose::STANDARD, Engine};
use hyper_util::client::legacy::connect::HttpInfo;
use reqwest::{
    header::{HeaderName, HeaderValue},
    Client, Method, Url,
};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body_base64: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body_base64: String,
    duration_ms: u128,
    headers_duration_ms: u128,
    download_duration_ms: u128,
    http_version: String,
    local_address: Option<String>,
    remote_address: Option<String>,
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

#[tauri::command]
pub async fn send_http(
    request: HttpRequest,
    client: tauri::State<'_, HttpClient>,
) -> Result<HttpResponse, String> {
    perform_http(request, &client.0).await
}

async fn perform_http(request: HttpRequest, client: &Client) -> Result<HttpResponse, String> {
    let url = http_url(&request.url)?;
    let method =
        Method::from_bytes(request.method.as_bytes()).map_err(|_| "Invalid HTTP method.")?;
    let mut builder = client.request(method, url);
    for (name, value) in request.headers {
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
    let started = Instant::now();
    // Never include reqwest's URL-bearing errors: query strings can contain API keys.
    let mut response = builder.send().await.map_err(|err| {
        if err.is_timeout() {
            "Request timed out."
        } else if err.is_connect() {
            "Connection failed. Check the host, network and TLS certificate."
        } else {
            "Could not send the HTTP request."
        }
    })?;
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
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.to_string(),
                String::from_utf8_lossy(value.as_bytes()).into_owned(),
            )
        })
        .collect();
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read the response body.")?
    {
        if body.len() + chunk.len() > 20 * 1024 * 1024 {
            return Err("Response exceeds the 20 MB preview limit.".into());
        }
        body.extend_from_slice(&chunk);
    }
    let duration = started.elapsed();
    Ok(HttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").into(),
        headers,
        body_base64: STANDARD.encode(body),
        duration_ms: duration.as_millis(),
        headers_duration_ms: headers_duration.as_millis(),
        download_duration_ms: duration.saturating_sub(headers_duration).as_millis(),
        http_version,
        local_address,
        remote_address,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };

    #[tokio::test]
    async fn native_transport_preserves_headers_and_binary_payload() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 1024];
            loop {
                let count = stream.read(&mut buffer).unwrap();
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(index) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                    if bytes.len() >= index + 4 + 4 {
                        assert_eq!(&bytes[index + 4..], &[0, 1, 255, 128]);
                        break;
                    }
                }
            }
            let headers = String::from_utf8_lossy(&bytes).to_lowercase();
            assert!(headers.contains("authorization: bearer test-token"));
            assert!(headers.contains("cookie: sid=session"));
            stream.write_all(b"HTTP/1.1 200 OK\r\nSet-Cookie: first=1; Path=/\r\nSet-Cookie: second=2; HttpOnly\r\nContent-Length: 4\r\nConnection: close\r\n\r\n\0\x01\xff\x80").unwrap();
        });
        let request = HttpRequest {
            url: format!("http://{address}/echo"),
            method: "POST".into(),
            headers: vec![
                ("Authorization".into(), "Bearer test-token".into()),
                ("Cookie".into(), "sid=session".into()),
            ],
            body_base64: Some(STANDARD.encode([0, 1, 255, 128])),
        };
        let result = perform_http(request, &HttpClient::default().0)
            .await
            .unwrap();
        assert_eq!(result.status, 200);
        assert_eq!(
            result
                .headers
                .iter()
                .filter(|(name, _)| name == "set-cookie")
                .count(),
            2
        );
        assert_eq!(
            STANDARD.decode(result.body_base64).unwrap(),
            [0, 1, 255, 128]
        );
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
    async fn response_preview_rejects_one_byte_over_twenty_mebibytes() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).unwrap();
            let size = 20 * 1024 * 1024 + 1;
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .unwrap();
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
        let request = HttpRequest {
            url: format!("http://{address}/oversized"),
            method: "GET".into(),
            headers: vec![],
            body_base64: None,
        };
        let error = perform_http(request, &HttpClient::default().0)
            .await
            .err()
            .expect("oversized response must fail");
        assert_eq!(error, "Response exceeds the 20 MB preview limit.");
        server.join().unwrap();
    }

    #[test]
    fn transport_rejects_non_http_and_url_credentials() {
        for value in [
            "file:///etc/passwd",
            "ftp://example.com",
            "https://user:password@example.com",
        ] {
            assert!(http_url(value).is_err());
        }
        assert!(http_url("http://127.0.0.1:8000").is_ok());
    }
}
