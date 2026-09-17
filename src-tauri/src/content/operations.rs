use jaq_core::load::{Arena, File, Loader};
use jsonpath_rfc9535::{ScanMode, ScanQuery};
use quick_xml::{events::Event, Reader, Writer};
use serde::de::IgnoredAny;
use serde::Deserialize;
use serde_json::Value;
use serde_json_path::JsonPath;
use std::io::{self, Write};

const MAX_QUERY_BYTES: usize = 4 * 1024;
const FULL_TREE_PARSE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_FORMAT_OUTPUT_BYTES: usize = 128 * 1024 * 1024;
const NO_QUERY_MATCH: &str = "The query did not match any response value.";

struct LimitedWriter {
    bytes: Vec<u8>,
}

impl LimitedWriter {
    fn new(capacity: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(capacity.min(MAX_FORMAT_OUTPUT_BYTES)),
        }
    }

    fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

impl Write for LimitedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.bytes.len().saturating_add(bytes.len()) > MAX_FORMAT_OUTPUT_BYTES {
            return Err(io::Error::other(
                "formatted response exceeds the 128 MiB output limit",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub fn format_document(bytes: &[u8], syntax: &str, indent: usize) -> Result<Vec<u8>, String> {
    let indent = indent.clamp(1, 8);
    match syntax {
        "json" => {
            let mut output = LimitedWriter::new(bytes.len());
            let indent_bytes = vec![b' '; indent];
            let formatter = serde_json::ser::PrettyFormatter::with_indent(&indent_bytes);
            let mut serializer = serde_json::Serializer::with_formatter(&mut output, formatter);
            let mut deserializer = serde_json::Deserializer::from_slice(bytes);
            serde_transcode::transcode(&mut deserializer, &mut serializer)
                .map_err(|error| format!("Invalid JSON response: {error}"))?;
            deserializer
                .end()
                .map_err(|error| format!("Invalid JSON response: {error}"))?;
            Ok(output.bytes)
        }
        "ndjson" => {
            let text = std::str::from_utf8(bytes)
                .map_err(|_| "NDJSON response is not valid UTF-8".to_string())?;
            let mut output = LimitedWriter::new(bytes.len());
            for (index, line) in text.lines().enumerate() {
                if line.trim().is_empty() {
                    continue;
                }
                if !output.is_empty() {
                    output
                        .write_all(b"\n")
                        .map_err(|error| format!("Cannot format NDJSON response: {error}"))?;
                }
                let mut deserializer = serde_json::Deserializer::from_str(line);
                let mut serializer = serde_json::Serializer::new(&mut output);
                serde_transcode::transcode(&mut deserializer, &mut serializer).map_err(
                    |error| format!("Invalid NDJSON response on line {}: {error}", index + 1),
                )?;
                deserializer.end().map_err(|error| {
                    format!("Invalid NDJSON response on line {}: {error}", index + 1)
                })?;
            }
            Ok(output.bytes)
        }
        "xml" => format_xml(bytes, indent),
        _ => Err("Unsupported response format".into()),
    }
}

fn format_xml(bytes: &[u8], indent: usize) -> Result<Vec<u8>, String> {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().trim_text(false);
    let mut writer = Writer::new_with_indent(LimitedWriter::new(bytes.len()), b' ', indent);
    let mut buffer = Vec::new();
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| format!("Invalid XML response: {error}"))?;
        match event {
            Event::Eof => break,
            Event::Text(ref text) if text.as_ref().trim().is_empty() => {}
            event => writer
                .write_event(event.into_owned())
                .map_err(|error| format!("Cannot format XML response: {error}"))?,
        }
        buffer.clear();
    }
    Ok(writer.into_inner().bytes)
}

pub fn query_document(bytes: &[u8], language: &str, expression: &str) -> Result<Value, String> {
    if expression.len() > MAX_QUERY_BYTES {
        return Err("Response query exceeds the 4 KiB expression limit".into());
    }
    let input: Value =
        serde_json::from_slice(bytes).map_err(|error| format!("Invalid JSON response: {error}"))?;
    match language {
        "jq" => query_jq(input, expression),
        "jsonpath" => query_jsonpath(&input, expression),
        _ => Err("Unsupported response query language".into()),
    }
}

pub fn query_large_document(
    bytes: &[u8],
    language: &str,
    expression: &str,
    ndjson: bool,
) -> Result<Value, String> {
    if expression.len() > MAX_QUERY_BYTES {
        return Err("Response query exceeds the 4 KiB expression limit".into());
    }
    if ndjson {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| "NDJSON response is not valid UTF-8".to_string())?;
        let mut values = Vec::new();
        for (index, line) in text.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let result = if line.len() as u64 > FULL_TREE_PARSE_BYTES {
                query_large_json(line.as_bytes(), language, expression)
            } else {
                query_document(line.as_bytes(), language, expression)
            };
            match result {
                Ok(value) => values.push(value),
                Err(error) if error == NO_QUERY_MATCH => {}
                Err(error) => return Err(format!("NDJSON line {}: {error}", index + 1)),
            }
        }
        return match values.as_slice() {
            [] => Err(NO_QUERY_MATCH.into()),
            [value] => Ok(value.clone()),
            _ => Ok(Value::Array(values)),
        };
    }
    query_large_json(bytes, language, expression)
}

