use aes_gcm::aead::{rand_core::RngCore, OsRng};
use serde::{Deserialize, Deserializer};
use std::{collections::BTreeMap, sync::Arc};

#[derive(Clone, Debug, Default)]
pub enum PropagationPolicy {
    #[default]
    Off,
    W3c,
    B3,
    Custom(String),
}
impl<'de> Deserialize<'de> for PropagationPolicy {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "off" => Self::Off,
            "w3c" => Self::W3c,
            "b3" => Self::B3,
            _ if value.len() <= 64
                && !value.is_empty()
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) =>
            {
                Self::Custom(value)
            }
            _ => return Err(serde::de::Error::custom("Invalid propagation format")),
        })
    }
}
pub trait TracePropagator: Send + Sync {
    fn id(&self) -> &'static str;
    fn context_headers(&self) -> &'static [&'static str];
    fn prepare(&self) -> Vec<(String, String)>;
}
pub struct StandardPropagator(pub bool);
impl TracePropagator for StandardPropagator {
    fn id(&self) -> &'static str {
        if self.0 {
            "w3c"
        } else {
            "b3"
        }
    }
    fn context_headers(&self) -> &'static [&'static str] {
        &[
            "traceparent",
            "tracestate",
            "b3",
            "x-b3-traceid",
            "x-b3-spanid",
            "x-b3-sampled",
            "x-b3-flags",
        ]
    }
    fn prepare(&self) -> Vec<(String, String)> {
        inject(
            if self.0 {
                PropagationPolicy::W3c
            } else {
                PropagationPolicy::B3
            },
            &mut vec![],
        )
    }
}
#[derive(Default)]
pub struct PropagationRegistry(BTreeMap<&'static str, Arc<dyn TracePropagator>>);
impl PropagationRegistry {
    pub fn register(
        &mut self,
        propagator: impl TracePropagator + 'static,
    ) -> super::domain::Result<()> {
        if self.0.contains_key(propagator.id()) {
            return Err(super::domain::ObservabilityError::InvalidConfig);
        }
        self.0.insert(propagator.id(), Arc::new(propagator));
        Ok(())
    }
    pub fn prepare_mapped(
        &self,
        policy: &PropagationPolicy,
        headers: &[(String, String)],
        templates: &[(String, String)],
    ) -> Result<Vec<(String, String)>, String> {
        if templates.is_empty() {
            return self.prepare(policy, headers);
        }
        if matches!(policy, PropagationPolicy::Off) {
            return Ok(vec![]);
        }
        if templates.len() > 32 {
            return Err("Too many tracing headers".into());
        }
        if templates.iter().any(|(name, value)| {
            ["{{$traceparent}}", "{{$b3}}", "{{$traceId}}", "{{$spanId}}"]
                .iter()
                .any(|token| value.contains(token))
                && headers
                    .iter()
                    .any(|(existing, _)| existing.eq_ignore_ascii_case(name))
        }) {
            return Ok(vec![]);
        }
        let generated = self.prepare(policy, headers)?;
        if generated.is_empty() {
            return Ok(vec![]);
        }
        let value = &generated[0].1;
        let parts: Vec<_> = value.split('-').collect();
        let (trace, span) = match policy {
            PropagationPolicy::W3c if parts.len() == 4 => (parts[1], parts[2]),
            PropagationPolicy::B3 if parts.len() >= 2 => (parts[0], parts[1]),
            _ => return Err("Custom header templates require W3C or B3 propagation".into()),
        };
        let traceparent = format!("00-{trace}-{span}-01");
        let b3 = format!("{trace}-{span}-1");
        let mut result = vec![];
        for (name, template) in templates {
            if headers
                .iter()
                .any(|(existing, _)| existing.eq_ignore_ascii_case(name))
            {
                continue;
            }
            let value = template
                .replace("{{$traceparent}}", &traceparent)
                .replace("{{$b3}}", &b3)
                .replace("{{$traceId}}", trace)
                .replace("{{$spanId}}", span);
            if name.len() > 256
                || value.len() > 8192
                || value.contains("{{")
                || reqwest::header::HeaderName::from_bytes(name.as_bytes()).is_err()
                || reqwest::header::HeaderValue::from_str(&value).is_err()
            {
                return Err("Invalid tracing header template".into());
            }
            result.push((name.clone(), value));
        }
        Ok(result)
    }
    pub fn prepare(
        &self,
        policy: &PropagationPolicy,
        headers: &[(String, String)],
    ) -> Result<Vec<(String, String)>, String> {
        let id = match policy {
            PropagationPolicy::Off => return Ok(vec![]),
            PropagationPolicy::W3c => "w3c",
            PropagationPolicy::B3 => "b3",
            PropagationPolicy::Custom(id) => id,
        };
        let propagator = self
            .0
            .get(id)
            .ok_or("Trace propagation format is unavailable")?;
        if headers.iter().any(|(name, _)| {
            self.0.values().any(|p| {
                p.context_headers()
                    .iter()
                    .any(|header| name.eq_ignore_ascii_case(header))
            })
        }) {
            return Ok(vec![]);
        }
        let result = propagator.prepare();
        if result.len() > 4
            || result.iter().any(|(name, value)| {
                name.len() > 64
                    || value.len() > 128
                    || !propagator
                        .context_headers()
                        .iter()
                        .any(|declared| name.eq_ignore_ascii_case(declared))
            })
        {
            return Err("Invalid trace propagation headers".into());
        }
        Ok(result)
    }
}

// Runs once at the transport boundary. Explicit context is never overwritten or
// supplemented with a conflicting format. No network/provider dependency.
pub fn inject(
    policy: PropagationPolicy,
    headers: &mut Vec<(String, String)>,
) -> Vec<(String, String)> {
    if matches!(policy, PropagationPolicy::Off)
        || headers.iter().any(|(name, _)| {
            matches!(
                name.to_ascii_lowercase().as_str(),
                "traceparent"
                    | "tracestate"
                    | "b3"
                    | "x-b3-traceid"
                    | "x-b3-spanid"
                    | "x-b3-sampled"
                    | "x-b3-flags"
            )
        })
    {
        return vec![];
    }
    let mut bytes = [0u8; 24];
    OsRng.fill_bytes(&mut bytes);
    // Ensure IDs are non-zero even in the astronomically unlikely zero draw.
    if bytes[..16].iter().all(|v| *v == 0) {
        bytes[0] = 1;
    }
    if bytes[16..].iter().all(|v| *v == 0) {
        bytes[16] = 1;
    }
    let hex = |bytes: &[u8]| bytes.iter().map(|v| format!("{v:02x}")).collect::<String>();
    let trace = hex(&bytes[..16]);
    let span = hex(&bytes[16..]);
    let header = match policy {
        PropagationPolicy::W3c => ("traceparent".into(), format!("00-{trace}-{span}-01")),
        PropagationPolicy::B3 => ("b3".into(), format!("{trace}-{span}-1")),
        PropagationPolicy::Off => unreachable!(),
        PropagationPolicy::Custom(_) => return vec![],
    };
    headers.push(header.clone());
    vec![header]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observability::correlation::{
        CorrelationExtractor, ExchangeInput, StandardCorrelation,
    };
    #[test]
    fn custom_templates_share_ids_and_preserve_explicit_header_values() {
        let mut registry = PropagationRegistry::default();
        registry.register(StandardPropagator(true)).unwrap();
        let templates = vec![
            ("x-context".into(), "{{$traceparent}}".into()),
            ("x-trace".into(), "{{$traceId}}".into()),
            ("x-span".into(), "{{$spanId}}".into()),
        ];
        let generated = registry
            .prepare_mapped(&PropagationPolicy::W3c, &[], &templates)
            .unwrap();
        assert_eq!(generated.len(), 3);
        assert_eq!(
            generated[0].1,
            format!("00-{}-{}-01", generated[1].1, generated[2].1)
        );
        let explicit = vec![("X-Trace".into(), "user-value".into())];
        let next = registry
            .prepare_mapped(&PropagationPolicy::W3c, &explicit, &templates)
            .unwrap();
        assert!(next.is_empty());
        assert!(registry
            .prepare_mapped(&PropagationPolicy::Off, &[], &templates)
            .unwrap()
            .is_empty());
        assert!(registry
            .prepare_mapped(
                &PropagationPolicy::W3c,
                &[],
                &[("bad\r\nname".into(), "value".into())]
            )
            .is_err());
    }
    #[test]
    fn registry_supports_independent_formats_and_rejects_duplicates_and_unknowns() {
        struct Custom;
        impl TracePropagator for Custom {
            fn id(&self) -> &'static str {
                "test.custom"
            }
            fn context_headers(&self) -> &'static [&'static str] {
                &["x-fixture-trace"]
            }
            fn prepare(&self) -> Vec<(String, String)> {
                vec![("x-fixture-trace".into(), "synthetic".into())]
            }
        }
        let mut registry = PropagationRegistry::default();
        registry.register(Custom).unwrap();
        let policy: PropagationPolicy = serde_json::from_str("\"test.custom\"").unwrap();
        let headers = registry.prepare(&policy, &[]).unwrap();
        assert_eq!(headers[0].0, "x-fixture-trace");
        assert!(registry.prepare(&policy, &headers).unwrap().is_empty());
        assert!(registry.prepare(&PropagationPolicy::W3c, &[]).is_err());
        assert!(registry.register(Custom).is_err());
    }
    #[test]
    fn generates_valid_fresh_context_and_preserves_explicit_headers() {
        for policy in [PropagationPolicy::W3c, PropagationPolicy::B3] {
            let mut headers = vec![];
            let generated = inject(policy.clone(), &mut headers);
            assert_eq!(generated, headers);
            let ids = StandardCorrelation
                .extract(&ExchangeInput {
                    request_headers: headers.clone(),
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(ids.len(), 1);
            assert!(inject(policy.clone(), &mut headers).is_empty());
            assert_eq!(headers, generated);
            let mut second = vec![];
            inject(policy, &mut second);
            assert_ne!(headers, second);
        }
        let mut invalid = vec![("TraceParent".into(), "user-invalid".into())];
        assert!(inject(PropagationPolicy::B3, &mut invalid).is_empty());
        assert_eq!(invalid.len(), 1);
        assert!(inject(PropagationPolicy::Off, &mut vec![]).is_empty());
    }
}
