use super::{
    cache::TraceCache,
    correlation::ExchangeInput,
    credentials::ScopedCredentials,
    domain::*,
    registry::{ProviderContext, Registry},
};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use zeroize::Zeroizing;

pub type NativeFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Integration {
    pub id: String,
    pub name: String,
    pub provider: String,
    #[serde(default = "enabled_default")]
    pub enabled: bool,
    #[serde(default = "config_version_default")]
    pub config_version: u32,
    #[serde(default = "config_default")]
    pub config: Value,
    #[serde(default)]
    pub credentials: BTreeMap<String, Credential>,
    #[serde(default)]
    pub tracing: Option<super::correlation::TracingHeaders>,
}
fn enabled_default() -> bool {
    true
}
fn config_version_default() -> u32 {
    1
}
fn config_default() -> Value {
    serde_json::json!({})
}
#[derive(Clone, Deserialize)]
pub struct Credential {
    pub kind: String,
    #[serde(rename = "ref")]
    pub reference: Option<String>,
}

pub trait Repository: Send + Sync {
    fn integrations(&self, workspace: &str) -> NativeFuture<'_, Vec<Integration>>;
    fn secret(&self, reference: &str) -> NativeFuture<'_, Option<Zeroizing<String>>>;
    fn exchange(
        &self,
        query: &TraceQuery,
        read_body_prefix: bool,
    ) -> NativeFuture<'_, ExchangeInput>;
}