fn query_large_json(bytes: &[u8], language: &str, expression: &str) -> Result<Value, String> {
    validate_json_without_building_tree(bytes)?;
    let path = match language {
        "jsonpath" => {
            validate_path_subset(expression, "jsonpath")?;
            expression.trim().to_string()
        }
        "jq" => jq_path_as_jsonpath(expression)?,
        _ => return Err("Unsupported response query language".into()),
    };
    if path == "$" || path.contains("..") {
        return Err(
            "This query requires a full response tree and is unavailable above the 32 MiB parse tier"
                .into(),
        );
    }
    let query = ScanQuery::parse(&path)
        .map_err(|error| format!("Invalid streaming response query: {error}"))?
        .with_mode(ScanMode::AlwaysScan);
    let text =
        std::str::from_utf8(bytes).map_err(|_| "JSON response is not valid UTF-8".to_string())?;
    let values = query
        .query_values(text)
        .map_err(|error| format!("Large response query failed: {error}"))?;
    match values.as_slice() {
        [] => Err(NO_QUERY_MATCH.into()),
        [value] => Ok(value.clone()),
        _ => Ok(Value::Array(values)),
    }
}

fn validate_json_without_building_tree(bytes: &[u8]) -> Result<(), String> {
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    IgnoredAny::deserialize(&mut deserializer)
        .map_err(|error| format!("Invalid JSON response: {error}"))?;
    deserializer
        .end()
        .map_err(|error| format!("Invalid JSON response: {error}"))
}

fn jq_path_as_jsonpath(expression: &str) -> Result<String, String> {
    validate_jq_subset(expression)?;
    let mut parts = expression.split('|').map(str::trim);
    let path = parts.next().unwrap_or(".");
    if parts.next().is_some() {
        return Err(
            "jq pipe operations require a full response tree above the 32 MiB parse tier".into(),
        );
    }
    if path == "." {
        return Ok("$".into());
    }
    Ok(format!("${}", path.replace("[]", "[*]")))
}

fn query_jsonpath(input: &Value, expression: &str) -> Result<Value, String> {
    validate_path_subset(expression, "jsonpath")?;
    let path = JsonPath::parse(expression)
        .map_err(|error| format!("Invalid JSONPath expression: {error}"))?;
    let values = path.query(input).all();
    match values.as_slice() {
        [] => Err(NO_QUERY_MATCH.into()),
        [value] => Ok((*value).clone()),
        values => Ok(Value::Array(
            values.iter().map(|value| (*value).clone()).collect(),
        )),
    }
}

