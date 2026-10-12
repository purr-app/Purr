//! Stable safe availability reasons. Never classify translated platform messages.
use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProtectedStatus {
    // Reserved for provider lock state; current file-root provider cannot be locked.
    #[allow(dead_code)]
    Locked,
    Unavailable,
    Corrupt,
    Denied,
    RecoveryRequired,
}
#[derive(Clone, Debug, Serialize)]
pub struct ProtectedError {
    pub status: ProtectedStatus,
    pub code: &'static str,
    pub retryable: bool,
}
impl ProtectedError {
    pub fn new(status: ProtectedStatus, code: &'static str, retryable: bool) -> Self {
        Self {
            status,
            code,
            retryable,
        }
    }
    pub fn unavailable(code: &'static str) -> Self {
        Self::new(ProtectedStatus::Unavailable, code, true)
    }
    pub fn corrupt(code: &'static str) -> Self {
        Self::new(ProtectedStatus::Corrupt, code, false)
    }
    pub fn denied(code: &'static str) -> Self {
        Self::new(ProtectedStatus::Denied, code, true)
    }
}
impl std::fmt::Display for ProtectedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code)
    }
}
impl From<String> for ProtectedError {
    fn from(_: String) -> Self {
        Self::unavailable("protected-storage-unavailable")
    }
}
impl From<&str> for ProtectedError {
    fn from(_: &str) -> Self {
        Self::unavailable("protected-storage-unavailable")
    }
}
