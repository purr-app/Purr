use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum AttributeScalar {
    String(String),
    Bool(bool),
    Number(f64),
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum AttributeValue {
    Scalar(AttributeScalar),
    Array(Vec<AttributeScalar>),
}
impl From<&str> for AttributeValue {
    fn from(value: &str) -> Self {
        Self::Scalar(AttributeScalar::String(value.into()))
    }
}
impl AttributeValue {
    pub fn is_bounded(&self) -> bool {
        let valid = |value: &AttributeScalar| match value {
            AttributeScalar::String(value) => value.len() <= 1024,
            AttributeScalar::Number(value) => value.is_finite(),
            AttributeScalar::Bool(_) => true,
        };
        match self {
            Self::Scalar(value) => valid(value),
            Self::Array(values) => values.len() <= 32 && values.iter().all(valid),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Span {
    pub id: String,
    pub parent_span_id: Option<String>,
    pub service: String,
    pub operation: String,
    pub started_at_us: u64,
    pub duration_us: u64,
    pub status: SpanStatus,
    pub attributes: BTreeMap<String, AttributeValue>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SpanStatus {
    Unset,
    Ok,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Trace {
    pub id: String,
    pub spans: Vec<Span>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TracePage {
    pub protocol_version: u32,
    pub trace_id: Option<String>,
    pub spans: Vec<Span>,
    pub total: usize,
    pub next_cursor: Option<String>,
    pub cached: bool,
    pub correlation: CorrelationProvenance,
    pub rows: Vec<SpanRow>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CorrelationProvenance {
    pub injected_trace_id: Option<String>,
    pub lookup_reference: Option<TraceReference>,
    pub resolved_trace_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceReference {
    pub id: String,
    pub source: String,
    pub format: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpanRow {
    pub span_id: String,
    pub depth: usize,
    pub has_children: bool,
    pub matches_search: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationSummary {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub enabled: bool,
    pub capabilities: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceQuery {
    pub workspace_id: String,
    pub integration_id: String,
    pub document_id: String,
    pub started_at_ms: u64,
    pub manual_trace_id: Option<String>,
    pub search: String,
    pub cursor: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ObservabilityError {
    Unavailable,
    Disabled,
    InvalidConfig,
    CredentialUnavailable,
    InvalidQuery,
    ResponsePending,
    Cancelled,
    LimitExceeded,
    ProviderFailed,
    StorageUnavailable,
    InvalidCursor,
    Busy,
}

pub type Result<T> = std::result::Result<T, ObservabilityError>;

pub fn valid_trace_id(value: &str) -> bool {
    matches!(value.len(), 16 | 32)
        && value.bytes().all(|v| v.is_ascii_hexdigit())
        && value.bytes().any(|v| v != b'0')
}
