use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const MAX_OPERATION_ID_BYTES: usize = 128;
const MAX_PENDING_CANCELLATIONS: usize = 1024;
const CANCELLATION_TOMBSTONE_TTL: Duration = Duration::from_secs(60);

struct OperationEntry {
    cancelled: Arc<AtomicBool>,
    registered: bool,
    changed_at: Instant,
}

#[derive(Default)]
pub struct ContentOperationState(Mutex<HashMap<String, OperationEntry>>);

impl ContentOperationState {
    pub fn register(&self, id: &str) -> Result<Arc<AtomicBool>, String> {
        validate_operation_id(id)?;
        let mut operations = self
            .0
            .lock()
            .map_err(|_| "Response operation state is unavailable")?;
        prune_tombstones(&mut operations);
        if let Some(entry) = operations.get_mut(id) {
            if entry.cancelled.load(Ordering::Relaxed) && !entry.registered {
                entry.registered = true;
                entry.changed_at = Instant::now();
                return Ok(entry.cancelled.clone());
            }
            return Err("Response operation ID is already active".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        operations.insert(
            id.into(),
            OperationEntry {
                cancelled: cancelled.clone(),
                registered: true,
                changed_at: Instant::now(),
            },
        );
        Ok(cancelled)
    }

    pub fn cancel(&self, id: &str) -> Result<(), String> {
        validate_operation_id(id)?;
        let mut operations = self
            .0
            .lock()
            .map_err(|_| "Response operation state is unavailable")?;
        prune_tombstones(&mut operations);
        if let Some(entry) = operations.get_mut(id) {
            entry.cancelled.store(true, Ordering::Relaxed);
            entry.changed_at = Instant::now();
        } else {
            if operations.len() >= MAX_PENDING_CANCELLATIONS {
                return Err("Too many pending response-operation cancellations".into());
            }
            operations.insert(
                id.into(),
                OperationEntry {
                    cancelled: Arc::new(AtomicBool::new(true)),
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
        return Err("Invalid response operation ID".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_before_registration_is_observed() {
        let state = ContentOperationState::default();
        state.cancel("search-before-start").unwrap();
        let cancelled = state.register("search-before-start").unwrap();
        assert!(cancelled.load(Ordering::Relaxed));
        state.finish("search-before-start");
        assert!(state.register("../invalid").is_err());
    }
}
