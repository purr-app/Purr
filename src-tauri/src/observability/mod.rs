pub mod cache;
pub mod correlation;
pub mod credentials;
pub mod domain;
#[cfg(any(test, feature = "observability-fixtures"))]
mod fixtures;
pub mod native;
pub mod registry;
pub mod service;
#[cfg(test)]
mod tests;

pub struct ObservabilityState {
    pub service: service::ObservabilityService,
    pub operations: crate::content::operations_state::ContentOperationState,
}
impl Default for ObservabilityState {
    fn default() -> Self {
        let builder = registry::RegistryBuilder::default()
            .extractor(correlation::StandardCorrelation)
            .expect("unique core extractor");
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
        Self {
            service: service::ObservabilityService::new(builder.build()),
            operations: Default::default(),
        }
    }
}
