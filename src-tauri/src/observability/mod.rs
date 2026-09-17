pub mod cache;
pub mod correlation;
pub mod credentials;
pub mod domain;
#[cfg(any(test, feature = "observability-fixtures"))]
mod fixtures;
pub mod hierarchy;
pub mod native;
pub mod propagation;
#[cfg(feature = "jaeger")]
pub mod providers;
pub mod registry;
pub mod service;
#[cfg(test)]
mod tests;

pub struct ObservabilityState {
    pub service: service::ObservabilityService,
    pub operations: crate::content::operations_state::ContentOperationState,
}
impl ObservabilityState {
    pub(crate) fn new(registry: registry::Registry) -> Self {
        Self {
            service: service::ObservabilityService::new(registry),
            operations: Default::default(),
        }
    }
}

pub(crate) fn core_registry_builder() -> registry::RegistryBuilder {
    let builder = registry::RegistryBuilder::default()
        .propagator(propagation::StandardPropagator(true))
        .expect("unique W3C propagator")
        .propagator(propagation::StandardPropagator(false))
        .expect("unique B3 propagator")
        .extractor(correlation::StandardCorrelation)
        .expect("unique core extractor");
    #[cfg(feature = "jaeger")]
    let builder = builder
        .descriptor(providers::jaeger::JaegerDescriptor)
        .expect("unique Jaeger descriptor")
        .trace_provider(providers::jaeger::JaegerProvider::default())
        .expect("unique Jaeger trace capability");
    #[cfg(feature = "observability-fixtures")]
    let builder = builder
        .provider(fixtures::SyntheticProvider {
            id: "test.trace-alpha",
            service: "synthetic-alpha",
        })
        .expect("unique fixture")
        .provider(fixtures::SyntheticProvider {
            id: "test.trace-beta",
            service: "synthetic-beta",
        })
        .expect("unique fixture");
    builder
}

impl Default for ObservabilityState {
    fn default() -> Self {
        Self::new(core_registry_builder().build())
    }
}
