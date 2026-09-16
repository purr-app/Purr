use super::domain::{valid_trace_id, Result};

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
}

pub struct StandardCorrelation;
impl CorrelationExtractor for StandardCorrelation {
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
