use super::{
    correlation::{CorrelationExtractor, ExchangeInput, StandardCorrelation},
    credentials::ScopedCredentials,
    domain::*,
    fixtures::SyntheticProvider,
    registry::RegistryBuilder,
    service::*,
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use zeroize::Zeroizing;

const TRACE: &str = "0123456789abcdef0123456789abcdef";
struct MemoryRepository {
    request_headers: Vec<(String, String)>,
    config: Mutex<Vec<Integration>>,
    token: Mutex<String>,
    headers: Vec<(String, String)>,
}
impl Repository for MemoryRepository {
    fn integrations(&self, _: &str) -> NativeFuture<'_, Vec<Integration>> {
        Box::pin(async { Ok(self.config.lock().unwrap().clone()) })
    }
    fn secret(&self, _: &str) -> NativeFuture<'_, Option<Zeroizing<String>>> {
        Box::pin(async { Ok(Some(Zeroizing::new(self.token.lock().unwrap().clone()))) })
    }
    fn exchange(&self, _: &TraceQuery, _: bool) -> NativeFuture<'_, ExchangeInput> {
        Box::pin(async {
            Ok(ExchangeInput {
                request_headers: self.request_headers.clone(),
                response_headers: self.headers.clone(),
                ..Default::default()
            })
        })
    }
}
fn setup() -> (ObservabilityService, MemoryRepository, TraceQuery) {
    let registry = RegistryBuilder::default()
        .provider(SyntheticProvider {
            id: "test.alpha",
            service: "alpha",
        })
        .unwrap()
        .provider(SyntheticProvider {
            id: "test.beta",
            service: "beta",
        })
        .unwrap()
        .extractor(StandardCorrelation)
        .unwrap()
        .build();
    let items = ["alpha", "beta"].map(|id| Integration {
        id: id.into(),
        name: id.into(),
        provider: format!("test.{id}"),
        enabled: true,
        config_version: 1,
        config: json!({"delayMs":0}),
        credentials: BTreeMap::from([(
            "apiToken".into(),
            Credential {
                kind: "secret".into(),
                reference: Some(format!("purr/workspace/integrations/{id}/apiToken")),
            },
        )]),
    });
    (
        ObservabilityService::new(registry),
        MemoryRepository {
            request_headers: vec![],
            config: Mutex::new(items.to_vec()),
            token: Mutex::new("synthetic-only".into()),
            headers: vec![(
                "traceparent".into(),
                format!("00-{TRACE}-0123456789abcdef-01"),
            )],
        },
        TraceQuery {
            connection: None,
            workspace_id: "workspace".into(),
            integration_id: "alpha".into(),
            document_id: "document".into(),
            started_at_ms: 1,
            manual_trace_id: None,
            search: String::new(),
            cursor: None,
        },
    )
}
fn cancel() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

#[cfg(feature = "jaeger")]
#[tokio::test]
async fn jaeger_http_is_cancellable_through_the_shared_service() {
    use super::providers::jaeger::{JaegerDescriptor, JaegerProvider};
    use tokio::{io::AsyncReadExt, net::TcpListener, sync::oneshot};
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (sent, received) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 1];
        let mut headers = Vec::new();
        while !headers.ends_with(b"\r\n\r\n") {
            socket.read_exact(&mut request).await.unwrap();
            headers.push(request[0]);
            assert!(headers.len() <= 8192);
        }
        sent.send(()).unwrap();
        std::future::pending::<()>().await;
    });
    let (_, repository, query) = setup();
    {
        let mut config = repository.config.lock().unwrap();
        config[0].provider = "jaeger".into();
        config[0].config = json!({"endpoint": format!("http://{address}"), "auth":"bearer"});
    }
    let service = ObservabilityService::new(
        RegistryBuilder::default()
            .descriptor(JaegerDescriptor)
            .unwrap()
            .trace_provider(JaegerProvider::default())
            .unwrap()
            .extractor(StandardCorrelation)
            .unwrap()
            .build(),
    );
    let cancelled = cancel();
    let trigger = cancelled.clone();
    let (result, _) = tokio::join!(service.lookup(&repository, query, cancelled), async move {
        received.await.unwrap();
        trigger.store(true, Ordering::Relaxed);
    });
    assert_eq!(result, Err(ObservabilityError::Cancelled));
    server.abort();
}

