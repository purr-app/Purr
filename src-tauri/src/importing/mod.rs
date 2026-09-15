use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

const MAX_SOURCE_BYTES: usize = 64 * 1024 * 1024;
const MAX_SOURCE_DOCUMENTS: usize = 256;

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ImportSource {
    Path { path: String },
    File { path: String },
    Directory { path: String },
    Url { url: String },
    Text { name: String, content: String },
}
impl ImportSource {
    fn metadata(&self) -> (&'static str, String) {
        match self {
            Self::Path { path } => ("file", path.clone()),
            Self::File { path } => ("file", path.clone()),
            Self::Directory { path } => ("directory", path.clone()),
            Self::Url { url } => ("url", url.clone()),
            Self::Text { name, .. } => ("text", name.clone()),
        }
    }
}

struct LoadedSource {
    source: ImportSource,
    name: String,
    root: String,
    raw: String,
    documents: HashMap<String, Value>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportDiagnostic {
    severity: &'static str,
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_path: Option<String>,
}
#[derive(Clone)]
struct ImportVariable {
    id: String,
    name: String,
    value: String,
    sensitive: bool,
}
#[derive(Clone)]
struct ImportEnvironment {
    id: String,
    name: String,
    description: Option<String>,
    variables: Vec<ImportVariable>,
}
#[derive(Clone)]
struct ImportParameter {
    name: String,
    location: String,
    required: bool,
    value: String,
}
#[derive(Clone)]
struct ImportBody {
    media_type: String,
    value: Value,
    required: HashSet<String>,
    description: Option<String>,
}
#[derive(Clone)]
struct ImportResponse {
    status: String,
    description: Option<String>,
}
#[derive(Clone)]
struct ImportOperation {
    pointer: String,
    operation_id: Option<String>,
    name: String,
    description: Option<String>,
    method: String,
    path: String,
    folder: String,
    parameters: Vec<ImportParameter>,
    body: Option<ImportBody>,
    body_content_types: Vec<String>,
    responses: Vec<ImportResponse>,
    security: Option<Vec<String>>,
}
#[derive(Clone)]
struct ImportAuth {
    name: String,
    config: Value,
}
struct ImportModel {
    title: String,
    description: Option<String>,
    source_kind: String,
    source_location: String,
    source_document: String,
    variables: Vec<ImportVariable>,
    environments: Vec<ImportEnvironment>,
    operations: Vec<ImportOperation>,
    auth: HashMap<String, ImportAuth>,
    global_security: Vec<String>,
    diagnostics: Vec<ImportDiagnostic>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedImportResult {
    workspace: Value,
    resources: Vec<Value>,
    diagnostics: Vec<ImportDiagnostic>,
    secrets: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_environment_id: Option<String>,
}

trait ImportAdapter {
    fn can_import(&self, source: &LoadedSource) -> bool;
    fn normalize(&self, source: &LoadedSource) -> Result<ImportModel, String>;
}
struct OpenApi3Adapter;

fn parse_document(content: &str) -> Result<Value, String> {
    serde_yaml::from_str(content).map_err(|_| "The import source is not valid JSON or YAML.".into())
}
fn openapi_version(value: &Value) -> Option<&str> {
    value.get("openapi")?.as_str()
}
fn candidate_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "json" | "yaml" | "yml" | "openapi"
            )
        })
}
fn collect_files(root: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
    if output.len() >= MAX_SOURCE_DOCUMENTS {
        return Err("The import source contains too many schema files.".into());
    }
    for entry in fs::read_dir(root).map_err(|_| "The selected import folder is not accessible.")? {
        let entry = entry.map_err(|_| "The selected import folder is not accessible.")?;
        let path = entry.path();
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.')
            || entry
                .file_type()
                .map_err(|_| "The selected import folder is not accessible.")?
                .is_symlink()
        {
            continue;
        }
        if path.is_dir() {
            collect_files(&path, output)?;
        } else if candidate_file(&path) {
            output.push(path);
            if output.len() > MAX_SOURCE_DOCUMENTS {
                return Err("The import source contains too many schema files.".into());
            }
        }
    }
    Ok(())
}

fn load_local_references(
    documents: &mut HashMap<String, Value>,
    total: &mut usize,
    root: &str,
) -> Result<(), String> {
    let mut pending = vec![root.to_string()];
    let mut visited = HashSet::new();
    while let Some(base_key) = pending.pop() {
        if !visited.insert(base_key.clone()) {
            continue;
        }
        let value = documents
            .get(&base_key)
            .ok_or("A referenced OpenAPI document was not loaded.")?;
        let base = Url::parse(&base_key).map_err(|_| "Invalid reference base path.")?;
        let mut references = Vec::new();
        collect_refs(value, &mut references);
        for reference in references {
            let mut target = base
                .join(&reference)
                .map_err(|_| format!("OpenAPI reference '{reference}' is invalid."))?;
            target.set_fragment(None);
            if target.scheme() != "file" {
                return Err(format!(
                    "Local OpenAPI sources may only reference local files; '{reference}' is not local."
                ));
            }
            let target_key = target.to_string();
            if !documents.contains_key(&target_key) {
                if documents.len() >= MAX_SOURCE_DOCUMENTS {
                    return Err("The import source contains too many referenced documents.".into());
                }
                let path = target
                    .to_file_path()
                    .map_err(|_| "An OpenAPI file reference cannot be represented safely.")?;
                let path = fs::canonicalize(&path).map_err(|_| {
                    format!(
                        "Referenced OpenAPI file '{}' does not exist.",
                        path.display()
                    )
                })?;
                if !path.is_file() {
                    return Err(format!(
                        "Referenced OpenAPI source '{}' is not a file.",
                        path.display()
                    ));
                }
                let bytes = fs::read(&path).map_err(|_| {
                    format!(
                        "Referenced OpenAPI file '{}' could not be read.",
                        path.display()
                    )
                })?;
                *total = total.saturating_add(bytes.len());
                if *total > MAX_SOURCE_BYTES {
                    return Err("The import source exceeds the 64 MiB safety limit.".into());
                }
                let text = String::from_utf8(bytes).map_err(|_| {
                    format!(
                        "Referenced OpenAPI file '{}' is not UTF-8 text.",
                        path.display()
                    )
                })?;
                let value = parse_document(&text).map_err(|_| {
                    format!(
                        "Referenced OpenAPI file '{}' is not valid JSON or YAML.",
                        path.display()
                    )
                })?;
                documents.insert(target_key.clone(), value);
            }
            pending.push(target_key);
        }
    }
    Ok(())
}
fn load_filesystem(source: ImportSource) -> Result<LoadedSource, String> {
    let selected = match &source {
        ImportSource::Path { path }
        | ImportSource::File { path }
        | ImportSource::Directory { path } => PathBuf::from(path),
        _ => return Err("Invalid filesystem import source.".into()),
    };
    let selected =
        fs::canonicalize(&selected).map_err(|_| "The selected import source does not exist.")?;
    let explicit_file = selected.is_file();
    if !explicit_file && !selected.is_dir() {
        return Err("The selected import source is neither a file nor a folder.".into());
    }
    let mut paths = Vec::new();
    if explicit_file {
        paths.push(selected.clone());
    } else {
        collect_files(&selected, &mut paths)?;
    }
    let mut total = 0usize;
    let mut documents = HashMap::new();
    let mut raw_by_key = HashMap::new();
    for path in paths {
        let bytes = fs::read(&path).map_err(|_| "An import source file could not be read.")?;
        total = total.saturating_add(bytes.len());
        if total > MAX_SOURCE_BYTES {
            return Err("The import source exceeds the 64 MiB safety limit.".into());
        }
        let text =
            String::from_utf8(bytes).map_err(|_| "Import source files must be UTF-8 text.")?;
        let value = match parse_document(&text) {
            Ok(value) => value,
            Err(_) if !explicit_file || path != selected => continue,
            Err(error) => return Err(error),
        };
        let key = Url::from_file_path(&path)
            .map_err(|_| "The import file path cannot be represented safely.")?
            .to_string();
        documents.insert(key.clone(), value);
        raw_by_key.insert(key, text);
    }
    let roots: Vec<String> = if explicit_file {
        vec![Url::from_file_path(&selected)
            .map_err(|_| "The import file path cannot be represented safely.")?
            .to_string()]
    } else {
        documents
            .iter()
            .filter(|(_, value)| {
                openapi_version(value).is_some_and(|version| version.starts_with("3."))
            })
            .map(|(key, _)| key.clone())
            .collect()
    };
    if roots.is_empty() {
        return Err("No supported OpenAPI 3.x document was found in the selected source.".into());
    }
    if roots.len() > 1 {
        return Err("The selected folder contains multiple OpenAPI root documents. Select one root file instead.".into());
    }
    let root = roots[0].clone();
    let raw = raw_by_key
        .remove(&root)
        .ok_or("The OpenAPI root document could not be read.")?;
    if documents
        .get(&root)
        .and_then(openapi_version)
        .is_some_and(|version| version.starts_with("3."))
    {
        load_local_references(&mut documents, &mut total, &root)?;
    }
    let name = selected
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("OpenAPI")
        .to_string();
    let source = match source {
        ImportSource::Path { .. } if explicit_file => ImportSource::File {
            path: selected.to_string_lossy().into_owned(),
        },
        ImportSource::Path { .. } => ImportSource::Directory {
            path: selected.to_string_lossy().into_owned(),
        },
        source => source,
    };
    Ok(LoadedSource {
        source,
        name,
        root,
        raw,
        documents,
    })
}

