//! Canonical template classification shared with the TypeScript parser.
pub(crate) fn template_whitespace(character: char) -> bool {
    // ECMAScript trim/\s, shared with the TS token parser. Rust's Unicode
    // whitespace differs for NEL and BOM, which must not alter classification.
    matches!(character,'\u{0009}'..='\u{000D}'|'\u{0020}'|'\u{00A0}'|'\u{1680}'|'\u{2000}'..='\u{200A}'|'\u{2028}'|'\u{2029}'|'\u{202F}'|'\u{205F}'|'\u{3000}'|'\u{FEFF}')
}
pub(crate) fn template_only(value: &str) -> bool {
    let value = value.trim_matches(template_whitespace);
    value
        .strip_prefix("{{")
        .and_then(|value| value.strip_suffix("}}"))
        .is_some_and(|name| {
            !name.trim_matches(template_whitespace).is_empty() && !name.contains(['{', '}'])
        })
}
