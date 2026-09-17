//! Stable native contracts for build-time Purr extensions.
//!
//! This module intentionally exposes normalized observability contracts and
//! constrained registration only. It does not expose persistence, secure
//! storage, raw SQLite access, or Purr's command dispatcher.

pub use crate::observability::correlation::{CorrelationExtractor, ExchangeInput};
pub use crate::observability::credentials::ScopedCredentials;
pub use crate::observability::domain::{
    AttributeScalar, AttributeValue, ObservabilityError, Result as ObservabilityResult, Span,
    SpanStatus, Trace, TraceReference,
};
pub use crate::observability::propagation::TracePropagator;
pub use crate::observability::registry::{
    IntegrationDescriptor, ProviderContext, ProviderFuture, TraceProvider,
};