fn query_jq(input: Value, expression: &str) -> Result<Value, String> {
    validate_jq_subset(expression)?;
    let arena = Arena::default();
    let definitions = jaq_core::defs()
        .chain(jaq_std::defs())
        .chain(jaq_json::defs());
    let loader = Loader::new(definitions);
    let modules = loader
        .load(
            &arena,
            File {
                path: (),
                code: expression,
            },
        )
        .map_err(|errors| format!("Invalid jq expression: {errors:?}"))?;
    let functions = jaq_core::funs()
        .chain(jaq_std::funs())
        .chain(jaq_json::funs());
    let filter = jaq_core::Compiler::default()
        .with_funs(functions)
        .compile(modules)
        .map_err(|errors| format!("Invalid jq expression: {errors:?}"))?;
    let input: jaq_json::Val = serde_json::from_value(input)
        .map_err(|error| format!("Cannot prepare jq input: {error}"))?;
    let context = jaq_core::Ctx::<jaq_core::data::JustLut<jaq_json::Val>>::new(
        &filter.lut,
        jaq_core::Vars::new([]),
    );
    let mut values = Vec::new();
    for result in filter.id.run((context, input)).map(jaq_core::unwrap_valr) {
        let value = result.map_err(|error| format!("jq query failed: {error}"))?;
        values.push(
            serde_json::from_str::<Value>(&value.to_string())
                .map_err(|error| format!("Cannot decode jq result: {error}"))?,
        );
    }
    match values.as_slice() {
        [] => Err(NO_QUERY_MATCH.into()),
        [value] => Ok(value.clone()),
        _ => Ok(Value::Array(values)),
    }
}

fn validate_jq_subset(expression: &str) -> Result<(), String> {
    let source = expression.trim();
    if source.is_empty() {
        return Ok(());
    }
    let mut parts = source.split('|').map(str::trim);
    validate_path_subset(parts.next().unwrap_or("."), "jq")?;
    for operation in parts {
        if matches!(operation, "length" | "keys") {
            continue;
        }
        validate_path_subset(operation, "jq")?;
    }
    Ok(())
}

