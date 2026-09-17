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
    pub connection: Option<&'a super::domain::TraceConnection>,
    pub config: &'a Value,
    pub credentials: &'a ScopedCredentials,
}
pub trait TraceProvider: Send + Sync {
    #[cfg_attr(not(any(test, feature = "observability-fixtures")), allow(dead_code))]
    fn provider_id(&self) -> &'static str;
    fn get_trace<'a>(
        &'a self,
        context: ProviderContext<'a>,
        trace_id: &'a str,
    ) -> ProviderFuture<'a>;
}

// One descriptor per integration provider. Capabilities register independently;
// no log execution API is invented before its first use case.
pub trait IntegrationDescriptor: Send + Sync {
    fn id(&self) -> &'static str;
    fn credential_keys(&self, config: &Value) -> Vec<&'static str>;
    fn validate_and_migrate(&self, version: u32, config: &Value) -> Result<Value>;
}

// No mutation surface survives build(). Private registration is exported in Phase 15.
pub struct Registry {
    pub(super) propagators: super::propagation::PropagationRegistry,
    descriptors: BTreeMap<&'static str, Arc<dyn IntegrationDescriptor>>,
    capabilities: BTreeMap<&'static str, Vec<String>>,
    providers: BTreeMap<&'static str, Arc<dyn TraceProvider>>,
    extractors: Vec<Arc<dyn CorrelationExtractor>>,
}
#[derive(Default)]
pub struct RegistryBuilder {
    propagators: super::propagation::PropagationRegistry,
    descriptors: BTreeMap<&'static str, Arc<dyn IntegrationDescriptor>>,
    capabilities: BTreeMap<&'static str, Vec<String>>,
    providers: BTreeMap<&'static str, Arc<dyn TraceProvider>>,
    extractors: BTreeMap<&'static str, Arc<dyn CorrelationExtractor>>,
}
impl RegistryBuilder {
    pub fn propagator(
        mut self,
        propagator: impl super::propagation::TracePropagator + 'static,
    ) -> Result<Self> {
        self.propagators.register(propagator)?;
        Ok(self)
    }
    #[cfg_attr(not(feature = "jaeger"), allow(dead_code))]
    pub fn descriptor(mut self, descriptor: impl IntegrationDescriptor + 'static) -> Result<Self> {
        let id = descriptor.id();
        if self.descriptors.insert(id, Arc::new(descriptor)).is_some() {
            return Err(ObservabilityError::InvalidConfig);
        }
        Ok(self)
    }
    fn capability(mut self, provider: &'static str, capability: &'static str) -> Result<Self> {
        if !self.descriptors.contains_key(provider) || capability.is_empty() {
            return Err(ObservabilityError::InvalidConfig);
        }
        let capabilities = self.capabilities.entry(provider).or_default();
        if capabilities.iter().any(|value| value == capability) {
            return Err(ObservabilityError::InvalidConfig);
        }
        capabilities.push(capability.into());
        Ok(self)
    }
    #[cfg_attr(not(feature = "jaeger"), allow(dead_code))]
    pub fn trace_provider(mut self, provider: impl TraceProvider + 'static) -> Result<Self> {
        self = self.capability(provider.provider_id(), "traces")?;
        if self
            .providers
            .insert(provider.provider_id(), Arc::new(provider))
            .is_some()
        {
            return Err(ObservabilityError::InvalidConfig);
        }
        Ok(self)
    }
    // Fixture convenience: the same object implements two independent traits.
    #[cfg(any(test, feature = "observability-fixtures"))]
    pub fn provider(
        mut self,
        provider: impl TraceProvider + IntegrationDescriptor + 'static,
    ) -> Result<Self> {
        if provider.provider_id() != IntegrationDescriptor::id(&provider) {
            return Err(ObservabilityError::InvalidConfig);
        }
        let id = provider.provider_id();
        let provider = Arc::new(provider);
        if self.descriptors.insert(id, provider.clone()).is_some() {
            return Err(ObservabilityError::InvalidConfig);
        }
        self = self.capability(id, "traces")?;
        self.providers.insert(id, provider);
        Ok(self)
    }
    #[cfg(all(test, feature = "jaeger"))]
    pub fn fake_capability(self, provider: &'static str) -> Result<Self> {
        self.capability(provider, "test.capability")
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
            propagators: self.propagators,
            descriptors: self.descriptors,
            capabilities: self.capabilities,
            providers: self.providers,
            extractors: self.extractors.into_values().collect(),
        }
    }
}
impl Registry {
    pub fn capabilities(&self, id: &str) -> Vec<String> {
        self.capabilities.get(id).cloned().unwrap_or_default()
    }
    pub fn validate_config(&self, id: &str, version: u32, config: &Value) -> Result<Value> {
        self.descriptors
            .get(id)
            .ok_or(ObservabilityError::Unavailable)?
            .validate_and_migrate(version, config)
    }
    pub fn credential_keys(&self, id: &str, config: &Value) -> Result<Vec<&'static str>> {
        Ok(self
            .descriptors
            .get(id)
            .ok_or(ObservabilityError::Unavailable)?
            .credential_keys(config))
    }
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
    #[cfg(test)]
    pub fn extract(&self, input: &super::correlation::ExchangeInput) -> Result<Vec<String>> {
        Ok(self
            .references(input)?
            .into_iter()
            .map(|reference| reference.id)
            .collect())
    }
    pub fn references(
        &self,
        input: &super::correlation::ExchangeInput,
    ) -> Result<Vec<super::domain::TraceReference>> {
        let mut refs = Vec::new();
        for extractor in &self.extractors {
            for reference in extractor.references(input)? {
                if !super::domain::valid_trace_id(&reference.id)
                    || reference.source.is_empty()
                    || reference.source.len() > 64
                    || reference.format.is_empty()
                    || reference.format.len() > 128
                {
                    return Err(ObservabilityError::ProviderFailed);
                }
                if !refs
                    .iter()
                    .any(|item: &super::domain::TraceReference| item.id == reference.id)
                {
                    refs.push(reference);
                }
                if refs.len() == 8 {
                    return Ok(refs);
                }
            }
        }
        Ok(refs)
    }
}
