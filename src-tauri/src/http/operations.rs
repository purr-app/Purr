use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::sync::watch;

const MAX_OPERATION_ID_BYTES: usize = 128;
const MAX_PENDING_CANCELLATIONS: usize = 1024;
const CANCELLATION_TOMBSTONE_TTL: Duration = Duration::from_secs(60);

struct OperationEntry {
    sender: watch::Sender<bool>,
    registered: bool,
    changed_at: Instant,
}

#[derive(Default)]
pub struct HttpOperationState(Mutex<HashMap<String, OperationEntry>>);

impl HttpOperationState {
    pub fn register(&self, id: &str) -> Result<watch::Receiver<bool>, String> {
        validate_operation_id(id)?;
        let mut operations = self
            .0
            .lock()
            .map_err(|_| "HTTP operation state is unavailable")?;
        prune_tombstones(&mut operations);
        if let Some(entry) = operations.get_mut(id) {
            if *entry.sender.borrow() && !entry.registered {
                entry.registered = true;
                entry.changed_at = Instant::now();
                return Ok(entry.sender.subscribe());
            }
            return Err("HTTP operation ID is already active".into());
        }
        let (sender, receiver) = watch::channel(false);
        operations.insert(
            id.into(),
            OperationEntry {
                sender,
                registered: true,
                changed_at: Instant::now(),
            },
        );
        Ok(receiver)
    }

    pub fn cancel(&self, id: &str) -> Result<(), String> {
        validate_operation_id(id)?;
        let mut operations = self
            .0
            .lock()
            .map_err(|_| "HTTP operation state is unavailable")?;
        prune_tombstones(&mut operations);
        if let Some(entry) = operations.get_mut(id) {
            let _ = entry.sender.send(true);
            entry.changed_at = Instant::now();
        } else {
            // Keep a cancellation tombstone so cancel/start command ordering
            // cannot start network work after the user cancelled.
            if operations.len() >= MAX_PENDING_CANCELLATIONS {
                return Err("Too many pending HTTP cancellations".into());
            }
            let (sender, _) = watch::channel(true);
            operations.insert(
                id.into(),
                OperationEntry {
                    sender,
                    registered: false,
                    changed_at: Instant::now(),
                },
            );
        }
        Ok(())
    }

    pub fn finish(&self, id: &str) {
        if let Ok(mut operations) = self.0.lock() {
            operations.remove(id);
        }
    }

    #[cfg(test)]
    fn contains(&self, id: &str) -> bool {
        self.0
            .lock()
            .is_ok_and(|operations| operations.contains_key(id))
    }
}

fn prune_tombstones(operations: &mut HashMap<String, OperationEntry>) {
    operations.retain(|_, entry| {
        entry.registered || entry.changed_at.elapsed() < CANCELLATION_TOMBSTONE_TTL
    });
}

fn validate_operation_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > MAX_OPERATION_ID_BYTES
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Invalid HTTP operation ID".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_before_registration_is_observed_and_cleanup_is_idempotent() {
        let state = HttpOperationState::default();
        state.cancel("request-before-start").unwrap();
        let receiver = state.register("request-before-start").unwrap();
        assert!(*receiver.borrow());
        state.finish("request-before-start");
        state.finish("request-before-start");
        assert!(!state.contains("request-before-start"));
    }

    #[test]
    fn active_operation_can_be_cancelled_only_through_its_opaque_id() {
        let state = HttpOperationState::default();
        let receiver = state.register("request-active").unwrap();
        assert!(!*receiver.borrow());
        assert!(state.register("request-active").is_err());
        state.cancel("request-active").unwrap();
        assert!(*receiver.borrow());
        state.finish("request-active");
        assert!(!state.contains("request-active"));
        assert!(state.register("../invalid").is_err());
    }
}
