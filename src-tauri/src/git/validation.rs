//! Shape comes from the generated domain schema. Relational checks deliberately
//! mirror validateProject; credential ownership remains in the transfer boundary.
use crate::persistence::project_files::ProjectFile;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::OnceLock,
};

type Result<T> = std::result::Result<T, String>;
fn invalid() -> String {
    "Invalid canonical project".into()
}
fn rows<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().map(Vec::as_slice).unwrap_or_default()
}
fn unique<'a>(values: impl Iterator<Item = &'a str>) -> Result<()> {
    let mut seen = BTreeSet::new();
    for value in values {
        if !seen.insert(value) {
            return Err(invalid());
        }
    }
    Ok(())
}
fn named_rows(values: &[Value]) -> Result<()> {
    unique(
        values
            .iter()
            .filter_map(|v| v["name"].as_str())
            .map(str::trim)
            .filter(|name| !name.is_empty()),
    )
}
fn sidecar(files: &BTreeMap<String, ProjectFile>, path: &Value, suffix: &str) -> Result<String> {
    let path = path.as_str().ok_or_else(invalid)?;
    if !path.starts_with("schemas/")
        || !path.ends_with(suffix)
        || path.contains("..")
        || !path
            .strip_suffix(suffix)
            .ok_or_else(invalid)?
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_/-".contains(c))
    {
        return Err(invalid());
    }
    files
        .get(path)
        .map(|file| file.content.clone())
        .ok_or_else(invalid)
}
fn assets(value: &Value, files: &BTreeMap<String, ProjectFile>) -> Result<()> {
    if let Some(fields) = value.as_object() {
        if let Some(file) = fields.get("file").filter(|v| v.is_object()) {
            let id = file["id"].as_str().ok_or_else(invalid)?;
            if !files.contains_key(&format!("assets/{id}.bin")) {
                return Err(invalid());
            }
        }
        for child in fields.values() {
            assets(child, files)?;
        }
    } else if let Some(values) = value.as_array() {
        for child in values {
            assets(child, files)?;
        }
    }
    Ok(())
}
pub(super) fn project(files: &BTreeMap<String, ProjectFile>) -> Result<()> {
    static SCHEMA: OnceLock<jsonschema::Validator> = OnceLock::new();
    let schema = SCHEMA.get_or_init(|| {
        jsonschema::validator_for(
            &serde_json::from_str(include_str!("../../schemas/project.json"))
                .expect("generated canonical schema JSON"),
        )
        .expect("generated canonical schema")
    });
    let manifest: Value =
        serde_yaml::from_str(&files.get("purr.yaml").ok_or_else(invalid)?.content)
            .map_err(|_| invalid())?;
    let mut workspace = manifest["workspace"].clone();
    if let Some(defaults) = manifest["defaults"].as_object() {
        for (key, value) in defaults {
            workspace
                .as_object_mut()
                .ok_or_else(invalid)?
                .insert(key.clone(), value.clone());
        }
    }
    let mut resources = Vec::new();
    for (_, file) in files
        .iter()
        .filter(|(path, _)| path.ends_with(".yaml") && path.as_str() != "purr.yaml")
    {
        let mut value: Value = serde_yaml::from_str(&file.content).map_err(|_| invalid())?;
        let fields = value.as_object_mut().ok_or_else(invalid)?;
        fields.remove("purr");
        if let Some(path) = fields.remove("pinned") {
            if fields.get("kind").and_then(Value::as_str) != Some("schema") {
                return Err(invalid());
            }
            fields.insert(
                "pinnedSdl".into(),
                Value::String(sidecar(files, &path, ".graphql")?),
            );
        }
        if let Some(path) = fields.remove("schema") {
            if fields.get("kind").and_then(Value::as_str) != Some("api-schema") {
                return Err(invalid());
            }
            fields.insert(
                "document".into(),
                Value::String(sidecar(files, &path, ".openapi")?),
            );
        }
        resources.push(value);
    }
    if !schema.is_valid(&json!({"workspace":workspace,"resources":resources})) {
        return Err(invalid());
    }
    let resources: BTreeMap<&str, &Value> = resources
        .iter()
        .map(|v| (v["id"].as_str().unwrap(), v))
        .collect::<BTreeMap<_, _>>();
    // Compare the map to the original YAML count so duplicate IDs cannot collapse.
    if resources.len()
        != files
            .keys()
            .filter(|path| path.ends_with(".yaml") && path.as_str() != "purr.yaml")
            .count()
    {
        return Err(invalid());
    }
    unique(
        rows(&workspace, "headers")
            .iter()
            .filter_map(|v| v["id"].as_str()),
    )?;
    unique(
        rows(&workspace, "auth")
            .iter()
            .filter_map(|v| v["id"].as_str()),
    )?;
    if rows(&workspace, "auth")
        .iter()
        .any(|v| v["config"]["type"] == "inherit")
    {
        return Err(invalid());
    }
    named_rows(rows(&workspace, "variables"))?;
    let mut variable_ids = BTreeSet::new();
    variables(
        rows(&workspace, "variables"),
        &resources,
        &mut variable_ids,
        false,
    )?;
    unique(
        resources
            .values()
            .filter(|v| v["kind"] == "environment")
            .filter_map(|v| v["name"].as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty()),
    )?;
    for resource in resources.values() {
        let kind = resource["kind"].as_str().unwrap();
        if kind == "http" || kind == "graphql" {
            unique(
                rows(resource, "headers")
                    .iter()
                    .filter_map(|v| v["id"].as_str()),
            )?;
            assets(&resource["body"], files)?;
            if let Some(profile) = resource["auth"]["profileId"]
                .as_str()
                .filter(|_| resource["auth"]["type"] == "inherit")
            {
                if !rows(&workspace, "auth")
                    .iter()
                    .any(|v| v["id"] == profile && (v["scope"] == "all" || v["scope"] == kind))
                {
                    return Err(invalid());
                }
            }
            if let Some(id) = resource["origin"]["schemaId"].as_str() {
                if !resources.get(id).is_some_and(|v| v["kind"] == "api-schema") {
                    return Err(invalid());
                }
            }
        }
        if kind == "schema" {
            unique(
                rows(resource, "introspectionHeaders")
                    .iter()
                    .filter_map(|v| v["id"].as_str()),
            )?;
        }
        if kind == "environment" {
            named_rows(rows(resource, "variables"))?;
            variables(
                rows(resource, "variables"),
                &resources,
                &mut variable_ids,
                true,
            )?;
        }
        let mut seen = BTreeSet::from([resource["id"].as_str().unwrap()]);
        let mut parent = resource["folderId"].as_str();
        while let Some(id) = parent {
            if !seen.insert(id) {
                return Err(invalid());
            }
            let folder = resources
                .get(id)
                .filter(|v| v["kind"] == "folder")
                .ok_or_else(invalid)?;
            parent = folder["folderId"].as_str();
        }
    }
    Ok(())
}
fn variables(
    values: &[Value],
    resources: &BTreeMap<&str, &Value>,
    ids: &mut BTreeSet<String>,
    environment: bool,
) -> Result<()> {
    for value in values {
        if !ids.insert(value["id"].as_str().unwrap().into()) {
            return Err(invalid());
        }
        let name = value["name"].as_str().unwrap().trim();
        if name.is_empty() || name.contains(['{', '}']) {
            return Err(invalid());
        }
        let kind = value["kind"].as_str().unwrap();
        if environment && kind != "static" {
            return Err(invalid());
        }
        match kind {
            "static" => {
                let sensitive = value["sensitive"].as_bool().unwrap_or(false);
                if sensitive && (!value["secretRef"].is_string() || value.get("value").is_some())
                    || !sensitive
                        && (!value["value"].is_string() || value.get("secretRef").is_some())
                {
                    return Err(invalid());
                }
            }
            "external-secret" => {
                if value["sensitive"] != true {
                    return Err(invalid());
                }
            }
            "dynamic-request" => {
                if let Some(id) = value["documentId"].as_str().filter(|id| !id.is_empty()) {
                    if !resources
                        .get(id)
                        .is_some_and(|v| v["kind"] == "http" || v["kind"] == "graphql")
                    {
                        return Err(invalid());
                    }
                }
                if value["environment"]["type"] == "specific"
                    && !value["environment"]["environmentId"]
                        .as_str()
                        .and_then(|id| resources.get(id))
                        .is_some_and(|v| v["kind"] == "environment")
                {
                    return Err(invalid());
                }
                if value["refresh"] == "cache" && value.get("cacheTtlSeconds").is_none() {
                    return Err(invalid());
                }
            }
            _ => return Err(invalid()),
        }
    }
    Ok(())
}
