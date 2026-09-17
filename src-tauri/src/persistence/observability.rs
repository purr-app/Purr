// Read-only projection of canonical integration files and encrypted execution
// metadata. No provider policy, no body hydration, and no alternate write path.
use super::project_files::FilesystemWorkspaceStore;
use crate::observability::{
    correlation::ExchangeInput,
    domain::{ObservabilityError, Result},
    service::Integration,
};
use serde::Deserialize;
use serde_json::Value;
use std::{collections::BTreeSet, fs, io::Read};

pub fn integrations(
    files: &FilesystemWorkspaceStore,
) -> std::result::Result<Vec<Integration>, String> {
    let directory = files
        .path("integrations/placeholder.yaml")?
        .parent()
        .ok_or("Invalid integration directory")?
        .to_owned();
    if !directory.exists() {
        return Ok(vec![]);
    }
    let mut result: Vec<Integration> = vec![];
    let mut ids = BTreeSet::new();
    for entry in fs::read_dir(directory).map_err(|_| "Cannot read integration directory")? {
        let entry = entry.map_err(|_| "Cannot read integration file")?;
        if !entry
            .file_type()
            .map_err(|_| "Cannot inspect integration file")?
            .is_file()
        {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".yaml") {
            continue;
        }
        if result.len() >= 128 {
            return Err("Integration limit exceeded".into());
        }
        let mut bytes = vec![];
        fs::File::open(files.path(&format!("integrations/{name}"))?)
            .map_err(|_| "Cannot open integration")?
            .take(65537)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read integration")?;
        if bytes.len() > 65536 {
            return Err("Integration limit exceeded".into());
        }
        let value: Value = serde_yaml::from_slice(&bytes).map_err(|_| "Invalid integration")?;
        if value["purr"] != 1 {
            return Err("Unsupported project format".into());
        }
        if value["kind"] != "integration" {
            continue;
        }
        let integration: Integration =
            serde_json::from_value(value).map_err(|_| "Invalid integration")?;
        if integration.id.len() > 128
            || integration.name.len() > 256
            || !ids.insert(integration.id.clone())
        {
            return Err("Invalid or duplicate integration".into());
        }
        result.push(integration);
    }
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(result)
}

#[derive(Deserialize)]
struct Headers {
    headers: Vec<(String, String)>,
}
#[derive(Deserialize)]
struct LegacyTimeline {
    request: Headers,
}
#[derive(Deserialize)]
struct Content {
    id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredResponse {
    protocol_version: Option<u32>,
    request: Option<Headers>,
    response: Option<Headers>,
    content: Option<Content>,
    headers: Option<Vec<(String, String)>>,
    timeline: Option<LegacyTimeline>,
}
#[derive(Deserialize)]
struct Execution {
    response: StoredResponse,
}

pub fn exchange(value: Value) -> Result<ExchangeInput> {
    let execution: Execution =
        serde_json::from_value(value).map_err(|_| ObservabilityError::StorageUnavailable)?;
    let response = execution.response;
    let (request_headers, response_headers, content_id) = match response.protocol_version {
        Some(2) => (
            response
                .request
                .ok_or(ObservabilityError::StorageUnavailable)?
                .headers,
            response
                .response
                .ok_or(ObservabilityError::StorageUnavailable)?
                .headers,
            Some(
                response
                    .content
                    .ok_or(ObservabilityError::StorageUnavailable)?
                    .id,
            ),
        ),
        None => (
            response
                .timeline
                .ok_or(ObservabilityError::StorageUnavailable)?
                .request
                .headers,
            response
                .headers
                .ok_or(ObservabilityError::StorageUnavailable)?,
            None,
        ),
        _ => return Err(ObservabilityError::StorageUnavailable),
    };
    for headers in [&request_headers, &response_headers] {
        if headers.len() > 256
            || headers
                .iter()
                .map(|(k, v)| k.len() + v.len())
                .sum::<usize>()
                > 65536
        {
            return Err(ObservabilityError::LimitExceeded);
        }
    }
    if content_id
        .as_ref()
        .is_some_and(|id| id.is_empty() || id.len() > 256)
    {
        return Err(ObservabilityError::StorageUnavailable);
    }
    Ok(ExchangeInput {
        request_headers,
        response_headers,
        content_id,
        body_prefix: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn native_and_legacy_metadata_decode_without_response_body() {
        let native = json!({"response":{"protocolVersion":2,"request":{"headers":[["b3","0123456789abcdef"]]},"response":{"headers":[]},"content":{"id":"opaque"}}});
        let input = exchange(native.clone()).unwrap();
        assert_eq!(input.content_id.as_deref(), Some("opaque"));
        assert_eq!(input.request_headers[0].0, "b3");
        let legacy = json!({"response":{"headers":[],"timeline":{"request":{"headers":[]}}}});
        assert!(exchange(legacy).unwrap().content_id.is_none());
        let mut future = native;
        future["response"]["protocolVersion"] = json!(3);
        assert!(exchange(future).is_err());
    }
    #[test]
    fn integration_reader_is_bounded_and_keeps_unknown_provider_config() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("integrations")).unwrap();
        let file = temp.path().join("integrations/test.yaml");
        fs::write(&file, "purr: 1\nkind: integration\nid: unknown\nname: Unknown\nprovider: unavailable\nconfigVersion: 3\nconfig: { nested: [1, false] }\ncredentials: {}\n").unwrap();
        let store = FilesystemWorkspaceStore {
            directory: temp.path().into(),
        };
        assert_eq!(
            integrations(&store).unwrap()[0].config["nested"],
            json!([1, false])
        );
        assert!(integrations(&store).unwrap()[0].enabled);
        fs::write(file, vec![b'x'; 65537]).unwrap();
        assert!(integrations(&store).is_err());
    }
}
