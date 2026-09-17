// Jaeger Query API v3 / OTLP JSON. All vendor payloads stay in this adapter.
use crate::observability::{
    domain::*,
    registry::{IntegrationDescriptor, ProviderContext, ProviderFuture, TraceProvider},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    endpoint: String,
    #[serde(default)]
    auth: Auth,
}
#[derive(Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Auth {
    #[default]
    None,
    Bearer,
    Request,
}

pub struct JaegerDescriptor;
impl IntegrationDescriptor for JaegerDescriptor {
    fn id(&self) -> &'static str {
        "jaeger"
    }
    fn credential_keys(&self, config: &Value) -> Vec<&'static str> {
        if config["auth"] == "request" {
            vec!["auth"]
        } else if config["auth"] == "bearer" {
            vec!["apiToken"]
        } else {
            vec![]
        }
    }
    fn validate_and_migrate(&self, version: u32, value: &Value) -> Result<Value> {
        if version != 1 {
            return Err(ObservabilityError::InvalidConfig);
        }
        let config: Config =
            serde_json::from_value(value.clone()).map_err(|_| ObservabilityError::InvalidConfig)?;
        let template = regex::Regex::new(r"\{\{[^{}]+\}\}").expect("endpoint variable pattern");
        let candidate = template.replace_all(&config.endpoint, "purr-variable");
        let candidate = if candidate.contains("://") { candidate.to_string() } else if template.is_match(&config.endpoint) { format!("http://{candidate}") } else { candidate.to_string() };
        let url = Url::parse(&candidate).map_err(|_| ObservabilityError::InvalidConfig)?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || config.endpoint.len() > 2048
        {
            return Err(ObservabilityError::InvalidConfig);
        }
        Ok(
            json!({"endpoint": if template.is_match(&config.endpoint) { config.endpoint.trim_end_matches('/') } else { url.as_str().trim_end_matches('/') }, "auth": match config.auth { Auth::Bearer => "bearer", Auth::Request => "request", Auth::None => "none" }}),
        )
    }
}

pub struct JaegerProvider {
    client: Client,
}
impl Default for JaegerProvider {
    fn default() -> Self {
        Self {
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(12))
                .build()
                .expect("native Jaeger client"),
        }
    }
}
impl TraceProvider for JaegerProvider {
    fn provider_id(&self) -> &'static str {
        "jaeger"
    }
    fn get_trace<'a>(
        &'a self,
        context: ProviderContext<'a>,
        trace_id: &'a str,
    ) -> ProviderFuture<'a> {
        Box::pin(async move {
            if !valid_trace_id(trace_id) {
                return Err(ObservabilityError::InvalidQuery);
            }
            let endpoint = context.config["endpoint"]
                .as_str()
                .ok_or(ObservabilityError::InvalidConfig)?;
            let mut url = Url::parse(context.connection.map(|value| value.endpoint.as_str()).unwrap_or(endpoint))
                .map_err(|_| ObservabilityError::InvalidConfig)?;
            url.set_path(&format!("{}/api/v3/traces/{trace_id}", url.path().trim_end_matches('/')));
            let mut request = self.client.get(url);
            if let Some(connection) = context.connection {
                for (name, value) in &connection.headers { request = request.header(name, value); }
            } else if context.config["auth"] == "request" {
                return Err(ObservabilityError::CredentialUnavailable);
            } else if context.config["auth"] == "bearer" {
                let token = context.credentials.get("apiToken")?;
                if token.is_empty() {
                    return Err(ObservabilityError::CredentialUnavailable);
                }
                request = request.bearer_auth(token);
            }
            let mut response = request
                .send()
                .await
                .map_err(|_| ObservabilityError::ProviderFailed)?;
            if response.status().as_u16() == 404 {
                return Ok(None);
            }
            if !response.status().is_success() {
                return Err(ObservabilityError::ProviderFailed);
            }
            const MAX_BYTES: usize = 4 * 1024 * 1024;
            if response
                .content_length()
                .is_some_and(|size| size > MAX_BYTES as u64)
            {
                return Err(ObservabilityError::LimitExceeded);
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| ObservabilityError::ProviderFailed)?
            {
                if bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
                    return Err(ObservabilityError::LimitExceeded);
                }
                bytes.extend_from_slice(&chunk);
            }
            // Bounded parse does not occupy the async executor while walking OTLP.
            tokio::task::spawn_blocking(move || decode(&bytes))
                .await
                .map_err(|_| ObservabilityError::ProviderFailed)?
        })
    }
}

