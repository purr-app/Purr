//! The only production boundary that accesses OS root credentials.
use super::ProtectedError;
#[cfg(target_os = "macos")]
use super::ProtectedStatus;
use zeroize::Zeroizing;

pub(super) trait OsKeyStore: Send + Sync {
    fn read(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Zeroizing<String>>, ProtectedError>;
    /// Must not replace an existing entry, including a racing external writer.
    fn create(&self, service: &str, account: &str, value: &str) -> Result<(), ProtectedError>;
    fn read_legacy(&self) -> Result<Option<Zeroizing<String>>, ProtectedError>;
}
pub(super) struct PlatformKeyStore;

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use security_framework::os::macos::keychain::SecPreferencesDomain;
    use std::{ffi::c_void, ptr::NonNull};
    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecKeychainCopyDomainDefault(
            domain: SecPreferencesDomain,
            keychain: *mut *mut c_void,
        ) -> i32;
        fn SecKeychainGetStatus(keychain: *mut c_void, status: *mut u32) -> i32;
        fn SecKeychainAddGenericPassword(
            keychain: *mut c_void,
            service_length: u32,
            service: *const u8,
            account_length: u32,
            account: *const u8,
            password_length: u32,
            password: *const u8,
            item: *mut *mut c_void,
        ) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: *const c_void);
    }

    // keyring's "User" target uses this exact preferences domain. Retain the
    // selected keychain through create/status so process-default changes cannot
    // write an entry into a different keychain from subsequent readback.
    struct UserKeychain(NonNull<c_void>);
    impl UserKeychain {
        fn open() -> Result<Self, i32> {
            let mut pointer = std::ptr::null_mut();
            let result =
                unsafe { SecKeychainCopyDomainDefault(SecPreferencesDomain::User, &mut pointer) };
            if result != 0 {
                if !pointer.is_null() {
                    unsafe {
                        CFRelease(pointer);
                    }
                }
                return Err(result);
            }
            NonNull::new(pointer).map(Self).ok_or(-25291)
        }
        fn locked(&self) -> bool {
            // Query only status; never unlock or modify access control.
            let mut status = 0;
            let result = unsafe { SecKeychainGetStatus(self.0.as_ptr(), &mut status) };
            result == 0 && status & 1 == 0 // kSecUnlockStateStatus
        }
    }
    impl Drop for UserKeychain {
        fn drop(&mut self) {
            unsafe {
                CFRelease(self.0.as_ptr());
            }
        }
    }
    fn confirmed_locked() -> bool {
        UserKeychain::open().is_ok_and(|keychain| keychain.locked())
    }
    fn status_error(code: i32, locked: bool) -> ProtectedError {
        if locked {
            return ProtectedError::new(ProtectedStatus::Locked, "root-provider-locked", true);
        }
        match code {
            -128 | -25293 | -25292 | -25308 => {
                ProtectedError::denied("root-provider-access-denied")
            }
            -25295 | -26275 => ProtectedError::corrupt("root-provider-corrupt"),
            -25299 => ProtectedError::new(
                ProtectedStatus::RecoveryRequired,
                "root-key-conflict",
                false,
            ),
            _ => ProtectedError::unavailable("root-provider-unavailable"),
        }
    }
    fn map_error(error: keyring::Error) -> ProtectedError {
        match error {
            keyring::Error::PlatformFailure(error) | keyring::Error::NoStorageAccess(error) => {
                let code = error
                    .downcast_ref::<security_framework::base::Error>()
                    .map(|e| e.code());
                status_error(code.unwrap_or(0), confirmed_locked())
            }
            keyring::Error::BadEncoding(mut bytes) => {
                zeroize::Zeroize::zeroize(&mut bytes);
                ProtectedError::corrupt("root-key-invalid")
            }
            keyring::Error::Ambiguous(_) => status_error(-25299, false),
            _ => ProtectedError::unavailable("root-provider-unavailable"),
        }
    }
    impl OsKeyStore for PlatformKeyStore {
        fn read(
            &self,
            service: &str,
            account: &str,
        ) -> Result<Option<Zeroizing<String>>, ProtectedError> {
            let entry =
                keyring::Entry::new_with_target("User", service, account).map_err(map_error)?;
            match entry.get_password() {
                Ok(value) => Ok(Some(Zeroizing::new(value))),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(error) => Err(map_error(error)),
            }
        }
        fn create(&self, service: &str, account: &str, value: &str) -> Result<(), ProtectedError> {
            let length = |s: &str| {
                u32::try_from(s.len()).map_err(|_| ProtectedError::corrupt("root-identity-invalid"))
            };
            let keychain = UserKeychain::open().map_err(|code| status_error(code, false))?;
            let result = unsafe {
                SecKeychainAddGenericPassword(
                    keychain.0.as_ptr(),
                    length(service)?,
                    service.as_ptr(),
                    length(account)?,
                    account.as_ptr(),
                    length(value)?,
                    value.as_ptr(),
                    std::ptr::null_mut(),
                )
            };
            if result == 0 {
                Ok(())
            } else {
                Err(status_error(result, keychain.locked()))
            }
        }
        fn read_legacy(&self) -> Result<Option<Zeroizing<String>>, ProtectedError> {
            self.read(super::super::KEYCHAIN_SERVICE, super::super::ROOT_KEY_REF)
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn classifies_only_confirmed_lock_and_structured_status() {
            assert_eq!(status_error(-25308, false).status, ProtectedStatus::Denied);
            assert_eq!(status_error(-25308, true).status, ProtectedStatus::Locked);
            assert_eq!(status_error(-128, false).status, ProtectedStatus::Denied);
            assert_eq!(
                status_error(-25291, false).status,
                ProtectedStatus::Unavailable
            );
            assert_eq!(status_error(-26275, false).status, ProtectedStatus::Corrupt);
        }
    }
}
#[cfg(not(target_os = "macos"))]
impl OsKeyStore for PlatformKeyStore {
    fn read(&self, _: &str, _: &str) -> Result<Option<Zeroizing<String>>, ProtectedError> {
        Err(ProtectedError::unavailable("root-provider-unsupported"))
    }
    fn create(&self, _: &str, _: &str, _: &str) -> Result<(), ProtectedError> {
        Err(ProtectedError::unavailable("root-provider-unsupported"))
    }
    fn read_legacy(&self) -> Result<Option<Zeroizing<String>>, ProtectedError> {
        Err(ProtectedError::unavailable("root-provider-unsupported"))
    }
}
