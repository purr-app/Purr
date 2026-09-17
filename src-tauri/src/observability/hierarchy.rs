use super::domain::{ObservabilityError, Result, Span, SpanRow};
use std::collections::{BTreeMap, BTreeSet};

// Native projection: parent-first rows are stable across incremental IPC pages.
// Missing parents remain roots. Cycles/duplicate IDs are rejected, not guessed.
pub fn rows(spans: &[Span], search: &str) -> Result<Vec<SpanRow>> {
    let by_id: BTreeMap<_, _> = spans.iter().map(|span| (span.id.as_str(), span)).collect();
    if by_id.len() != spans.len() {
        return Err(ObservabilityError::ProviderFailed);
    }
    let mut children: BTreeMap<Option<&str>, Vec<&Span>> = BTreeMap::new();
    for span in spans {
        let parent = span
            .parent_span_id
            .as_deref()
            .filter(|id| by_id.contains_key(id));
        children.entry(parent).or_default().push(span);
    }
    for values in children.values_mut() {
        values.sort_by_key(|span| (span.started_at_us, &span.id));
    }
    let needle = search.to_lowercase();
    let matched: BTreeSet<&str> = spans
        .iter()
        .filter(|span| {
            needle.is_empty()
                || [&span.id, &span.service, &span.operation]
                    .iter()
                    .any(|v| v.to_lowercase().contains(&needle))
                || format!("{:?}", span.status)
                    .to_lowercase()
                    .contains(&needle)
                || span.attributes.iter().any(|(key, value)| {
                    key.to_lowercase().contains(&needle)
                        || serde_json::to_string(value)
                            .unwrap_or_default()
                            .to_lowercase()
                            .contains(&needle)
                })
        })
        .map(|span| span.id.as_str())
        .collect();
    let mut included = BTreeSet::new();
    for id in &matched {
        let mut current = Some(*id);
        while let Some(id) = current {
            if !included.insert(id) {
                break;
            }
            current = by_id
                .get(id)
                .and_then(|span| span.parent_span_id.as_deref())
                .filter(|id| by_id.contains_key(id));
        }
    }
    let mut stack: Vec<_> = children
        .get(&None)
        .into_iter()
        .flatten()
        .rev()
        .map(|span| (*span, 0))
        .collect();
    let mut result = vec![];
    let mut visited = 0;
    while let Some((span, depth)) = stack.pop() {
        visited += 1;
        let descendants = children.get(&Some(span.id.as_str()));
        if included.contains(span.id.as_str()) {
            result.push(SpanRow {
                span_id: span.id.clone(),
                depth,
                has_children: descendants.is_some_and(|items| {
                    items.iter().any(|item| included.contains(item.id.as_str()))
                }),
                matches_search: matched.contains(span.id.as_str()),
            });
        }
        for child in descendants.into_iter().flatten().rev() {
            stack.push((child, depth + 1));
        }
    }
    if visited != spans.len() {
        return Err(ObservabilityError::ProviderFailed);
    }
    Ok(result)
}
