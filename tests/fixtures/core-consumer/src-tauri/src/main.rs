use purr_core::native_extension_api::{
    IntegrationDescriptor, ObservabilityError, ObservabilityResult, ProviderContext,
    ProviderFuture, Span, SpanStatus, Trace, TraceProvider,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const PROVIDER_ID: &str = "consumer.fixture";

struct ConsumerDescriptor;

impl IntegrationDescriptor for ConsumerDescriptor {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn credential_keys(&self, _config: &Value) -> Vec<&'static str> {
        Vec::new()
    }

    fn validate_and_migrate(&self, version: u32, config: &Value) -> ObservabilityResult<Value> {
        if version != 1 || config.get("fixture") != Some(&Value::Bool(true)) {
            return Err(ObservabilityError::InvalidConfig);
        }
        Ok(json!({ "fixture": true }))
    }
}

struct ConsumerTraceProvider;

impl TraceProvider for ConsumerTraceProvider {
    fn provider_id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn get_trace<'a>(
        &'a self,
        _context: ProviderContext<'a>,
        trace_id: &'a str,
    ) -> ProviderFuture<'a> {
        Box::pin(async move {
            Ok(Some(Trace {
                id: trace_id.to_owned(),
                spans: vec![Span {
                    id: "0000000000000001".into(),
                    parent_span_id: None,
                    service: "external-consumer".into(),
                    operation: "fixture.trace".into(),
                    started_at_us: 1,
                    duration_us: 1_000,
                    status: SpanStatus::Ok,
                    attributes: BTreeMap::new(),
                }],
            }))
        })
    }
}

fn main() {
    purr_core::core_builder()
        .observability_descriptor(ConsumerDescriptor)
        .expect("consumer descriptor must be unique")
        .trace_provider(ConsumerTraceProvider)
        .expect("consumer trace provider must match its descriptor")
        .plugin(tauri_plugin_consumer_fixture::init())
        .run(tauri::generate_context!())
        .expect("error while running the external Purr core consumer");
}
