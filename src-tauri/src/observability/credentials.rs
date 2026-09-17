use super::domain::{ObservabilityError, Result};
use std::collections::BTreeMap;
use zeroize::Zeroizing;

// Constructed by the native service from the provider's declared keys only.
// Neither references nor plaintext values implement Serialize or Debug.
// Consumed only by opt-in providers until the Phase 14 adapter is added.
#[cfg_attr(not(any(test, feature = "observability-fixtures")), allow(dead_code))]
pub struct ScopedCredentials(BTreeMap<String, Zeroizing<String>>);

impl ScopedCredentials {
    pub(crate) fn new(values: BTreeMap<String, Zeroizing<String>>) -> Self {
        Self(values)
    }
    #[cfg_attr(not(any(test, feature = "observability-fixtures")), allow(dead_code))]
    pub fn get(&self, key: &str) -> Result<&str> {
        self.0
            .get(key)
            .map(|value| value.as_str())
            .ok_or(ObservabilityError::CredentialUnavailable)
    }
    pub(crate) fn validate_ref(
        workspace: &str,
        integration: &str,
        key: &str,
        reference: &str,
    ) -> Result<()> {
        if reference != format!("purr/{workspace}/integrations/{integration}/{key}") {
            return Err(ObservabilityError::CredentialUnavailable);
        }
        Ok(())
    }
}