fn collect_refs(value: &Value, output: &mut Vec<String>) {
    match value {
        Value::Array(items) => items.iter().for_each(|item| collect_refs(item, output)),
        Value::Object(object) => {
            if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
                output.push(reference.to_string());
            }
            object.values().for_each(|item| collect_refs(item, output));
        }
        _ => {}
    }
}
async fn fetch_url(
    client: &reqwest::Client,
    url: &Url,
    remaining_bytes: usize,
) -> Result<String, String> {
    let mut response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|_| "The import URL could not be reached.")?;
    if !response.status().is_success() {
        return Err(format!(
            "The import URL returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > remaining_bytes as u64)
    {
        return Err("The import source exceeds the 64 MiB safety limit.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The import URL response could not be read.")?
    {
        if bytes.len().saturating_add(chunk.len()) > remaining_bytes {
            return Err("The import source exceeds the 64 MiB safety limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "The import URL must return UTF-8 JSON or YAML.".into())
}
async fn parse_owned(content: String) -> Result<(String, Value), String> {
    tokio::task::spawn_blocking(move || parse_document(&content).map(|value| (content, value)))
        .await
        .map_err(|_| "The import parser stopped unexpectedly.".to_string())?
}
async fn load_url(source: ImportSource) -> Result<LoadedSource, String> {
    let input = match &source {
        ImportSource::Url { url } => url,
        _ => return Err("Invalid URL import source.".into()),
    };
    let root_url = Url::parse(input).map_err(|_| "Enter a valid HTTP or HTTPS import URL.")?;
    if !matches!(root_url.scheme(), "http" | "https") {
        return Err("Import URLs must use HTTP or HTTPS.".into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|_| "Cannot initialize the import client.")?;
    let (raw, root_value) =
        parse_owned(fetch_url(&client, &root_url, MAX_SOURCE_BYTES).await?).await?;
    let mut total = raw.len();
    let mut documents = HashMap::from([(root_url.to_string(), root_value)]);
    let mut fetched = HashSet::from([root_url.to_string()]);
    loop {
        let mut pending = Vec::new();
        for (base, value) in &documents {
            let mut references = Vec::new();
            collect_refs(value, &mut references);
            let base = Url::parse(base).map_err(|_| "Invalid reference base URL.")?;
            for reference in references {
                let mut target = base
                    .join(&reference)
                    .map_err(|_| "An OpenAPI reference URL is invalid.")?;
                target.set_fragment(None);
                if !matches!(target.scheme(), "http" | "https") {
                    return Err(
                        "Remote OpenAPI documents may only reference HTTP or HTTPS resources."
                            .into(),
                    );
                }
                if fetched.insert(target.to_string()) {
                    pending.push(target);
                }
            }
        }
        if pending.is_empty() {
            break;
        }
        if fetched.len() > MAX_SOURCE_DOCUMENTS {
            return Err("The import source contains too many referenced documents.".into());
        }
        for target in pending {
            let remaining = MAX_SOURCE_BYTES.saturating_sub(total);
            let (text, document) =
                parse_owned(fetch_url(&client, &target, remaining).await?).await?;
            total = total.saturating_add(text.len());
            documents.insert(target.to_string(), document);
        }
    }
    Ok(LoadedSource {
        source,
        name: root_url
            .path_segments()
            .and_then(Iterator::last)
            .filter(|value| !value.is_empty())
            .unwrap_or("OpenAPI")
            .to_string(),
        root: root_url.to_string(),
        raw,
        documents,
    })
}
async fn load_source(source: ImportSource) -> Result<LoadedSource, String> {
    match source.clone() {
        ImportSource::Path { .. } | ImportSource::File { .. } | ImportSource::Directory { .. } => {
            tokio::task::spawn_blocking(move || load_filesystem(source))
                .await
                .map_err(|_| "The import worker stopped unexpectedly.".to_string())?
        }
        ImportSource::Url { .. } => load_url(source).await,
        ImportSource::Text { name, content } => tokio::task::spawn_blocking(move || {
            if content.len() > MAX_SOURCE_BYTES {
                return Err("The import source exceeds the 64 MiB safety limit.".into());
            }
            let root = format!("text:///{}", name.replace('/', "-"));
            let value = parse_document(&content)?;
            Ok(LoadedSource {
                source,
                name,
                root: root.clone(),
                raw: content,
                documents: HashMap::from([(root, value)]),
            })
        })
        .await
        .map_err(|_| "The import worker stopped unexpectedly.".to_string())?,
    }
}

fn resolve_reference(
    source: &LoadedSource,
    base: &str,
    reference: &str,
) -> Option<(String, Value)> {
    let base_url = Url::parse(base).ok()?;
    let target = base_url.join(reference).ok()?;
    let fragment = target.fragment().unwrap_or("").to_string();
    let mut document_url = target;
    document_url.set_fragment(None);
    let document = source.documents.get(document_url.as_str())?;
    let pointer = if fragment.is_empty() {
        None
    } else {
        Some(if fragment.starts_with('/') {
            fragment
        } else {
            format!("/{fragment}")
        })
    };
    let value = pointer
        .as_ref()
        .map_or(Some(document), |pointer| document.pointer(pointer))?;
    Some((document_url.to_string(), value.clone()))
}
fn resolved(source: &LoadedSource, base: &str, value: &Value) -> (String, Value) {
    let mut current_base = base.to_string();
    let mut current = value.clone();
    let mut visited = HashSet::new();
    for _ in 0..64 {
        let Some(reference) = current.get("$ref").and_then(Value::as_str) else {
            break;
        };
        if !visited.insert(format!("{current_base}:{reference}")) {
            break;
        }
        let Some((next_base, next)) = resolve_reference(source, &current_base, reference) else {
            break;
        };
        current_base = next_base;
        current = next;
    }
    (current_base, current)
}

fn validate_references(source: &LoadedSource) -> Result<(), String> {
    let mut pending = vec![source.root.clone()];
    let mut visited = HashSet::new();
    while let Some(base) = pending.pop() {
        if !visited.insert(base.clone()) {
            continue;
        }
        let document = source
            .documents
            .get(&base)
            .ok_or("A referenced OpenAPI document was not loaded.")?;
        let mut references = Vec::new();
        collect_refs(document, &mut references);
        for reference in references {
            let (target, _) = resolve_reference(source, &base, &reference).ok_or_else(|| {
                format!("OpenAPI reference '{reference}' from '{base}' could not be resolved.")
            })?;
            pending.push(target);
        }
    }
    Ok(())
}
fn scalar(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Null) | None => String::new(),
        Some(value) => serde_json::to_string(value).unwrap_or_default(),
    }
}
fn join_documentation(parts: impl IntoIterator<Item = Option<String>>) -> Option<String> {
    let value = parts.into_iter().flatten().collect::<Vec<_>>().join("\n\n");
    (!value.is_empty()).then_some(value)
}
fn schema_example(
    source: &LoadedSource,
    base: &str,
    schema: &Value,
    depth: usize,
    visited: &mut HashSet<String>,
) -> Value {
    if depth > 12 {
        return Value::Null;
    }
    if let Some(example) = schema.get("example") {
        return example.clone();
    }
    if let Some(default) = schema.get("default") {
        return default.clone();
    }
    if let Some(value) = schema
        .get("enum")
        .and_then(Value::as_array)
        .and_then(|values| values.first())
    {
        return value.clone();
    }
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        let marker = format!("{base}:{reference}");
        if !visited.insert(marker.clone()) {
            return Value::Null;
        }
        let result = resolve_reference(source, base, reference)
            .map(|(next_base, value)| {
                schema_example(source, &next_base, &value, depth + 1, visited)
            })
            .unwrap_or(Value::Null);
        visited.remove(&marker);
        return result;
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("object") | None if schema.get("properties").is_some() => Value::Object(
            schema
                .get("properties")
                .and_then(Value::as_object)
                .map(|properties| {
                    properties
                        .iter()
                        .map(|(name, child)| {
                            (
                                name.clone(),
                                schema_example(source, base, child, depth + 1, visited),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default(),
        ),
        Some("array") => Value::Array(vec![schema
            .get("items")
            .map(|items| schema_example(source, base, items, depth + 1, visited))
            .unwrap_or(Value::Null)]),
        Some("integer") => json!(0),
        Some("number") => json!(0.0),
        Some("boolean") => json!(false),
        _ => json!("string"),
    }
}
fn title_case(value: &str) -> String {
    value
        .split(|character: char| !character.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}
fn meaningful_folder(path: &str) -> String {
    let segments: Vec<&str> = path
        .split('/')
        .filter(|segment| !segment.is_empty() && !segment.starts_with('{'))
        .collect();
    let segment = segments
        .iter()
        .find(|segment| {
            let lower = segment.to_ascii_lowercase();
            lower != "api"
                && !(lower.starts_with('v')
                    && lower[1..]
                        .chars()
                        .all(|character| character.is_ascii_digit()))
        })
        .or_else(|| segments.first())
        .copied()
        .unwrap_or("General");
    title_case(segment)
}
fn path_template(path: &str) -> String {
    let mut output = String::new();
    let mut chars = path.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '{' {
            let mut name = String::new();
            while chars.peek().is_some_and(|next| *next != '}') {
                name.push(chars.next().unwrap_or_default());
            }
            if chars.next() == Some('}') && !name.is_empty() {
                output.push(':');
                output.push_str(&name);
            } else {
                output.push('{');
                output.push_str(&name);
            }
        } else {
            output.push(character);
        }
    }
    output
}
fn server_template(url: &str) -> String {
    url.replace('{', "{{").replace('}', "}}")
}
fn parameter(source: &LoadedSource, base: &str, value: &Value) -> Option<ImportParameter> {
    let (base, value) = resolved(source, base, value);
    let schema = value
        .get("schema")
        .map(|schema| resolved(source, &base, schema).1);
    Some(ImportParameter {
        name: value.get("name")?.as_str()?.to_string(),
        location: value.get("in")?.as_str()?.to_string(),
        required: value
            .get("required")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || value.get("in").and_then(Value::as_str) == Some("path"),
        value: scalar(
            value
                .get("example")
                .or_else(|| schema.as_ref().and_then(|schema| schema.get("default")))
                .or_else(|| schema.as_ref().and_then(|schema| schema.get("example"))),
        ),
    })
}
fn security_names(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|requirements| {
            requirements
                .iter()
                .filter_map(Value::as_object)
                .flat_map(|requirement| requirement.keys().cloned())
                .collect()
        })
        .unwrap_or_default()
}
fn warning(code: &'static str, message: String, source_path: Option<String>) -> ImportDiagnostic {
    ImportDiagnostic {
        severity: "warning",
        code,
        message,
        source_path,
    }
}
fn import_auth(
    name: &str,
    value: &Value,
    diagnostics: &mut Vec<ImportDiagnostic>,
) -> Option<ImportAuth> {
    let auth_type = value.get("type").and_then(Value::as_str)?;
    match auth_type {
        "http" => {
            match value
                .get("scheme")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str()
            {
                "bearer" => Some(ImportAuth {
                    name: name.into(),
                    config: json!({"type":"bearer","token":{"kind":"plain","value":""},"prefix":"Bearer"}),
                }),
                "basic" => Some(ImportAuth {
                    name: name.into(),
                    config: json!({"type":"basic","username":"","password":{"kind":"plain","value":""}}),
                }),
                scheme => {
                    diagnostics.push(warning("unsupported-auth", format!("HTTP authentication scheme '{scheme}' is not supported and was omitted."), Some(format!("#/components/securitySchemes/{name}"))));
                    None
                }
            }
        }
        "apiKey" => {
            let placement = value.get("in").and_then(Value::as_str).unwrap_or("header");
            if !matches!(placement, "header" | "query" | "cookie") {
                return None;
            }
            Some(ImportAuth {
                name: name.into(),
                config: json!({"type":"api-key","name":value.get("name").and_then(Value::as_str).unwrap_or("X-API-Key"),"placement":placement,"value":{"kind":"plain","value":""}}),
            })
        }
        "oauth2" => {
            let flows = value.get("flows").and_then(Value::as_object)?;
            let (grant_type, flow) = if let Some(flow) = flows.get("authorizationCode") {
                ("authorization_code", flow)
            } else if let Some(flow) = flows.get("clientCredentials") {
                ("client_credentials", flow)
            } else {
                diagnostics.push(warning("unsupported-auth", format!("OAuth scheme '{name}' has no supported authorizationCode or clientCredentials flow."), Some(format!("#/components/securitySchemes/{name}"))));
                return None;
            };
            let scopes = flow
                .get("scopes")
                .and_then(Value::as_object)
                .map(|values| values.keys().cloned().collect::<Vec<_>>().join(" "))
                .unwrap_or_default();
            let mut config = json!({"type":"oauth2","grantType":grant_type,"tokenUrl":server_template(flow.get("tokenUrl").and_then(Value::as_str).unwrap_or("")),"clientId":"","clientSecret":{"kind":"plain","value":""},"scopes":scopes,"redirectUri":"http://127.0.0.1:8976/oauth/callback","clientAuthentication":"body","autoRefresh":true});
            if let Some(url) = flow.get("authorizationUrl").and_then(Value::as_str) {
                config
                    .as_object_mut()
                    .unwrap()
                    .insert("authorizationUrl".into(), json!(server_template(url)));
            }
            Some(ImportAuth {
                name: name.into(),
                config,
            })
        }
        "openIdConnect" => {
            diagnostics.push(warning("unsupported-auth", format!("OpenID Connect discovery for '{name}' is not available yet; imported as a bearer token."), Some(format!("#/components/securitySchemes/{name}"))));
            Some(ImportAuth {
                name: name.into(),
                config: json!({"type":"bearer","token":{"kind":"plain","value":""},"prefix":"Bearer"}),
            })
        }
        "mutualTLS" => {
            diagnostics.push(warning(
                "unsupported-auth",
                format!(
                    "Mutual TLS scheme '{name}' is not supported by the current request transport."
                ),
                Some(format!("#/components/securitySchemes/{name}")),
            ));
            None
        }
        other => {
            diagnostics.push(warning(
                "unsupported-auth",
                format!("Authentication scheme type '{other}' is not supported."),
                Some(format!("#/components/securitySchemes/{name}")),
            ));
            None
        }
    }
}

impl ImportAdapter for OpenApi3Adapter {
    fn can_import(&self, source: &LoadedSource) -> bool {
        source
            .documents
            .get(&source.root)
            .and_then(openapi_version)
            .is_some_and(|version| version.starts_with("3."))
    }
    fn normalize(&self, source: &LoadedSource) -> Result<ImportModel, String> {
        let root = source
            .documents
            .get(&source.root)
            .ok_or("The OpenAPI root document is missing.")?;
        let version =
            openapi_version(root).ok_or("The source does not contain OpenAPI metadata.")?;
        if !version.starts_with("3.") {
            return Err(format!(
                "OpenAPI version {version} is not supported. Select an OpenAPI 3.x document."
            ));
        }
        let title = root
            .pointer("/info/title")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&source.name)
            .to_string();
        let description = root
            .pointer("/info/description")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string);
        let mut diagnostics = Vec::new();
        let mut variables = Vec::new();
        let servers = root
            .get("servers")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut environments = Vec::new();
        if servers.len() <= 1 {
            let server = servers.first();
            variables.push(ImportVariable {
                id: String::new(),
                name: "baseUrl".into(),
                value: server
                    .and_then(|value| value.get("url"))
                    .and_then(Value::as_str)
                    .map(server_template)
                    .unwrap_or_default(),
                sensitive: false,
            });
            if let Some(server_variables) = server
                .and_then(|value| value.get("variables"))
                .and_then(Value::as_object)
            {
                for (name, value) in server_variables {
                    if name != "baseUrl" {
                        variables.push(ImportVariable {
                            id: String::new(),
                            name: name.clone(),
                            value: scalar(value.get("default")),
                            sensitive: false,
                        });
                    }
                }
            }
        } else {
            for (index, server) in servers.iter().enumerate() {
                let url = server.get("url").and_then(Value::as_str).unwrap_or("");
                let description = server
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let base_name = description
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| {
                        Url::parse(url)
                            .ok()
                            .and_then(|value| value.host_str().map(title_case))
                            .unwrap_or_else(|| format!("Server {}", index + 1))
                    });
                let mut name = base_name.clone();
                let mut suffix = 2;
                while environments
                    .iter()
                    .any(|environment: &ImportEnvironment| environment.name == name)
                {
                    name = format!("{base_name} {suffix}");
                    suffix += 1;
                }
                let mut server_variables = vec![ImportVariable {
                    id: String::new(),
                    name: "baseUrl".into(),
                    value: server_template(url),
                    sensitive: false,
                }];
                if let Some(values) = server.get("variables").and_then(Value::as_object) {
                    for (variable_name, value) in values {
                        if variable_name != "baseUrl" {
                            server_variables.push(ImportVariable {
                                id: String::new(),
                                name: variable_name.clone(),
                                value: scalar(value.get("default")),
                                sensitive: false,
                            });
                        }
                    }
                }
                environments.push(ImportEnvironment {
                    id: String::new(),
                    name,
                    description,
                    variables: server_variables,
                });
            }
        }
        let global_security = security_names(root.get("security"));
        if global_security.len() > 1 {
            diagnostics.push(warning("unsupported-auth", "Alternative or combined OpenAPI security requirements use the first supported scheme because Purr currently applies one auth profile per request.".into(), Some("#/security".into())));
        }
        let mut auth = HashMap::new();
        if let Some(schemes) = root
            .pointer("/components/securitySchemes")
            .and_then(Value::as_object)
        {
            for (name, value) in schemes {
                let (_, value) = resolved(source, &source.root, value);
                if let Some(model) = import_auth(name, &value, &mut diagnostics) {
                    auth.insert(name.clone(), model);
                }
            }
        }
        let mut operations = Vec::new();
        let methods = [
            "get", "put", "post", "delete", "options", "head", "patch", "trace",
        ];
        if let Some(paths) = root.get("paths").and_then(Value::as_object) {
            for (path, path_item) in paths {
                let (path_base, path_item) = resolved(source, &source.root, path_item);
                let shared_parameters = path_item
                    .get("parameters")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                for method in methods {
                    let Some(operation) = path_item.get(method).and_then(Value::as_object) else {
                        continue;
                    };
                    let operation_id = operation
                        .get("operationId")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let name = operation
                        .get("summary")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .map(str::to_string)
                        .or_else(|| operation_id.clone())
                        .unwrap_or_else(|| format!("{} {path}", method.to_uppercase()));
                    let folder = operation
                        .get("tags")
                        .and_then(Value::as_array)
                        .and_then(|tags| tags.first())
                        .and_then(Value::as_str)
                        .filter(|tag| !tag.trim().is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| meaningful_folder(path));
                    let mut merged: BTreeMap<(String, String), ImportParameter> = BTreeMap::new();
                    for candidate in shared_parameters.iter().chain(
                        operation
                            .get("parameters")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten(),
                    ) {
                        if let Some(parameter) = parameter(source, &path_base, candidate) {
                            merged.insert(
                                (parameter.location.clone(), parameter.name.clone()),
                                parameter,
                            );
                        }
                    }
                    let request_body = operation
                        .get("requestBody")
                        .map(|value| resolved(source, &path_base, value));
                    let mut body_content_types = request_body
                        .as_ref()
                        .and_then(|(_, body)| body.get("content"))
                        .and_then(Value::as_object)
                        .map(|content| content.keys().cloned().collect::<Vec<_>>())
                        .unwrap_or_default();
                    body_content_types.sort();
                    let body = request_body.and_then(|(body_base, body)| {
                        let body_description = body
                            .get("description")
                            .and_then(Value::as_str)
                            .filter(|value| !value.trim().is_empty())
                            .map(str::to_string);
                        let content = body.get("content")?.as_object()?;
                        let preferred = [
                            "application/json",
                            "application/*+json",
                            "application/xml",
                            "text/xml",
                            "application/x-www-form-urlencoded",
                            "multipart/form-data",
                            "text/plain",
                            "application/octet-stream",
                        ];
                        let (media_type, media) = preferred
                            .iter()
                            .find_map(|candidate| {
                                content
                                    .get(*candidate)
                                    .map(|value| ((*candidate).to_string(), value))
                            })
                            .or_else(|| {
                                content
                                    .iter()
                                    .next()
                                    .map(|(name, value)| (name.clone(), value))
                            })?;
                        let schema = media
                            .get("schema")
                            .map(|value| resolved(source, &body_base, value).1)
                            .unwrap_or(Value::Null);
                        let schema_description = schema
                            .get("description")
                            .and_then(Value::as_str)
                            .filter(|value| !value.trim().is_empty())
                            .map(str::to_string);
                        let value = media.get("example").cloned().unwrap_or_else(|| {
                            schema_example(source, &body_base, &schema, 0, &mut HashSet::new())
                        });
                        let required = schema
                            .get("required")
                            .and_then(Value::as_array)
                            .map(|items| {
                                items
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .map(str::to_string)
                                    .collect()
                            })
                            .unwrap_or_default();
                        Some(ImportBody {
                            media_type,
                            value,
                            required,
                            description: join_documentation([body_description, schema_description]),
                        })
                    });
                    let responses = operation
                        .get("responses")
                        .and_then(Value::as_object)
                        .map(|responses| {
                            responses
                                .iter()
                                .map(|(status, response)| {
                                    let (_, response) = resolved(source, &path_base, response);
                                    ImportResponse {
                                        status: status.clone(),
                                        description: response
                                            .get("description")
                                            .and_then(Value::as_str)
                                            .filter(|value| !value.trim().is_empty())
                                            .map(str::to_string),
                                    }
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let security = operation
                        .get("security")
                        .map(|value| security_names(Some(value)));
                    if security.as_ref().is_some_and(|names| names.len() > 1) {
                        diagnostics.push(warning(
                            "unsupported-auth",
                            "Alternative or combined operation security requirements use the first supported scheme because Purr currently applies one auth profile per request.".into(),
                            Some(format!(
                                "#/paths/{}/{}/security",
                                path.replace('~', "~0").replace('/', "~1"),
                                method
                            )),
                        ));
                    }
                    let external_docs = operation
                        .get("externalDocs")
                        .and_then(Value::as_object)
                        .and_then(|docs| {
                            let url = docs.get("url").and_then(Value::as_str)?;
                            let label = docs
                                .get("description")
                                .and_then(Value::as_str)
                                .filter(|value| !value.trim().is_empty())
                                .unwrap_or("External documentation");
                            Some(format!("[{label}]({url})"))
                        });
                    operations.push(ImportOperation {
                        pointer: format!(
                            "#/paths/{}/{}",
                            path.replace('~', "~0").replace('/', "~1"),
                            method
                        ),
                        operation_id,
                        name,
                        description: join_documentation([
                            operation
                                .get("description")
                                .and_then(Value::as_str)
                                .filter(|value| !value.trim().is_empty())
                                .map(str::to_string),
                            external_docs,
                        ]),
                        method: method.to_uppercase(),
                        path: path_template(path),
                        folder,
                        parameters: merged.into_values().collect(),
                        body,
                        body_content_types,
                        responses,
                        security,
                    });
                }
            }
        }
        if operations.is_empty() {
            return Err("The OpenAPI document does not contain importable HTTP operations.".into());
        }
        let (source_kind, source_location) = source.source.metadata();
        Ok(ImportModel {
            title,
            description,
            source_kind: source_kind.into(),
            source_location,
            source_document: source.raw.clone(),
            variables,
            environments,
            operations,
            auth,
            global_security,
            diagnostics,
        })
    }
}

fn stable_id(prefix: &str, workspace_id: &str, key: &str) -> String {
    let digest = Sha256::digest(format!("{workspace_id}:{key}").as_bytes());
    format!(
        "{prefix}-{}",
        digest[..12]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}
fn variable_definition(
    variable: &ImportVariable,
    workspace_id: &str,
    scope: &str,
    secrets: &mut Vec<Value>,
) -> Value {
    let id = if variable.id.is_empty() {
        stable_id("var", workspace_id, &format!("{scope}:{}", variable.name))
    } else {
        stable_id("var", workspace_id, &variable.id)
    };
    if variable.sensitive {
        let reference = format!("purr/{workspace_id}/imports/openapi/{id}");
        secrets.push(json!({"ref":reference,"value":variable.value}));
        json!({"id":id,"name":variable.name,"enabled":true,"sensitive":true,"kind":"static","secretRef":reference})
    } else {
        json!({"id":id,"name":variable.name,"enabled":true,"sensitive":false,"kind":"static","value":variable.value})
    }
}
fn body_definition(body: &Option<ImportBody>) -> (Value, Option<String>) {
    let Some(body) = body else {
        return (json!({"type":"none"}), None);
    };
    let example_documentation = if body.value.is_null() {
        None
    } else {
        serde_json::to_string_pretty(&body.value).ok().map(|value| {
            let language = if body.media_type.contains("json") {
                "json"
            } else if body.media_type.contains("xml") {
                "xml"
            } else {
                "text"
            };
            format!(
                "Expected request body ({})\n\n```{language}\n{value}\n```",
                body.media_type
            )
        })
    };
    let documentation = join_documentation([body.description.clone(), example_documentation]);
    let definition = if body.media_type.contains("json") {
        json!({"type":"json","data":serde_json::to_string_pretty(&body.value).unwrap_or_default()})
    } else if body.media_type.contains("xml") {
        json!({"type":"xml","data":scalar(Some(&body.value))})
    } else if body.media_type == "application/x-www-form-urlencoded"
        || body.media_type == "multipart/form-data"
    {
        let fields = body.value.as_object().map(|values| values.iter().map(|(name, value)| json!({"name":name,"value":scalar(Some(value)),"enabled":body.required.contains(name)})).collect::<Vec<_>>()).unwrap_or_default();
        json!({"type":if body.media_type == "multipart/form-data" { "form-data" } else { "url-encoded" },"fields":fields})
    } else if body.media_type == "application/octet-stream" {
        json!({"type":"binary","file":Value::Null})
    } else {
        json!({"type":"text","data":scalar(Some(&body.value))})
    };
    (definition, documentation)
}
fn markdown_code(value: &str) -> String {
    format!("`{}`", value.replace('`', "\\`"))
}
fn request_documentation(operation: &ImportOperation, body_docs: Option<String>) -> String {
    let mut sections = vec![format!("# {}", operation.name)];
    if let Some(description) = &operation.description {
        sections.push(description.clone());
    }
    if let Some(operation_id) = &operation.operation_id {
        sections.push(format!("**Operation ID:** {}", markdown_code(operation_id)));
    }
    if !operation.parameters.is_empty() {
        let rows = operation
            .parameters
            .iter()
            .map(|parameter| {
                format!(
                    "- {} — {}{}",
                    markdown_code(&parameter.name),
                    parameter.location,
                    if parameter.required { ", required" } else { "" }
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        sections.push(format!("## Parameters\n\n{rows}"));
    }
    if let Some(body) = &operation.body {
        let available = operation
            .body_content_types
            .iter()
            .map(|content_type| markdown_code(content_type))
            .collect::<Vec<_>>()
            .join(", ");
        let mut details = vec![format!(
            "**Selected content type:** {}",
            markdown_code(&body.media_type)
        )];
        if !available.is_empty() {
            details.push(format!("**Available content types:** {available}"));
        }
        if let Some(body_docs) = body_docs {
            details.push(body_docs);
        }
        sections.push(format!("## Request body\n\n{}", details.join("\n\n")));
    }
    if !operation.responses.is_empty() {
        let rows = operation
            .responses
            .iter()
            .map(|response| match &response.description {
                Some(description) => {
                    format!("- {} — {}", markdown_code(&response.status), description)
                }
                None => format!("- {}", markdown_code(&response.status)),
            })
            .collect::<Vec<_>>()
            .join("\n");
        sections.push(format!("## Responses\n\n{rows}"));
    }
    sections.join("\n\n")
}
fn imported_secret(
    workspace_id: &str,
    profile_id: &str,
    field: &str,
    secrets: &mut Vec<Value>,
) -> Value {
    let reference = format!("purr/{workspace_id}/auth/{profile_id}/{field}");
    secrets.push(json!({"ref":reference,"value":""}));
    json!({"kind":"secret","ref":reference})
}
fn auth_definition(
    auth: &ImportAuth,
    workspace_id: &str,
    profile_id: &str,
    secrets: &mut Vec<Value>,
) -> Value {
    let mut config = auth.config.clone();
    match config.get("type").and_then(Value::as_str) {
        Some("bearer") => {
            config["token"] = imported_secret(workspace_id, profile_id, "bearer", secrets)
        }
        Some("basic") => {
            config["password"] = imported_secret(workspace_id, profile_id, "password", secrets)
        }
        Some("api-key") => {
            config["value"] = imported_secret(workspace_id, profile_id, "api-key", secrets)
        }
        Some("oauth2") => {
            config["clientSecret"] =
                imported_secret(workspace_id, profile_id, "client-secret", secrets)
        }
        _ => {}
    }
    config
}
fn build_project(mut model: ImportModel, workspace_id: &str) -> NormalizedImportResult {
    let schema_id = stable_id("api-schema", workspace_id, "openapi-root");
    let mut resources = Vec::new();
    let mut secrets = Vec::new();
    let mut workspace_variables = Vec::new();
    for variable in &model.variables {
        workspace_variables.push(variable_definition(
            variable,
            workspace_id,
            "workspace",
            &mut secrets,
        ));
    }
    let mut seen_names = HashSet::new();
    workspace_variables.retain(|value| {
        value
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| seen_names.insert(name.to_string()))
    });
    let mut folder_ids = HashMap::new();
    for operation in &model.operations {
        let key = operation.folder.to_ascii_lowercase();
        folder_ids.entry(key.clone()).or_insert_with(|| {
            (
                operation.folder.clone(),
                stable_id("folder", workspace_id, &format!("folder:{key}")),
            )
        });
    }
    let mut folders: Vec<_> = folder_ids.values().collect();
    folders.sort_by(|left, right| left.0.cmp(&right.0));
    for (name, id) in folders {
        resources.push(json!({"id":id,"name":name,"kind":"folder"}));
    }
    let mut auth_names = model.auth.keys().cloned().collect::<Vec<_>>();
    auth_names.sort();
    let mut auth_profile_ids = HashMap::new();
    let workspace_auth = auth_names
        .iter()
        .map(|name| {
            let auth = &model.auth[name];
            let id = stable_id("auth", workspace_id, name);
            auth_profile_ids.insert(name.clone(), id.clone());
            let config = auth_definition(auth, workspace_id, &id, &mut secrets);
            json!({"id":id,"name":auth.name,"scope":"all","enabled":true,"config":config})
        })
        .collect::<Vec<_>>();
    for operation in &model.operations {
        let security = operation
            .security
            .as_ref()
            .unwrap_or(&model.global_security);
        let explicitly_public = operation.security.as_ref().is_some_and(Vec::is_empty);
        let selected_auth = if explicitly_public {
            None
        } else {
            security
                .iter()
                .find(|name| auth_profile_ids.contains_key(*name))
        };
        let auth = selected_auth
            .and_then(|name| auth_profile_ids.get(name))
            .map(|profile_id| json!({"type":"inherit","profileId":profile_id}))
            .unwrap_or_else(|| json!({"type":"none"}));
        let parameters = |location: &str| {
            operation.parameters.iter().filter(|parameter| parameter.location == location).map(|parameter| json!({"name":parameter.name,"value":parameter.value,"enabled":parameter.required})).collect::<Vec<_>>()
        };
        let (body, body_docs) = body_definition(&operation.body);
        let documentation = request_documentation(operation, body_docs);
        let mut origin =
            json!({"type":"openapi","schemaId":schema_id,"operationPath":operation.pointer});
        if let Some(operation_id) = &operation.operation_id {
            origin
                .as_object_mut()
                .unwrap()
                .insert("operationId".into(), json!(operation_id));
        }
        let folder_id = &folder_ids[&operation.folder.to_ascii_lowercase()].1;
        let mut request = json!({"id":stable_id("request", workspace_id, &operation.pointer),"name":operation.name,"kind":"http","folderId":folder_id,"method":operation.method,"url":format!("{{{{baseUrl}}}}{}", operation.path),"params":parameters("query"),"pathParams":parameters("path"),"headers":parameters("header"),"body":body,"auth":auth,"origin":origin});
        request
            .as_object_mut()
            .unwrap()
            .insert("documentation".into(), json!(documentation));
        if !workspace_auth.is_empty() && selected_auth.is_none() {
            request.as_object_mut().unwrap().insert(
                "overrides".into(),
                json!({"headers":true,"auth":false,"excludedHeaderIds":[],"cookies":true}),
            );
        }
        resources.push(request);
    }
    let mut active_environment_id = None;
    for (index, environment) in model.environments.iter_mut().enumerate() {
        environment.id = stable_id(
            "environment",
            workspace_id,
            &format!("server:{index}:{}", environment.name),
        );
        if active_environment_id.is_none() {
            active_environment_id = Some(environment.id.clone());
        }
        let variables = environment
            .variables
            .iter()
            .map(|variable| {
                variable_definition(variable, workspace_id, &environment.id, &mut secrets)
            })
            .collect::<Vec<_>>();
        let mut definition = json!({"id":environment.id,"name":environment.name,"kind":"environment","variables":variables});
        if let Some(description) = &environment.description {
            definition
                .as_object_mut()
                .unwrap()
                .insert("description".into(), json!(description));
        }
        resources.push(definition);
    }
    resources.push(json!({"id":schema_id,"name":format!("{} OpenAPI", model.title),"kind":"api-schema","format":"openapi-3","source":{"type":model.source_kind,"location":model.source_location},"document":model.source_document}));
    let mut workspace = json!({"id":workspace_id,"name":model.title,"variables":workspace_variables,"headers":[],"auth":workspace_auth});
    if let Some(description) = model.description {
        workspace
            .as_object_mut()
            .unwrap()
            .insert("description".into(), json!(description));
    }
    NormalizedImportResult {
        workspace,
        resources,
        diagnostics: std::mem::take(&mut model.diagnostics),
        secrets,
        active_environment_id,
    }
}

pub async fn import(
    source: ImportSource,
    workspace_id: String,
) -> Result<NormalizedImportResult, String> {
    if workspace_id.is_empty()
        || workspace_id.len() > 128
        || !workspace_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    {
        return Err("Invalid destination workspace identifier.".into());
    }
    let loaded = load_source(source).await?;
    let adapters: Vec<Box<dyn ImportAdapter + Send>> = vec![Box::new(OpenApi3Adapter)];
    let matches: Vec<_> = adapters
        .into_iter()
        .filter(|adapter| adapter.can_import(&loaded))
        .collect();
    if matches.is_empty() {
        return Err(
            "This file format is not supported. Purr currently imports OpenAPI 3.x documents."
                .into(),
        );
    }
    if matches.len() > 1 {
        return Err("The import source matches more than one format.".into());
    }
    validate_references(&loaded)?;
    let model =
        tokio::task::spawn_blocking(move || matches.into_iter().next().unwrap().normalize(&loaded))
            .await
            .map_err(|_| "The import worker stopped unexpectedly.".to_string())??;
    Ok(build_project(model, &workspace_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn normalize(source: &str) -> NormalizedImportResult {
        let root = "text:///openapi.yaml".to_string();
        let loaded = LoadedSource {
            source: ImportSource::Text {
                name: "openapi.yaml".into(),
                content: source.into(),
            },
            name: "openapi.yaml".into(),
            root: root.clone(),
            raw: source.into(),
            documents: HashMap::from([(root, parse_document(source).unwrap())]),
        };
        build_project(OpenApi3Adapter.normalize(&loaded).unwrap(), "import-test")
    }
    #[test]
    fn openapi_normalizes_tags_parameters_body_servers_auth_and_origin() {
        let result = normalize(
            r#"
openapi: 3.1.0
info: { title: Example API, version: 1.0.0 }
servers: [{ url: https://api.example.com/v1 }]
components:
  schemas:
    CreateUser:
      type: object
      description: A new user record.
      required: [name]
      properties:
        name: { type: string }
        age: { type: integer, default: 20 }
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer }
security: [{ bearerAuth: [] }]
paths:
  /users/{userId}:
    get:
      tags: [Users, Read]
      summary: Get user profile
      description: Returns the profile visible to the current caller.
      operationId: getUserById
      externalDocs: { description: User guide, url: https://docs.example.com/users }
      parameters:
        - { name: userId, in: path, required: true, schema: { type: string } }
        - { name: limit, in: query, schema: { type: integer, default: 20 } }
      responses: { '200': { description: User profile } }
    post:
      operationId: createUser
      requestBody:
        description: Fields accepted when creating a user.
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CreateUser' }
      responses: { '200': { description: ok } }
"#,
        );
        assert_eq!(result.workspace["name"], "Example API");
        assert!(result.workspace["variables"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value["name"] == "baseUrl"
                && value["value"] == "https://api.example.com/v1"));
        let profile = &result.workspace["auth"][0];
        assert_eq!(profile["name"], "bearerAuth");
        assert_eq!(profile["config"]["type"], "bearer");
        assert_eq!(profile["config"]["token"]["kind"], "secret");
        assert!(result.secrets.iter().any(|secret| {
            secret["ref"] == profile["config"]["token"]["ref"] && secret["value"] == ""
        }));
        let request = result
            .resources
            .iter()
            .find(|value| value["origin"]["operationId"] == "getUserById")
            .unwrap();
        assert_eq!(request["name"], "Get user profile");
        assert_eq!(request["url"], "{{baseUrl}}/users/:userId");
        assert_eq!(request["pathParams"][0]["enabled"], true);
        assert_eq!(request["params"][0]["enabled"], false);
        assert_eq!(request["params"][0]["value"], "20");
        assert_eq!(request["auth"]["type"], "inherit");
        assert_eq!(request["auth"]["profileId"], profile["id"]);
        assert!(request["documentation"]
            .as_str()
            .unwrap()
            .contains("Returns the profile visible"));
        assert!(request["documentation"]
            .as_str()
            .unwrap()
            .contains("[User guide](https://docs.example.com/users)"));
        assert!(request["documentation"]
            .as_str()
            .unwrap()
            .contains("# Get user profile"));
        assert!(request["documentation"]
            .as_str()
            .unwrap()
            .contains("**Operation ID:** `getUserById`"));
        assert!(request["documentation"]
            .as_str()
            .unwrap()
            .contains("`userId` — path, required"));
        assert!(request["documentation"]
            .as_str()
            .unwrap()
            .contains("`200` — User profile"));
        let post = result
            .resources
            .iter()
            .find(|value| value["origin"]["operationId"] == "createUser")
            .unwrap();
        assert!(post["body"]["data"]
            .as_str()
            .unwrap()
            .contains("\"age\": 20"));
        assert!(post["documentation"]
            .as_str()
            .unwrap()
            .contains("Fields accepted when creating a user."));
        assert!(post["documentation"]
            .as_str()
            .unwrap()
            .contains("A new user record."));
        assert!(post["documentation"]
            .as_str()
            .unwrap()
            .contains("**Selected content type:** `application/json`"));
        assert!(result
            .resources
            .iter()
            .any(|value| value["kind"] == "api-schema"));
    }
    #[test]
    fn every_supported_security_scheme_becomes_a_selectable_shared_profile() {
        let result = normalize(
            r#"
openapi: 3.0.3
info: { title: Multiple auth, version: 1 }
components:
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer }
    partnerKey: { type: apiKey, in: header, name: X-Partner-Key }
security: [{ bearerAuth: [] }]
paths:
  /users:
    get: { responses: { '200': { description: ok } } }
  /partners:
    get:
      security: [{ partnerKey: [] }]
      responses: { '200': { description: ok } }
  /health:
    get:
      security: []
      responses: { '200': { description: ok } }
"#,
        );
        let profiles = result.workspace["auth"].as_array().unwrap();
        assert_eq!(profiles.len(), 2);
        let profile_id = |name: &str| {
            profiles
                .iter()
                .find(|profile| profile["name"] == name)
                .unwrap()["id"]
                .clone()
        };
        let request = |path: &str| {
            result
                .resources
                .iter()
                .find(|resource| {
                    resource["origin"]["operationPath"]
                        .as_str()
                        .is_some_and(|pointer| pointer.contains(path))
                })
                .unwrap()
        };
        assert_eq!(
            request("~1users")["auth"]["profileId"],
            profile_id("bearerAuth")
        );
        assert_eq!(
            request("~1partners")["auth"]["profileId"],
            profile_id("partnerKey")
        );
        assert_eq!(request("~1health")["auth"]["type"], "none");
        assert_eq!(request("~1health")["overrides"]["auth"], false);
        assert!(request("~1health")["documentation"]
            .as_str()
            .unwrap()
            .contains("# GET /health"));
        assert!(request("~1health")["documentation"]
            .as_str()
            .unwrap()
            .contains("## Responses\n\n- `200` — ok"));
    }
    #[test]
    fn oauth_import_keeps_endpoint_templates_and_uses_a_direct_secret_reference() {
        let result = normalize(
            r#"
openapi: 3.0.3
info: { title: OAuth API, version: 1 }
components:
  securitySchemes:
    oauth:
      type: oauth2
      flows:
        authorizationCode:
          authorizationUrl: https://{authHost}/{tenant}/authorize
          tokenUrl: https://{authHost}/{tenant}/token
          scopes: { read: Read data }
security: [{ oauth: [] }]
paths:
  /me:
    get: { responses: { '200': { description: ok } } }
"#,
        );
        let profile = &result.workspace["auth"][0];
        assert_eq!(
            profile["config"]["authorizationUrl"],
            "https://{{authHost}}/{{tenant}}/authorize"
        );
        assert_eq!(
            profile["config"]["tokenUrl"],
            "https://{{authHost}}/{{tenant}}/token"
        );
        assert_eq!(profile["config"]["clientSecret"]["kind"], "secret");
        assert!(result.workspace["variables"]
            .as_array()
            .unwrap()
            .iter()
            .all(|variable| variable["name"] != "clientSecret"));
    }
    #[test]
    fn first_tag_wins_and_path_fallback_stays_shallow() {
        let result = normalize(
            r#"
openapi: 3.0.3
info: { title: Paths, version: 1 }
paths:
  /api/orders/{id}/items:
    get: { responses: { '200': { description: ok } } }
  /users/{id}:
    get: { tags: [People, Secondary], responses: { '200': { description: ok } } }
"#,
        );
        let folders = result
            .resources
            .iter()
            .filter(|value| value["kind"] == "folder")
            .map(|value| value["name"].as_str().unwrap())
            .collect::<HashSet<_>>();
        assert_eq!(folders, HashSet::from(["Orders", "People"]));
    }
    #[test]
    fn multiple_servers_become_selectable_environments_with_template_defaults() {
        let result = normalize(
            r#"
openapi: 3.1.0
info: { title: Environments, version: 1 }
servers:
  - url: https://api.example.com
    description: Production
  - url: https://{environment}.example.com/{version}
    description: Staging
    variables:
      environment: { default: staging }
      version: { default: v2 }
paths:
  /users:
    get: { responses: { '200': { description: ok } } }
"#,
        );
        assert_eq!(
            result.active_environment_id.as_deref(),
            result
                .resources
                .iter()
                .find(|value| value["kind"] == "environment")
                .and_then(|value| value["id"].as_str())
        );
        let environments = result
            .resources
            .iter()
            .filter(|value| value["kind"] == "environment")
            .collect::<Vec<_>>();
        assert_eq!(environments.len(), 2);
        assert_eq!(environments[0]["name"], "Production");
        assert!(environments
            .iter()
            .any(
                |environment| environment["variables"]
                    .as_array()
                    .is_some_and(|variables| variables.iter().any(|variable| variable["name"]
                        == "baseUrl"
                        && variable["value"] == "https://{{environment}}.example.com/{{version}}")
                        && variables
                            .iter()
                            .any(|variable| variable["name"] == "environment"
                                && variable["value"] == "staging")
                        && variables
                            .iter()
                            .any(|variable| variable["name"] == "version"
                                && variable["value"] == "v2"))
            ));
    }
    #[test]
    fn filesystem_import_resolves_relative_reference_documents() {
        let directory = tempfile::tempdir().unwrap();
        let spec_directory = directory.path().join("spec");
        fs::create_dir(&spec_directory).unwrap();
        fs::write(
            directory.path().join("components.yaml"),
            "CreateUser:\n  type: object\n  properties:\n    email: { type: string }\n",
        )
        .unwrap();
        let root = spec_directory.join("openapi.yaml");
        fs::write(
            &root,
            r#"
openapi: 3.0.3
info: { title: External refs, version: 1 }
paths:
  /users:
    post:
      requestBody:
        content:
          application/json:
            schema: { $ref: '../components.yaml#/CreateUser' }
      responses: { '200': { description: ok } }
"#,
        )
        .unwrap();
        let loaded_file = load_filesystem(ImportSource::Path {
            path: root.to_string_lossy().into_owned(),
        })
        .unwrap();
        assert!(matches!(loaded_file.source, ImportSource::File { .. }));
        let loaded = load_filesystem(ImportSource::Path {
            path: directory.path().to_string_lossy().into_owned(),
        })
        .unwrap();
        assert!(matches!(loaded.source, ImportSource::Directory { .. }));
        validate_references(&loaded).unwrap();
        let result = build_project(
            OpenApi3Adapter.normalize(&loaded).unwrap(),
            "external-ref-test",
        );
        let request = result
            .resources
            .iter()
            .find(|value| value["kind"] == "http")
            .unwrap();
        assert!(request["body"]["data"]
            .as_str()
            .unwrap()
            .contains("\"email\": \"string\""));
    }
    #[test]
    fn unresolved_references_fail_instead_of_importing_partial_requests() {
        let root = "text:///openapi.yaml".to_string();
        let source = r#"
openapi: 3.0.3
info: { title: Broken refs, version: 1 }
paths:
  /users:
    post:
      requestBody:
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Missing' }
      responses: { '200': { description: ok } }
"#;
        let loaded = LoadedSource {
            source: ImportSource::Text {
                name: "openapi.yaml".into(),
                content: source.into(),
            },
            name: "openapi.yaml".into(),
            root: root.clone(),
            raw: source.into(),
            documents: HashMap::from([(root, parse_document(source).unwrap())]),
        };
        assert!(validate_references(&loaded)
            .unwrap_err()
            .contains("could not be resolved"));
    }
}