pub struct ObservabilityService {
    registry: Registry,
    cache: Mutex<TraceCache>,
    slots: tokio::sync::Semaphore,
}
impl ObservabilityService {
    pub fn propagators(&self) -> &super::propagation::PropagationRegistry {
        &self.registry.propagators
    }
    pub fn new(registry: Registry) -> Self {
        Self {
            registry,
            cache: Mutex::new(TraceCache::default()),
            slots: tokio::sync::Semaphore::new(4),
        }
    }
    pub async fn list(
        &self,
        repository: &dyn Repository,
        workspace: &str,
    ) -> Result<Vec<IntegrationSummary>> {
        Ok(repository
            .integrations(workspace)
            .await?
            .into_iter()
            .map(|item| IntegrationSummary {
                available: !self.registry.capabilities(&item.provider).is_empty(),
                capabilities: self.registry.capabilities(&item.provider),
                id: item.id,
                name: item.name,
                enabled: item.enabled,
            })
            .collect())
    }
    pub fn validate_config(&self, provider: &str, version: u32, config: &Value) -> Result<Value> {
        self.registry.validate_config(provider, version, config)
    }
    pub async fn lookup(
        &self,
        repository: &dyn Repository,
        query: TraceQuery,
        cancelled: Arc<AtomicBool>,
    ) -> Result<TracePage> {
        if cancelled.load(Ordering::Relaxed) {
            return Err(ObservabilityError::Cancelled);
        }
        let _slot = self
            .slots
            .try_acquire()
            .map_err(|_| ObservabilityError::Busy)?;
        tokio::select! {
            result = self.lookup_inner(repository, query) => {
                if cancelled.load(Ordering::Relaxed) { Err(ObservabilityError::Cancelled) } else { result }
            }
            _ = async { loop {
                if cancelled.load(Ordering::Relaxed) { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }} => Err(ObservabilityError::Cancelled),
            _ = tokio::time::sleep(Duration::from_secs(15)) => Err(ObservabilityError::ProviderFailed),
        }
    }
    async fn lookup_inner(
        &self,
        repository: &dyn Repository,
        query: TraceQuery,
    ) -> Result<TracePage> {
        for id in [
            &query.workspace_id,
            &query.integration_id,
            &query.document_id,
        ] {
            if id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|v| v.is_ascii_alphanumeric() || b"_-.".contains(&v))
            {
                return Err(ObservabilityError::InvalidQuery);
            }
        }
        if query.search.len() > 128 || query.cursor.as_ref().is_some_and(|v| v.len() > 100) {
            return Err(ObservabilityError::InvalidQuery);
        }
        let instance = repository
            .integrations(&query.workspace_id)
            .await?
            .into_iter()
            .find(|v| v.id == query.integration_id)
            .ok_or(ObservabilityError::Unavailable)?;
        if !instance.enabled {
            return Err(ObservabilityError::Disabled);
        }
        let provider = self.registry.provider(&instance.provider)?;
        let config = self.registry.validate_config(
            &instance.provider,
            instance.config_version,
            &instance.config,
        )?;
        if let Some(connection) = &query.connection {
            let url = reqwest::Url::parse(&connection.endpoint)
                .map_err(|_| ObservabilityError::InvalidConfig)?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some()
                || connection.endpoint.len() > 8192
                || connection.headers.len() > 64
                || connection.headers.iter().any(|(name, value)| {
                    name.len() > 256
                        || value.len() > 16384
                        || reqwest::header::HeaderName::from_bytes(name.as_bytes()).is_err()
                        || reqwest::header::HeaderValue::from_str(value).is_err()
                })
            {
                return Err(ObservabilityError::InvalidConfig);
            }
        }
        let mut digest = Sha256::new();
        // Resolved environment and auth are memory-only and isolate cache entries.
        digest.update(
            serde_json::to_vec(&query.connection).map_err(|_| ObservabilityError::InvalidConfig)?,
        );
        digest.update(
            serde_json::to_vec(&(
                &query.workspace_id,
                &instance.id,
                &instance.provider,
                instance.config_version,
                &config,
            ))
            .map_err(|_| ObservabilityError::InvalidConfig)?,
        );
        let mut values = BTreeMap::new();
        for key in self.registry.credential_keys(&instance.provider, &config)? {
            let credential = instance
                .credentials
                .get(key)
                .ok_or(ObservabilityError::CredentialUnavailable)?;
            if credential.kind != "secret" {
                return Err(ObservabilityError::CredentialUnavailable);
            }
            let reference = credential
                .reference
                .as_deref()
                .ok_or(ObservabilityError::CredentialUnavailable)?;
            ScopedCredentials::validate_ref(&query.workspace_id, &instance.id, key, reference)?;
            let value = repository
                .secret(reference)
                .await?
                .ok_or(ObservabilityError::CredentialUnavailable)?;
            digest.update(key.as_bytes());
            digest.update(Sha256::digest(value.as_bytes()));
            values.insert(key.to_string(), value);
        }
        let credentials = ScopedCredentials::new(values);
        let mut correlation = CorrelationProvenance::default();
        let trace_id = if let Some(manual) = &query.manual_trace_id {
            if !valid_trace_id(manual) {
                return Err(ObservabilityError::InvalidQuery);
            }
            if let Ok(exchange) = repository.exchange(&query, false).await {
                correlation.injected_trace_id = self
                    .registry
                    .references(&ExchangeInput {
                        request_headers: exchange.request_headers,
                        ..Default::default()
                    })?
                    .first()
                    .map(|r| r.id.clone());
            }
            let id = manual.to_ascii_lowercase();
            correlation.lookup_reference = Some(TraceReference {
                id: id.clone(),
                source: "manual".into(),
                format: "trace-id".into(),
            });
            Some(id)
        } else {
            // Saving is asynchronous; native lookup tolerates the normal debounce.
            let mut exchange = Err(ObservabilityError::ResponsePending);
            for _ in 0..10 {
                exchange = repository
                    .exchange(&query, self.registry.needs_body_prefix())
                    .await;
                if !matches!(exchange, Err(ObservabilityError::ResponsePending)) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let mut exchange = exchange?;
            if let Some(mapping) = &instance.tracing {
                mapping.apply(&mut exchange);
            }
            correlation.injected_trace_id = self
                .registry
                .references(&ExchangeInput {
                    request_headers: exchange.request_headers.clone(),
                    ..Default::default()
                })?
                .first()
                .map(|r| r.id.clone());
            correlation.lookup_reference = self.registry.references(&exchange)?.into_iter().next();
            correlation.lookup_reference.as_ref().map(|r| r.id.clone())
        };
        let Some(trace_id) = trace_id else {
            return Ok(empty_page());
        };
        digest.update(trace_id.as_bytes());
        let key = format!("{:x}", digest.finalize());
        let cached_trace = self
            .cache
            .lock()
            .map_err(|_| ObservabilityError::Busy)?
            .get(&key);
        let cached = cached_trace.is_some();
        let trace = match cached_trace {
            Some(trace) => trace,
            None => {
                let Some(trace) = provider
                    .get_trace(
                        ProviderContext {
                            connection: query.connection.as_ref(),
                            config: &config,
                            credentials: &credentials,
                        },
                        &trace_id,
                    )
                    .await?
                else {
                    let mut page = empty_page();
                    page.correlation = correlation;
                    return Ok(page);
                };
                if !valid_trace_id(&trace.id)
                    || trace.spans.len() > 50_000
                    || serde_json::to_vec(&trace)
                        .map_err(|_| ObservabilityError::ProviderFailed)?
                        .len()
                        > 16 * 1024 * 1024
                    || trace.spans.iter().any(|span| {
                        span.id.is_empty()
                            || span.id.len() > 64
                            || span
                                .parent_span_id
                                .as_ref()
                                .is_some_and(|id| id.is_empty() || id.len() > 64)
                            || span.started_at_us > 9_007_199_254_740_991
                            || span.duration_us > 9_007_199_254_740_991
                            || span.service.len() > 256
                            || span.operation.len() > 256
                            || span.attributes.len() > 256
                            || span
                                .attributes
                                .iter()
                                .any(|(k, v)| k.len() > 128 || !v.is_bounded())
                    })
                {
                    return Err(ObservabilityError::LimitExceeded);
                }
                // Reject malformed parent graphs before admitting a provider result to cache.
                super::hierarchy::rows(&trace.spans, "")?;
                self.cache
                    .lock()
                    .map_err(|_| ObservabilityError::Busy)?
                    .insert(key.clone(), trace.clone());
                trace
            }
        };
        // Cursor belongs to this exact workspace/provider/config/credential/query.
        let snapshot = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&trace).map_err(|_| ObservabilityError::ProviderFailed)?
            )
        );
        let cursor_key = format!(
            "{:x}",
            Sha256::digest(
                format!(
                    "{key}:{snapshot}:{}:{}:{}",
                    query.document_id, query.started_at_ms, query.search
                )
                .as_bytes()
            )
        );
        let offset = match query.cursor {
            None => 0,
            Some(cursor) => {
                let (generation, offset) = cursor
                    .split_once(':')
                    .ok_or(ObservabilityError::InvalidCursor)?;
                if generation != cursor_key {
                    return Err(ObservabilityError::InvalidCursor);
                }
                offset
                    .parse::<usize>()
                    .map_err(|_| ObservabilityError::InvalidCursor)?
            }
        };
        let rows = super::hierarchy::rows(&trace.spans, &query.search)?;
        if offset > rows.len() {
            return Err(ObservabilityError::InvalidCursor);
        }
        let total = rows.len();
        let end = offset.saturating_add(500).min(total);
        let rows = rows[offset..end].to_vec();
        let by_id: BTreeMap<_, _> = trace.spans.iter().map(|span| (&span.id, span)).collect();
        let spans = rows
            .iter()
            .filter_map(|row| by_id.get(&row.span_id).map(|span| (*span).clone()))
            .collect();
        correlation.resolved_trace_id = Some(trace.id.clone());
        let started_at_us = trace
            .spans
            .iter()
            .map(|span| span.started_at_us)
            .min()
            .unwrap_or(0);
        let ended_at_us = trace
            .spans
            .iter()
            .map(|span| span.started_at_us.saturating_add(span.duration_us))
            .max()
            .unwrap_or(started_at_us);
        Ok(TracePage {
            timing: Some(TraceTiming {
                started_at_us,
                duration_us: ended_at_us.saturating_sub(started_at_us),
            }),
            protocol_version: 2,
            trace_id: Some(trace.id),
            spans,
            rows,
            correlation,
            total,
            next_cursor: (end < total).then(|| format!("{cursor_key}:{end}")),
            cached,
        })
    }
}
fn empty_page() -> TracePage {
    TracePage {
        timing: None,
        protocol_version: 2,
        trace_id: None,
        spans: vec![],
        total: 0,
        next_cursor: None,
        cached: false,
        correlation: CorrelationProvenance::default(),
        rows: vec![],
    }
}
