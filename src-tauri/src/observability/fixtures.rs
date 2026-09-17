// Explicit opt-in test providers. Never registered in a normal OSS/release build.
use super::{
    domain::*,
    registry::{IntegrationDescriptor, ProviderContext, ProviderFuture, TraceProvider},
};
use serde::Deserialize;
use serde_json::{json, Value};

pub struct SyntheticProvider {
    pub id: &'static str,
    pub service: &'static str,
}
impl IntegrationDescriptor for SyntheticProvider {
    fn id(&self) -> &'static str {
        self.id
    }
    fn credential_keys(&self, _: &Value) -> Vec<&'static str> {
        vec!["apiToken"]
    }
    fn validate_and_migrate(&self, version: u32, config: &Value) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Config {
            #[serde(default)]
            delay_ms: u64,
        }
        if version != 1 {
            return Err(ObservabilityError::InvalidConfig);
        }
        let parsed: Config = serde_json::from_value(config.clone())
            .map_err(|_| ObservabilityError::InvalidConfig)?;
        if parsed.delay_ms > 5000 {
            return Err(ObservabilityError::InvalidConfig);
        }
        Ok(json!({ "delayMs": parsed.delay_ms }))
    }
}
impl TraceProvider for SyntheticProvider {
    fn provider_id(&self) -> &'static str {
        self.id
    }
    fn get_trace<'a>(
        &'a self,
        context: ProviderContext<'a>,
        trace_id: &'a str,
    ) -> ProviderFuture<'a> {
        Box::pin(async move {
            if context.credentials.get("apiToken")?.is_empty() {
                return Err(ObservabilityError::CredentialUnavailable);
            }
            tokio::time::sleep(std::time::Duration::from_millis(
                context.config["delayMs"].as_u64().unwrap_or(0),
            ))
            .await;
            Ok(Some(Trace {
                id: trace_id.into(),
                spans: (0..600)
                    .map(|index| Span {
                        id: format!("{:016x}", index + 1),
                        parent_span_id: (index > 0).then(|| "0000000000000001".into()),
                        service: self.service.into(),
                        operation: format!("synthetic-operation-{index}"),
                        started_at_us: 1_700_000_000_000_000 + index * 1000,
                        duration_us: 750,
                        status: if index == 3 {
                            SpanStatus::Error
                        } else {
                            SpanStatus::Ok
                        },
                        attributes: [("fixture".into(), "purr-synthetic".into())].into(),
                    })
                    .collect(),
            }))
        })
    }
}
