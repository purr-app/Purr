use super::domain::{valid_trace_id, Result, TraceReference};

#[derive(Default)]
pub struct ExchangeInput {
    pub request_headers: Vec<(String, String)>,
    pub response_headers: Vec<(String, String)>,
    pub content_id: Option<String>,
    pub body_prefix: Vec<u8>,
}

pub trait CorrelationExtractor: Send + Sync {
    fn id(&self) -> &'static str;
    fn needs_body_prefix(&self) -> bool {
        false
    }
    fn extract(&self, input: &ExchangeInput) -> Result<Vec<String>>;
    fn references(&self, input: &ExchangeInput) -> Result<Vec<TraceReference>> {
        Ok(self
            .extract(input)?
            .into_iter()
            .map(|id| TraceReference {
                id,
                source: "extractor".into(),
                format: self.id().into(),
            })
            .collect())
    }
}

pub struct StandardCorrelation;
impl CorrelationExtractor for StandardCorrelation {
    fn references(&self, input: &ExchangeInput) -> Result<Vec<TraceReference>> {
        let mut refs = vec![];
        for (source, headers) in [
            ("response", &input.response_headers),
            ("request", &input.request_headers),
        ] {
            for header in headers {
                let one = ExchangeInput {
                    request_headers: vec![header.clone()],
                    ..Default::default()
                };
                for id in self.extract(&one)? {
                    refs.push(TraceReference {
                        id,
                        source: source.into(),
                        format: header.0.to_lowercase(),
                    });
                    if refs.len() == 8 {
                        return Ok(refs);
                    }
                }
            }
        }
        Ok(refs)
    }
    fn id(&self) -> &'static str {
        "purr.w3c-b3"
    }
    fn extract(&self, input: &ExchangeInput) -> Result<Vec<String>> {
        let mut refs = Vec::new();
        for (name, value) in input.response_headers.iter().chain(&input.request_headers) {
            let name = name.to_ascii_lowercase();
            let candidate = match name.as_str() {
                "traceparent" => {
                    let parts: Vec<_> = value.split('-').collect();
                    if parts.len() != 4
                        || parts[0] != "00"
                        || parts[1].len() != 32
                        || parts[2].len() != 16
                        || !parts[2].bytes().all(|b| b.is_ascii_hexdigit())
                        || !parts[2].bytes().any(|b| b != b'0')
                        || parts[3].len() != 2
                        || !parts[3].bytes().all(|b| b.is_ascii_hexdigit())
                    {
                        continue;
                    }
                    parts[1]
                }
                "b3" => value.split('-').next().unwrap_or(""),
                "x-b3-traceid" => value,
                _ => continue,
            };
            if valid_trace_id(candidate) {
                let id = candidate.to_ascii_lowercase();
                if !refs.contains(&id) {
                    refs.push(id);
                }
            }
            if refs.len() == 8 {
                break;
            }
        }
        Ok(refs)
    }
}

// Portable header mappings augment standard extraction, with response precedence.
#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TracingHeaders {
    #[serde(default)]
    request_headers: Vec<HeaderMapping>,
    #[serde(default)]
    response_headers: Vec<HeaderMapping>,
}
#[derive(Clone, serde::Deserialize)]
struct HeaderMapping {
    name: String,
    value: String,
    enabled: bool,
}
impl TracingHeaders {
    pub fn apply(&self, exchange: &mut ExchangeInput) {
        fn mapped(rows: &[HeaderMapping], headers: &[(String, String)]) -> Vec<(String, String)> {
            rows.iter()
                .filter(|row| row.enabled)
                .take(32)
                .flat_map(|row| {
                    let target = match row.value.trim() {
                        "traceparent" | "{{$traceparent}}" => "traceparent",
                        "b3" | "{{$b3}}" => "b3",
                        "traceId" | "{{$traceId}}" => "x-b3-traceid",
                        _ => return vec![],
                    };
                    headers
                        .iter()
                        .filter(|(name, _)| name.eq_ignore_ascii_case(&row.name))
                        .map(|(_, value)| (target.to_string(), value.clone()))
                        .collect()
                })
                .collect()
        }
        let request = mapped(&self.request_headers, &exchange.request_headers);
        let response = mapped(&self.response_headers, &exchange.response_headers);
        exchange.request_headers.splice(0..0, request);
        exchange.response_headers.splice(0..0, response);
    }
}