#[tokio::test]
async fn injected_lookup_and_resolved_ids_are_distinct_and_provider_neutral() {
    use super::registry::{IntegrationDescriptor, ProviderContext, ProviderFuture, TraceProvider};
    struct Alias;
    impl IntegrationDescriptor for Alias {
        fn id(&self) -> &'static str {
            "test.alpha"
        }
        fn credential_keys(&self, _: &serde_json::Value) -> Vec<&'static str> {
            vec![]
        }
        fn validate_and_migrate(
            &self,
            _: u32,
            config: &serde_json::Value,
        ) -> Result<serde_json::Value> {
            Ok(config.clone())
        }
    }
    impl TraceProvider for Alias {
        fn provider_id(&self) -> &'static str {
            "test.alpha"
        }
        fn get_trace<'a>(&'a self, _: ProviderContext<'a>, _: &'a str) -> ProviderFuture<'a> {
            Box::pin(async {
                Ok(Some(Trace {
                    id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
                    spans: vec![],
                }))
            })
        }
    }
    let (_, mut repository, query) = setup();
    repository.request_headers = vec![(
        "traceparent".into(),
        "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0123456789abcdef-01".into(),
    )];
    let service = ObservabilityService::new(
        RegistryBuilder::default()
            .provider(Alias)
            .unwrap()
            .extractor(StandardCorrelation)
            .unwrap()
            .build(),
    );
    let result = service.lookup(&repository, query, cancel()).await.unwrap();
    assert_eq!(
        result.correlation.injected_trace_id.as_deref(),
        Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    );
    assert_eq!(
        result.correlation.lookup_reference.as_ref().unwrap().id,
        TRACE
    );
    assert_eq!(
        result.correlation.lookup_reference.as_ref().unwrap().source,
        "response"
    );
    assert_eq!(
        result.correlation.resolved_trace_id.as_deref(),
        Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    );
}

#[tokio::test]
async fn native_service_dispatches_two_providers_pages_searches_and_invalidates_cache() {
    let (service, repository, query) = setup();
    let first = service
        .lookup(&repository, query.clone(), cancel())
        .await
        .unwrap();
    assert_eq!(first.trace_id.as_deref(), Some(TRACE));
    assert_eq!(first.spans.len(), 25);
    assert!(!first.cached);
    assert_eq!(first.spans[0].service, "alpha");
    assert!(
        service
            .lookup(&repository, query.clone(), cancel())
            .await
            .unwrap()
            .cached
    );
    let mut next = query.clone();
    next.cursor = first.next_cursor.clone();
    assert_eq!(
        service
            .lookup(&repository, next.clone(), cancel())
            .await
            .unwrap()
            .spans[0]
            .operation,
        "synthetic-operation-25"
    );
    next.cursor = None;
    next.integration_id = "beta".into();
    assert_eq!(
        service
            .lookup(&repository, next.clone(), cancel())
            .await
            .unwrap()
            .spans[0]
            .service,
        "beta"
    );
    next.search = "operation-59".into();
    assert_eq!(
        service
            .lookup(&repository, next, cancel())
            .await
            .unwrap()
            .total,
        2 // matched child plus its ancestor
    );
    *repository.token.lock().unwrap() = "rotated-synthetic".into();
    assert!(
        !service
            .lookup(&repository, query.clone(), cancel())
            .await
            .unwrap()
            .cached
    );
    let mut stale = query.clone();
    stale.cursor = first.next_cursor;
    assert_eq!(
        service.lookup(&repository, stale, cancel()).await,
        Err(ObservabilityError::InvalidCursor)
    );
    repository.config.lock().unwrap()[0].config = json!({"delayMs":1});
    assert!(
        !service
            .lookup(&repository, query, cancel())
            .await
            .unwrap()
            .cached
    );
}

#[tokio::test]
async fn unavailable_disabled_bad_config_credentials_and_no_correlation_are_typed() {
    let (service, mut repository, query) = setup();
    repository.headers.clear();
    assert_eq!(
        service
            .lookup(&repository, query.clone(), cancel())
            .await
            .unwrap()
            .trace_id,
        None
    );
    repository.config.lock().unwrap()[0]
        .credentials
        .get_mut("apiToken")
        .unwrap()
        .reference = Some("purr/another/integrations/alpha/apiToken".into());
    assert_eq!(
        service.lookup(&repository, query.clone(), cancel()).await,
        Err(ObservabilityError::CredentialUnavailable)
    );
    repository.config.lock().unwrap()[0].config_version = 2;
    assert_eq!(
        service.lookup(&repository, query.clone(), cancel()).await,
        Err(ObservabilityError::InvalidConfig)
    );
    repository.config.lock().unwrap()[0].enabled = false;
    assert_eq!(
        service.lookup(&repository, query.clone(), cancel()).await,
        Err(ObservabilityError::Disabled)
    );
    repository.config.lock().unwrap()[0].enabled = true;
    repository.config.lock().unwrap()[0].provider = "unavailable".into();
    assert!(!service.list(&repository, "workspace").await.unwrap()[0].available);
    assert_eq!(
        service.lookup(&repository, query, cancel()).await,
        Err(ObservabilityError::Unavailable)
    );
}

#[tokio::test]
async fn cancellation_drops_delayed_provider_future_and_never_returns_stale_data() {
    let (service, repository, query) = setup();
    repository.config.lock().unwrap()[0].config = json!({"delayMs":5000});
    let cancellation = cancel();
    let trigger = cancellation.clone();
    let future = service.lookup(&repository, query, cancellation);
    let cancel_future = async move {
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        trigger.store(true, Ordering::Relaxed);
    };
    let (result, _) = tokio::join!(future, cancel_future);
    assert_eq!(result, Err(ObservabilityError::Cancelled));
}