// This parser validates the existing public Purr subset only. Evaluation is
// delegated to jaq/serde_json_path; keeping the allow-list here prevents their
// larger languages from becoming an accidental, unbounded public API.
fn validate_path_subset(expression: &str, language: &str) -> Result<(), String> {
    let source = expression.trim();
    if source.is_empty() {
        return Ok(());
    }
    let bytes = source.as_bytes();
    let mut index = 0;
    if language == "jsonpath" {
        if bytes.first() != Some(&b'$') {
            return Err("JSONPath must start with $.".into());
        }
        index = 1;
    } else if bytes.first() != Some(&b'.') {
        return Err("jq selectors must start with a dot.".into());
    }
    while index < bytes.len() {
        match bytes[index] {
            byte if byte.is_ascii_whitespace() => index += 1,
            b'.' => {
                index += 1;
                if index < bytes.len() && bytes[index] == b'.' {
                    index += 1;
                }
                let start = index;
                while index < bytes.len()
                    && !matches!(
                        bytes[index],
                        b'.' | b'[' | b']' | b'|' | b' ' | b'\t' | b'\r' | b'\n'
                    )
                {
                    index += 1;
                }
                if start == index && index < bytes.len() && bytes[index] != b'[' {
                    return Err("Add a property after recursive descent.".into());
                }
            }
            b'[' => {
                let start = index + 1;
                index = start;
                let mut quote = None;
                while index < bytes.len() {
                    let byte = bytes[index];
                    if let Some(active) = quote {
                        if byte == b'\\' {
                            index = (index + 2).min(bytes.len());
                            continue;
                        }
                        if byte == active {
                            quote = None;
                        }
                    } else if matches!(byte, b'\'' | b'"') {
                        quote = Some(byte);
                    } else if byte == b']' {
                        break;
                    }
                    index += 1;
                }
                if index >= bytes.len() || quote.is_some() {
                    return Err("Close the bracket in the query.".into());
                }
                let content = source[start..index].trim();
                let quoted = content.len() >= 2
                    && matches!(content.as_bytes()[0], b'\'' | b'"')
                    && content.as_bytes()[content.len() - 1] == content.as_bytes()[0];
                if !(content.is_empty()
                    || content == "*"
                    || content.bytes().all(|byte| byte.is_ascii_digit())
                    || quoted)
                {
                    return Err(
                        "Use an array index, wildcard, or quoted property in brackets.".into(),
                    );
                }
                index += 1;
            }
            other => {
                return Err(format!(
                    "Unexpected {} in the query.",
                    serde_json::to_string(&(other as char).to_string()).unwrap_or_default()
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct ConformanceFixture {
        document: Value,
        queries: Vec<ConformanceQuery>,
        errors: Vec<ConformanceError>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ConformanceQuery {
        language: String,
        expression: String,
        expected: Value,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ConformanceError {
        language: String,
        expression: String,
        error_pattern: String,
    }

    #[test]
    fn jq_and_jsonpath_adapters_match_the_public_subset() {
        let bytes = br#"{"users":[{"name":"Alex"},{"name":"Rivera"}],"meta":{"name":"page"}}"#;
        assert_eq!(
            query_document(bytes, "jq", ".users[].name").unwrap(),
            serde_json::json!(["Alex", "Rivera"])
        );
        assert_eq!(
            query_document(bytes, "jq", ".users | length").unwrap(),
            serde_json::json!(2)
        );
        assert_eq!(
            query_document(bytes, "jsonpath", "$..name").unwrap(),
            serde_json::json!(["Alex", "Rivera", "page"])
        );
        assert!(query_document(bytes, "jsonpath", "$.missing")
            .unwrap_err()
            .contains("did not match"));
    }

    #[test]
    fn rust_adapters_pass_the_shared_typescript_conformance_fixture() {
        let fixture: ConformanceFixture = serde_json::from_str(include_str!(
            "../../../tests/fixtures/response-query-conformance.json"
        ))
        .unwrap();
        let bytes = serde_json::to_vec(&fixture.document).unwrap();
        for query in fixture.queries {
            assert_eq!(
                query_document(&bytes, &query.language, &query.expression).unwrap(),
                query.expected,
                "{} {}",
                query.language,
                query.expression
            );
        }
        for query in fixture.errors {
            let error = query_document(&bytes, &query.language, &query.expression).unwrap_err();
            assert!(
                error.contains(&query.error_pattern),
                "{error:?} did not contain {:?}",
                query.error_pattern
            );
        }
    }

    #[test]
    fn formatting_uses_bounded_adapters_for_json_ndjson_and_xml() {
        assert_eq!(
            String::from_utf8(format_document(br#"{"ok":true}"#, "json", 2).unwrap()).unwrap(),
            "{\n  \"ok\": true\n}"
        );
        assert_eq!(
            String::from_utf8(
                format_document(b"{\"ok\":true}\n{\"ok\":false}\n", "ndjson", 2).unwrap()
            )
            .unwrap(),
            "{\"ok\":true}\n{\"ok\":false}"
        );
        let xml =
            String::from_utf8(format_document(b"<root><item>1</item></root>", "xml", 2).unwrap())
                .unwrap();
        assert!(xml.contains("\n  <item>"));
    }

    #[test]
    fn query_adapter_rejects_languages_outside_the_current_subset() {
        assert!(query_document(b"{}", "jq", "repeat(1)")
            .unwrap_err()
            .contains("selectors must start"));
        assert!(query_document(b"{}", "jsonpath", "$[?(@.x)]").is_err());
    }

    #[test]
    fn ndjson_queries_collect_matching_records_and_skip_other_valid_records() {
        let bytes = b"{\"fixture\":\"purr-synthetic\"}\n{\"payload\":\"value\"}\n";
        assert_eq!(
            query_large_document(bytes, "jq", ".fixture", true).unwrap(),
            serde_json::json!(["purr-synthetic", null])
        );
        assert_eq!(
            query_large_document(bytes, "jsonpath", "$.fixture", true).unwrap(),
            serde_json::json!("purr-synthetic")
        );
        assert!(query_large_document(bytes, "jsonpath", "$.missing", true)
            .unwrap_err()
            .contains("did not match"));
    }
}