fn id(value: &Value, length: usize) -> Result<String> {
    let text = value.as_str().ok_or(ObservabilityError::ProviderFailed)?;
    if text.len() == length * 2
        && text.bytes().all(|b| b.is_ascii_hexdigit())
        && text.bytes().any(|b| b != b'0')
    {
        return Ok(text.to_ascii_lowercase());
    }
    let bytes = STANDARD
        .decode(text)
        .map_err(|_| ObservabilityError::ProviderFailed)?;
    if bytes.len() != length || bytes.iter().all(|b| *b == 0) {
        return Err(ObservabilityError::ProviderFailed);
    }
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn number(value: &Value) -> Result<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|v| v.parse().ok()))
        .ok_or(ObservabilityError::ProviderFailed)
}
fn scalar(value: &Value) -> Option<AttributeScalar> {
    if let Some(v) = value["stringValue"].as_str() {
        Some(AttributeScalar::String(v.into()))
    } else if let Some(v) = value["boolValue"].as_bool() {
        Some(AttributeScalar::Bool(v))
    } else if let Some(v) = value["doubleValue"].as_f64() {
        Some(AttributeScalar::Number(v))
    } else {
        value["intValue"]
            .as_i64()
            .or_else(|| value["intValue"].as_str().and_then(|v| v.parse().ok()))
            .map(|v| AttributeScalar::Number(v as f64))
    }
}
fn attributes(value: &Value) -> Result<BTreeMap<String, AttributeValue>> {
    let mut result = BTreeMap::new();
    for item in value.as_array().into_iter().flatten() {
        let key = item["key"]
            .as_str()
            .ok_or(ObservabilityError::ProviderFailed)?;
        let value = &item["value"];
        let normalized = if let Some(value) = scalar(value) {
            Some(AttributeValue::Scalar(value))
        } else if let Some(values) = value["arrayValue"]["values"].as_array() {
            if values.len() > 32 {
                return Err(ObservabilityError::LimitExceeded);
            }
            values
                .iter()
                .map(scalar)
                .collect::<Option<Vec<_>>>()
                .map(AttributeValue::Array)
        } else {
            None
        };
        if let Some(value) = normalized {
            if key.len() > 128 || !value.is_bounded() || result.len() >= 32 {
                return Err(ObservabilityError::LimitExceeded);
            }
            result.insert(key.into(), value);
        }
    }
    Ok(result)
}
pub fn decode(bytes: &[u8]) -> Result<Option<Trace>> {
    let mut trace: Option<Trace> = None;
    // gRPC gateway streaming uses consecutive result envelopes (NDJSON).
    for envelope in serde_json::Deserializer::from_slice(bytes).into_iter::<Value>() {
        let envelope = envelope.map_err(|_| ObservabilityError::ProviderFailed)?;
        if envelope.get("error").is_some() {
            return Err(ObservabilityError::ProviderFailed);
        }
        let result = envelope
            .get("result")
            .ok_or(ObservabilityError::ProviderFailed)?;
        let resources = result["resourceSpans"]
            .as_array()
            .ok_or(ObservabilityError::ProviderFailed)?;
        for resource in resources {
            let resource_attrs = attributes(&resource["resource"]["attributes"])?;
            let service = match resource_attrs.get("service.name") {
                Some(AttributeValue::Scalar(AttributeScalar::String(value))) => value.clone(),
                _ => "unknown service".into(),
            };
            for scope in resource["scopeSpans"].as_array().into_iter().flatten() {
                for span in scope["spans"].as_array().into_iter().flatten() {
                    let trace_id = id(&span["traceId"], 16)?;
                    let trace = trace.get_or_insert_with(|| Trace {
                        id: trace_id.clone(),
                        spans: vec![],
                    });
                    if trace.id != trace_id {
                        return Err(ObservabilityError::ProviderFailed);
                    }
                    if trace.spans.len() >= 1000 {
                        return Err(ObservabilityError::LimitExceeded);
                    }
                    let start = number(&span["startTimeUnixNano"])?;
                    let end = number(&span["endTimeUnixNano"])?;
                    let duration = end
                        .checked_sub(start)
                        .ok_or(ObservabilityError::ProviderFailed)?;
                    let mut attrs = resource_attrs.clone();
                    attrs.extend(attributes(&span["attributes"])?);
                    let parent = span["parentSpanId"].as_str().filter(|s| {
                        !s.is_empty() && *s != "AAAAAAAAAAA=" && s.bytes().any(|b| b != b'0')
                    });
                    trace.spans.push(Span {
                        id: id(&span["spanId"], 8)?,
                        parent_span_id: parent.map(|_| id(&span["parentSpanId"], 8)).transpose()?,
                        service: service.clone(),
                        operation: span["name"]
                            .as_str()
                            .ok_or(ObservabilityError::ProviderFailed)?
                            .into(),
                        started_at_us: start / 1000,
                        duration_us: duration / 1000,
                        attributes: attrs,
                        status: match &span["status"]["code"] {
                            code if code == 1 || code == "STATUS_CODE_OK" => SpanStatus::Ok,
                            code if code == 2 || code == "STATUS_CODE_ERROR" => SpanStatus::Error,
                            _ => SpanStatus::Unset,
                        },
                    });
                }
            }
        }
    }
    Ok(trace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observability::{
        credentials::ScopedCredentials, hierarchy, registry::RegistryBuilder,
        service::ObservabilityService,
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    const FIXTURE: &[u8] =
        include_bytes!("../../../../tests/fixtures/observability/jaeger-v3.json");
    #[test]
    fn reads_gateway_streams_hex_and_base64_ids_and_bounds_span_counts() {
        let mut fixture: Value = serde_json::from_slice(FIXTURE).unwrap();
        let spans = &mut fixture["result"]["resourceSpans"][0]["scopeSpans"][0]["spans"];
        for span in spans.as_array_mut().unwrap() {
            let trace = id(&span["traceId"], 16).unwrap();
            let bytes: Vec<u8> = (0..trace.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&trace[i..i + 2], 16).unwrap())
                .collect();
            span["traceId"] = json!(STANDARD.encode(bytes));
            if span["parentSpanId"].is_null() {
                span["parentSpanId"] = json!("AAAAAAAAAAA=");
            }
        }
        let bytes = serde_json::to_vec(&fixture).unwrap();
        assert_eq!(decode(&bytes).unwrap(), decode(FIXTURE).unwrap());
        let mut stream = bytes.clone();
        stream.extend_from_slice(b"\n{\"result\":{\"resourceSpans\":[]}}\n");
        assert_eq!(decode(&stream).unwrap(), decode(FIXTURE).unwrap());
        let span = fixture["result"]["resourceSpans"][0]["scopeSpans"][0]["spans"][0].clone();
        fixture["result"]["resourceSpans"][0]["scopeSpans"][0]["spans"] = json!(vec![span; 1001]);
        assert_eq!(
            decode(&serde_json::to_vec(&fixture).unwrap()),
            Err(ObservabilityError::LimitExceeded)
        );
    }
    #[tokio::test]
    async fn enforces_wire_budget_with_and_without_content_length() {
        for declared in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 1];
                let mut headers = Vec::new();
                while !headers.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut request).await.unwrap();
                    headers.push(request[0]);
                    assert!(headers.len() <= 8192);
                }
                if declared {
                    socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4194305\r\n\r\n")
                        .await
                        .unwrap();
                } else {
                    socket
                        .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n")
                        .await
                        .unwrap();
                    let _ = socket.write_all(&vec![b' '; 4 * 1024 * 1024 + 1]).await;
                }
            });
            let config = json!({"endpoint": format!("http://{address}"), "auth":"none"});
            let credentials = ScopedCredentials::new(BTreeMap::new());
            let result = JaegerProvider::default()
                .get_trace(
                    ProviderContext {
                        connection: None,
                        config: &config,
                        credentials: &credentials,
                    },
                    "0123456789abcdef0123456789abcdef",
                )
                .await;
            assert_eq!(result, Err(ObservabilityError::LimitExceeded));
            server.await.unwrap();
        }
    }
    #[test]
    fn maps_otlp_and_builds_hierarchy_without_losing_parents_during_attribute_search() {
        let trace = decode(FIXTURE).unwrap().unwrap();
        assert_eq!(trace.spans.len(), 2);
        assert_eq!(trace.spans[0].duration_us, 750);
        assert_eq!(trace.spans[0].status, SpanStatus::Error);
        let rows = hierarchy::rows(&trace.spans, "db.system").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].span_id, "0000000000000001");
        assert!(!rows[0].matches_search);
        assert_eq!(rows[1].depth, 1);
        assert!(rows[1].matches_search);
        assert!(decode(br#"{"error":{"message":"private vendor detail"}}"#).is_err());
        assert!(decode(br#"{"result":{}}"#).is_err());
        assert!(decode(br#"{"result":{"resourceSpans":[]}}"#)
            .unwrap()
            .is_none());
        let mut cyclic = trace.spans;
        cyclic[1].parent_span_id = Some(cyclic[0].id.clone());
        assert!(hierarchy::rows(&cyclic, "").is_err());
    }
    #[test]
    fn config_migration_rejects_embedded_secrets_and_preserves_base_path() {
        let config = JaegerDescriptor
            .validate_and_migrate(1, &json!({"endpoint":"http://localhost:16686/jaeger/"}))
            .unwrap();
        assert_eq!(
            config,
            json!({"endpoint":"http://localhost:16686/jaeger", "auth":"none"})
        );
        assert!(JaegerDescriptor.credential_keys(&config).is_empty());
        for endpoint in [
            "file:///tmp/trace",
            "https://token@example.com",
            "https://example.com?token=hidden",
        ] {
            assert!(JaegerDescriptor
                .validate_and_migrate(1, &json!({"endpoint":endpoint}))
                .is_err());
        }
        assert!(JaegerDescriptor.validate_and_migrate(2, &config).is_err());
        assert!(JaegerDescriptor
            .validate_and_migrate(1, &json!({"endpoint":"http://localhost", "token":"secret"}))
            .is_err());
        let registry = RegistryBuilder::default()
            .descriptor(JaegerDescriptor)
            .unwrap()
            .trace_provider(JaegerProvider::default())
            .unwrap()
            .fake_capability("jaeger")
            .unwrap()
            .build();
        assert_eq!(
            registry.capabilities("jaeger"),
            vec!["traces", "test.capability"]
        );
        assert!(RegistryBuilder::default()
            .trace_provider(JaegerProvider::default())
            .is_err());
        assert!(RegistryBuilder::default()
            .descriptor(JaegerDescriptor)
            .unwrap()
            .descriptor(JaegerDescriptor)
            .is_err());
        assert!(RegistryBuilder::default()
            .descriptor(JaegerDescriptor)
            .unwrap()
            .trace_provider(JaegerProvider::default())
            .unwrap()
            .trace_provider(JaegerProvider::default())
            .is_err());
        let _ = ObservabilityService::new(registry);
    }
    #[tokio::test]
    async fn native_http_sends_scoped_token_and_handles_not_found_auth_and_redirect() {
        for (status, body, extra, expected) in [
            ("200 OK", FIXTURE.to_vec(), "", "ok"),
            ("404 Not Found", vec![], "", "empty"),
            ("401 Unauthorized", b"private error".to_vec(), "", "error"),
            (
                "302 Found",
                vec![],
                "Location: http://127.0.0.1:1/credential-leak\r\n",
                "error",
            ),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = vec![0; 8192];
                let count = socket.read(&mut bytes).await.unwrap();
                let request = String::from_utf8_lossy(&bytes[..count]);
                assert!(request.starts_with("GET /base/api/v3/traces/"));
                assert!(request
                    .to_lowercase()
                    .contains("authorization: bearer purr-synthetic-token"));
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
                    body.len()
                );
                socket.write_all(head.as_bytes()).await.unwrap();
                socket.write_all(&body).await.unwrap();
            });
            let provider = JaegerProvider::default();
            let config = json!({"endpoint":format!("http://{address}/base"), "auth":"bearer"});
            let credentials = ScopedCredentials::new(BTreeMap::from([(
                "apiToken".into(),
                zeroize::Zeroizing::new("purr-synthetic-token".into()),
            )]));
            let result = provider
                .get_trace(
                    ProviderContext {
                        connection: None,
                        config: &config,
                        credentials: &credentials,
                    },
                    "0123456789abcdef0123456789abcdef",
                )
                .await;
            match expected {
                "ok" => assert!(result.unwrap().is_some()),
                "empty" => assert!(result.unwrap().is_none()),
                _ => assert_eq!(result, Err(ObservabilityError::ProviderFailed)),
            }
            server.await.unwrap();
        }
    }
}