#[test]
fn registries_reject_duplicate_providers_and_extractors_and_credentials_are_scoped() {
    assert!(RegistryBuilder::default()
        .provider(SyntheticProvider {
            id: "same",
            service: "a"
        })
        .unwrap()
        .provider(SyntheticProvider {
            id: "same",
            service: "b"
        })
        .is_err());
    assert!(RegistryBuilder::default()
        .extractor(StandardCorrelation)
        .unwrap()
        .extractor(StandardCorrelation)
        .is_err());
    assert!(ScopedCredentials::validate_ref(
        "ws",
        "integration",
        "token",
        "purr/ws/integrations/integration/token"
    )
    .is_ok());
    assert!(ScopedCredentials::validate_ref(
        "ws",
        "integration",
        "token",
        "purr/ws/integrations/other/token"
    )
    .is_err());
}

#[test]
fn correlation_handles_standard_headers_and_rejects_invalid_ids() {
    for header in ["x-b3-traceid", "b3"] {
        let input = ExchangeInput {
            response_headers: vec![(header.into(), TRACE.into())],
            ..Default::default()
        };
        assert_eq!(StandardCorrelation.extract(&input).unwrap(), vec![TRACE]);
    }
    let invalid = ExchangeInput {
        response_headers: vec![(
            "traceparent".into(),
            format!("00-{TRACE}-0000000000000000-01"),
        )],
        ..Default::default()
    };
    assert!(StandardCorrelation.extract(&invalid).unwrap().is_empty());
}

#[test]
fn native_dto_matches_shared_fixture_and_never_serializes_provider_fields() {
    let fixture = include_str!("../../../tests/fixtures/observability/trace-page.json");
    let page: TracePage = serde_json::from_str(fixture).unwrap();
    assert_eq!(
        serde_json::to_value(&page).unwrap(),
        serde_json::from_str::<serde_json::Value>(fixture).unwrap()
    );
    assert_eq!(page.protocol_version, 2);
}

#[test]
fn fake_body_extractor_composes_without_provider_branches_and_execution_rejects_secret_payloads() {
    struct BodyExtractor;
    impl CorrelationExtractor for BodyExtractor {
        fn id(&self) -> &'static str {
            "test.body"
        }
        fn needs_body_prefix(&self) -> bool {
            true
        }
        fn extract(&self, input: &ExchangeInput) -> Result<Vec<String>> {
            Ok(if input.body_prefix == b"synthetic-correlation" {
                vec![TRACE.into()]
            } else {
                vec![]
            })
        }
    }
    let registry = RegistryBuilder::default()
        .extractor(StandardCorrelation)
        .unwrap()
        .extractor(BodyExtractor)
        .unwrap()
        .build();
    assert!(registry.needs_body_prefix());
    assert_eq!(
        registry
            .extract(&ExchangeInput {
                body_prefix: b"synthetic-correlation".to_vec(),
                ..Default::default()
            })
            .unwrap(),
        vec![TRACE]
    );
    let (_, _, query) = setup();
    let mut payload = serde_json::to_value(query).unwrap();
    payload["credentials"] = json!({"token":"must-not-cross-ipc"});
    assert!(serde_json::from_value::<TraceQuery>(payload).is_err());
}

#[tokio::test]
async fn normalized_provider_results_are_bounded_before_caching_or_ipc() {
    use super::registry::{ProviderContext, ProviderFuture, TraceProvider};
    struct Oversized;
    impl super::registry::IntegrationDescriptor for Oversized {
        fn id(&self) -> &'static str {
            "test.alpha"
        }
        fn credential_keys(&self, _: &serde_json::Value) -> Vec<&'static str> {
            vec![]
        }
        fn validate_and_migrate(&self, _: u32, _: &serde_json::Value) -> Result<serde_json::Value> {
            Ok(json!({}))
        }
    }
    impl TraceProvider for Oversized {
        fn provider_id(&self) -> &'static str {
            "test.alpha"
        }
        fn get_trace<'a>(
            &'a self,
            _: ProviderContext<'a>,
            trace_id: &'a str,
        ) -> ProviderFuture<'a> {
            Box::pin(async move {
                Ok(Some(Trace {
                    id: trace_id.into(),
                    spans: vec![Span {
                        id: "1".into(),
                        parent_span_id: None,
                        service: "x".repeat(257),
                        operation: "fixture".into(),
                        started_at_us: 1,
                        duration_us: 1,
                        status: SpanStatus::Ok,
                        attributes: BTreeMap::new(),
                    }],
                }))
            })
        }
    }
    let (_, repository, query) = setup();
    let service = ObservabilityService::new(
        RegistryBuilder::default()
            .provider(Oversized)
            .unwrap()
            .extractor(StandardCorrelation)
            .unwrap()
            .build(),
    );
    assert_eq!(
        service.lookup(&repository, query.clone(), cancel()).await,
        Err(ObservabilityError::LimitExceeded)
    );
    let cancelled = cancel();
    cancelled.store(true, Ordering::Relaxed);
    assert_eq!(
        service.lookup(&repository, query, cancelled).await,
        Err(ObservabilityError::Cancelled)
    );
}
