use super::domain::Trace;
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

// Memory-only, per process. No trace data is added to project YAML or SQLite.
// Entries are validated to <=16 MiB; eviction bounds total serialized size to 64 MiB.
#[derive(Default)]
pub struct TraceCache(VecDeque<(String, Instant, Trace, usize)>);
impl TraceCache {
    pub fn get(&mut self, key: &str) -> Option<Trace> {
        self.0
            .retain(|(_, time, _, _)| time.elapsed() < Duration::from_secs(60));
        self.0
            .iter()
            .find(|(id, _, _, _)| id == key)
            .map(|(_, _, trace, _)| trace.clone())
    }
    pub fn insert(&mut self, key: String, trace: Trace) {
        self.0.retain(|(id, _, _, _)| id != &key);
        let bytes = serde_json::to_vec(&trace)
            .map(|value| value.len())
            .unwrap_or(usize::MAX);
        if bytes > 16 * 1024 * 1024 {
            return;
        }
        while self.0.len() >= 32
            || self.0.iter().map(|entry| entry.3).sum::<usize>() + bytes > 64 * 1024 * 1024
        {
            self.0.pop_front();
        }
        self.0.push_back((key, Instant::now(), trace, bytes));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_capacity_and_ttl_are_enforced_without_wall_clock_waits() {
        let mut cache = TraceCache::default();
        for index in 0..33 {
            cache.insert(
                index.to_string(),
                Trace {
                    id: index.to_string(),
                    spans: vec![],
                },
            );
        }
        assert!(cache.get("0").is_none());
        assert!(cache.get("32").is_some());
        cache.0.back_mut().unwrap().1 = Instant::now() - Duration::from_secs(61);
        assert!(cache.get("32").is_none());
    }
}
