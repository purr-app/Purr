use super::{
    correlation::CorrelationExtractor,
    credentials::ScopedCredentials,
    domain::{ObservabilityError, Result, Trace},
};
use serde_json::Value;
use std::{collections::BTreeMap, future::Future, pin::Pin, sync::Arc};

pub type ProviderFuture<'a> = Pin<Box<dyn Future<Output = Result<Option<Trace>>> + Send + 'a>>;
// Provider implementation methods are exercised by the opt-in fixture build.
#[cfg_attr(not(any(test, feature = "observability-fixtures")), allow(dead_code))]
pub struct ProviderContext<'a> {
    pub config: &'a Value,
    pub credentials: &'a ScopedCredentials,
}
pub trait TraceProvider: Send + Sync {
    #[cfg_attr(not(any(test, feature = "observability-fixtures")), allow(dead_code))]
    fn id(&self) -> &'static str;
    fn credential_keys(&self) -> &'static [&'static str];
    fn validate_and_migrate(&self, version: u32, config: &Value) -> Result<Value>;
    fn get_trace<'a>(
        &'a self,
        context: ProviderContext<'a>,
        trace_id: &'a str,
    ) -> ProviderFuture<'a>;
}

// No mutation surface survives build(). Private registration is exported in Phase 15.
pub struct Registry {
    providers: BTreeMap<&'static str, Arc<dyn TraceProvider>>,
    extractors: Vec<Arc<dyn CorrelationExtractor>>,
}
#[derive(Default)]
pub struct RegistryBuilder {
    providers: BTreeMap<&'static str, Arc<dyn TraceProvider>>,
    extractors: BTreeMap<&'static str, Arc<dyn CorrelationExtractor>>,
}
impl RegistryBuilder {
    #[cfg_attr(not(any(test, feature = "observability-fixtures")), allow(dead_code))]
    pub fn provider(mut self, provider: impl TraceProvider + 'static) -> Result<Self> {
        if self
            .providers
            .insert(provider.id(), Arc::new(provider))
            .is_some()
        {
            return Err(ObservabilityError::InvalidConfig);
        }
        Ok(self)
    }
    pub fn extractor(mut self, extractor: impl CorrelationExtractor + 'static) -> Result<Self> {
        if self
            .extractors
            .insert(extractor.id(), Arc::new(extractor))
            .is_some()
        {
            return Err(ObservabilityError::InvalidConfig);
        }
        Ok(self)
    }
    pub fn build(self) -> Registry {
        Registry {
            providers: self.providers,
            extractors: self.extractors.into_values().collect(),
        }
    }
}
impl Registry {
    pub fn needs_body_prefix(&self) -> bool {
        self.extractors
            .iter()
            .any(|extractor| extractor.needs_body_prefix())
    }
    pub fn provider(&self, id: &str) -> Result<Arc<dyn TraceProvider>> {
        self.providers
            .get(id)
            .cloned()
            .ok_or(ObservabilityError::Unavailable)
    }
    pub fn extract(&self, input: &super::correlation::ExchangeInput) -> Result<Vec<String>> {
        let mut refs = Vec::new();
        for extractor in &self.extractors {
            for id in extractor.extract(input)? {
                if !super::domain::valid_trace_id(&id) {
                    return Err(ObservabilityError::ProviderFailed);
                }
                if !refs.contains(&id) {
                    refs.push(id);
                }
                if refs.len() == 8 {
                    return Ok(refs);
                }
            }
        }
        Ok(refs)
    }
}
