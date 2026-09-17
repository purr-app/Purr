use super::{actor::ResponseContentState, contracts::ByteRange};
use std::borrow::Cow;
use tauri::{http, Manager};

const PROTOCOL_CHUNK_BYTES: u64 = 4 * 1024 * 1024;

fn allowed_media_type(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    value.starts_with("image/") || value.starts_with("audio/") || value.starts_with("video/")
}

fn parse_range(value: Option<&str>, size: u64) -> Result<Option<(u64, u64)>, String> {
    let Some(value) = value else { return Ok(None) };
    let value = value.strip_prefix("bytes=").ok_or("Invalid media range")?;
    if value.contains(',') || size == 0 {
        return Err("Invalid media range".into());
    }
    let (start, end) = value.split_once('-').ok_or("Invalid media range")?;
    let (start, end) = if start.is_empty() {
        let suffix = end.parse::<u64>().map_err(|_| "Invalid media range")?;
        if suffix == 0 {
            return Err("Invalid media range".into());
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = start.parse::<u64>().map_err(|_| "Invalid media range")?;
        let end = if end.is_empty() {
            size - 1
        } else {
            end.parse::<u64>()
                .map_err(|_| "Invalid media range")?
                .min(size - 1)
        };
        (start, end)
    };
    if start >= size || end < start {
        return Err("Invalid media range".into());
    }
    Ok(Some((start, end)))
}

fn response(
    status: http::StatusCode,
    media_type: &str,
    size: u64,
    range: Option<(u64, u64)>,
    body: Vec<u8>,
) -> http::Response<Cow<'static, [u8]>> {
    let content_length = range.map(|(start, end)| end - start + 1).unwrap_or(size);
    let mut builder = http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, media_type)
        .header(http::header::ACCEPT_RANGES, "bytes")
        .header(http::header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .header(http::header::CONTENT_LENGTH, content_length.to_string());
    if let Some((start, end)) = range {
        builder = builder.header(
            http::header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{size}"),
        );
    }
    builder
        .body(Cow::Owned(body))
        .expect("valid media response")
}

fn error_response(
    status: http::StatusCode,
    size: Option<u64>,
) -> http::Response<Cow<'static, [u8]>> {
    let mut builder = http::Response::builder()
        .status(status)
        .header(http::header::CACHE_CONTROL, "no-store")
        .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8");
    if let Some(size) = size {
        builder = builder.header(http::header::CONTENT_RANGE, format!("bytes */{size}"));
    }
    builder
        .body(Cow::Borrowed(&b"Response media is unavailable."[..]))
        .expect("valid media error")
}

pub fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_asynchronous_uri_scheme_protocol(
        "purr-content",
        |context, request, responder| {
            let app = context.app_handle().clone();
            let id = request.uri().path().trim_start_matches('/').to_string();
            let method = request.method().clone();
            let range = request
                .headers()
                .get(http::header::RANGE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            tauri::async_runtime::spawn(async move {
                let state = app.state::<ResponseContentState>();
                let Ok(handle) = state.handle(&app) else {
                    responder.respond(error_response(
                        http::StatusCode::INTERNAL_SERVER_ERROR,
                        None,
                    ));
                    return;
                };
                let Ok(info) = handle.inspect(id.clone()).await else {
                    responder.respond(error_response(http::StatusCode::NOT_FOUND, None));
                    return;
                };
                let Some(media_type) = info.media_type.filter(|value| allowed_media_type(value))
                else {
                    responder.respond(error_response(
                        http::StatusCode::UNSUPPORTED_MEDIA_TYPE,
                        Some(info.size),
                    ));
                    return;
                };
                if !matches!(method, http::Method::GET | http::Method::HEAD) {
                    responder.respond(error_response(
                        http::StatusCode::METHOD_NOT_ALLOWED,
                        Some(info.size),
                    ));
                    return;
                }
                let parsed = match parse_range(range.as_deref(), info.size) {
                    Ok(parsed) => parsed,
                    Err(_) => {
                        responder.respond(error_response(
                            http::StatusCode::RANGE_NOT_SATISFIABLE,
                            Some(info.size),
                        ));
                        return;
                    }
                };
                let (start, end) = parsed.unwrap_or((0, info.size.saturating_sub(1)));
                let mut body = Vec::new();
                if method == http::Method::GET && info.size > 0 {
                    let mut offset = start;
                    while offset <= end {
                        let length = (end - offset + 1).min(PROTOCOL_CHUNK_BYTES);
                        match handle
                            .read_bytes_range(id.clone(), ByteRange { offset, length })
                            .await
                        {
                            Ok(bytes) if !bytes.is_empty() => {
                                offset += bytes.len() as u64;
                                body.extend_from_slice(&bytes);
                            }
                            _ => {
                                responder.respond(error_response(
                                    http::StatusCode::INTERNAL_SERVER_ERROR,
                                    Some(info.size),
                                ));
                                return;
                            }
                        }
                    }
                }
                responder.respond(response(
                    if parsed.is_some() {
                        http::StatusCode::PARTIAL_CONTENT
                    } else {
                        http::StatusCode::OK
                    },
                    &media_type,
                    info.size,
                    parsed,
                    body,
                ));
            });
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_open_closed_and_suffix_ranges() {
        assert_eq!(
            parse_range(Some("bytes=10-19"), 100).unwrap(),
            Some((10, 19))
        );
        assert_eq!(parse_range(Some("bytes=90-"), 100).unwrap(), Some((90, 99)));
        assert_eq!(parse_range(Some("bytes=-8"), 100).unwrap(), Some((92, 99)));
        assert!(parse_range(Some("bytes=100-"), 100).is_err());
        assert!(parse_range(Some("bytes=1-2,4-5"), 100).is_err());
    }

    #[test]
    fn protocol_allows_only_media_types() {
        assert!(allowed_media_type("image/png"));
        assert!(allowed_media_type("audio/mpeg"));
        assert!(allowed_media_type("video/mp4"));
        assert!(!allowed_media_type("text/html"));
        assert!(!allowed_media_type("application/pdf"));
    }
}
