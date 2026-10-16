//! Native-only, canonical-authorized credential transfer. Values never cross IPC.
pub(crate) mod codec;
use crate::persistence::{
    commit_coordinator,
    local_records::LocalStateStore,
    project_files::{FilesystemWorkspaceStore, ProjectFile},
    runtime::transfer_access,
    secret_commits::{SecretBatch, SecretMutation},
};
use crate::security::{scoped::ProtectionScope, CredentialRecoveryKey};
use codec::ContainerKind;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use zeroize::{Zeroize, Zeroizing};

const CANCELLED: &str = "transfer-cancelled";
const TTL: u64 = 300_000;
const MAX_ENTRIES: usize = codec::MAX_ENTRIES;
const MAX_VALUE: usize = codec::MAX_VALUE_BYTES;
const MAX_PAYLOAD: usize = 32 * 1024 * 1024;
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "Cannot generate transfer identifier")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Action {
    Inventory {
        workspace_id: String,
    },
    ExportSelected {
        operation_id: String,
        workspace_id: String,
        references: Vec<String>,
        #[serde(default)]
        omitted_refs: Vec<String>,
        password: String,
    },
    ExportRecoveryKey {
        operation_id: String,
        workspace_id: String,
        password: String,
    },
    ExportCredentialBackup {
        operation_id: String,
        workspace_id: String,
        password: String,
    },
    ExportConfiguration {
        operation_id: String,
        workspace_id: String,
    },
    PrepareImport {
        operation_id: String,
        workspace_id: String,
        staged_id: String,
        password: String,
    },
    SelectImportFile {
        operation_id: String,
        workspace_id: String,
    },
    SelectRecoveryFiles {
        operation_id: String,
        workspace_id: String,
    },
    PrepareRecovery {
        operation_id: String,
        workspace_id: String,
        staged_id: String,
        key_password: String,
        backup_password: String,
    },
    RevealPreviewValue {
        workspace_id: String,
        preview_id: String,
        reference: String,
    },
    CommitImport {
        workspace_id: String,
        preview_id: String,
        operation_id: String,
        references: Vec<String>,
    },
    Cancel {
        preview_id: Option<String>,
        operation_id: Option<String>,
    },
}
impl Drop for Action {
    fn drop(&mut self) {
        match self {
            Self::ExportSelected { password, .. }
            | Self::ExportRecoveryKey { password, .. }
            | Self::ExportCredentialBackup { password, .. }
            | Self::PrepareImport { password, .. } => password.zeroize(),
            Self::PrepareRecovery {
                key_password,
                backup_password,
                ..
            } => {
                key_password.zeroize();
                backup_password.zeroize();
            }
            _ => {}
        }
    }
}

type TransferJob = (String, Arc<AtomicBool>, u64);
#[derive(Default)]
pub struct TransferState {
    previews: Arc<Mutex<HashMap<String, Preview>>>,
    staged_imports: Arc<Mutex<HashMap<String, StagedImport>>>,
    jobs: Mutex<HashMap<String, TransferJob>>,
    windows: Mutex<BTreeSet<String>>,
}
struct Job<'a> {
    state: &'a TransferState,
    id: String,
    token: Arc<AtomicBool>,
}
impl Job<'_> {
    fn check(&self) -> Result<(), String> {
        if self.token.load(Ordering::SeqCst) {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }
}
impl Drop for Job<'_> {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.state.jobs.lock() {
            if jobs
                .get(&self.id)
                .is_some_and(|(_, token, _)| Arc::ptr_eq(token, &self.token))
            {
                jobs.remove(&self.id);
            }
        }
    }
}

struct Preview {
    window: String,
    workspace: String,
    expires: u64,
    rows: Vec<PreparedRow>,
    files: BTreeMap<String, String>,
    receipt: Option<(String, Vec<String>, String)>,
}
type EncryptedPackageBytes = Arc<Zeroizing<Vec<u8>>>;
struct StagedImport {
    window: String,
    workspace: String,
    expires: u64,
    bytes: EncryptedPackageBytes,
    backup: Option<EncryptedPackageBytes>,
}
struct SelectedImportFile {
    name: String,
    bytes: Zeroizing<Vec<u8>>,
}
struct PreparedRow {
    reference: String,
    value: Zeroizing<String>,
    revision: i64,
    known: bool,
}
impl TransferState {
    pub fn watch_window(&self, window: &str) -> bool {
        self.windows
            .lock()
            .map(|mut windows| windows.insert(window.into()))
            .unwrap_or(false)
    }
    fn start_job(&self, window: &str, operation: &str) -> Result<Job<'_>, String> {
        crate::persistence::secret_commits::validate_operation_id(operation)?;
        let mut jobs = self.jobs.lock().map_err(|_| "Transfer state unavailable")?;
        jobs.retain(|_, (_, _, expiry)| *expiry > now());
        if let Some((owner, token, _)) = jobs.get(operation) {
            if owner == window && token.load(Ordering::SeqCst) {
                return Err(CANCELLED.into());
            }
            return Err("Transfer operation already active".into());
        }
        if jobs.len() >= 32 {
            return Err("Too many active transfers".into());
        }
        let token = Arc::new(AtomicBool::new(false));
        jobs.insert(
            operation.into(),
            (window.into(), token.clone(), now() + TTL),
        );
        Ok(Job {
            state: self,
            id: operation.into(),
            token,
        })
    }
    fn cancel_job(&self, window: &str, operation: &str) -> Result<(), String> {
        crate::persistence::secret_commits::validate_operation_id(operation)?;
        let mut jobs = self.jobs.lock().map_err(|_| "Transfer state unavailable")?;
        if let Some((owner, token, _)) = jobs.get(operation) {
            if owner != window {
                return Err("Transfer belongs to another window".into());
            }
            token.store(true, Ordering::SeqCst);
        } else {
            jobs.retain(|_, (_, _, expiry)| *expiry > now());
            if jobs.len() >= 32 {
                return Err("Too many active transfers".into());
            }
            jobs.insert(
                operation.into(),
                (window.into(), Arc::new(AtomicBool::new(true)), now() + TTL),
            );
        }
        Ok(())
    }
    pub fn clear_window(&self, window: &str) {
        if let Ok(mut windows) = self.windows.lock() {
            windows.remove(window);
        }
        if let Ok(jobs) = self.jobs.lock() {
            for (owner, token, _) in jobs.values() {
                if owner == window {
                    token.store(true, Ordering::SeqCst);
                }
            }
        }
        if let Ok(mut entries) = self.previews.lock() {
            entries.retain(|_, p| p.window != window);
        }
        if let Ok(mut entries) = self.staged_imports.lock() {
            entries.retain(|_, p| p.window != window);
        }
    }
    fn insert(&self, preview: Preview) -> Result<String, String> {
        let key = id()?;
        {
            let mut entries = self
                .previews
                .lock()
                .map_err(|_| "Transfer state unavailable")?;
            entries.retain(|_, p| p.expires > now());
            if entries.len() >= 16 {
                return Err("Too many open transfer previews".into());
            }
            entries.insert(key.clone(), preview);
        }
        let entries = Arc::downgrade(&self.previews);
        let expiry_key = key.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(TTL));
            if let Some(entries) = entries.upgrade() {
                if let Ok(mut guard) = entries.lock() {
                    guard.remove(&expiry_key);
                }
            }
        });
        Ok(key)
    }
    fn stage_import(&self, stage: StagedImport) -> Result<String, String> {
        if stage.bytes.len() > 64 * 1024 * 1024
            || stage
                .backup
                .as_ref()
                .is_some_and(|bytes| bytes.len() > 64 * 1024 * 1024)
        {
            return Err("Credential package exceeds file limit".into());
        }
        let key = id()?;
        let mut entries = self
            .staged_imports
            .lock()
            .map_err(|_| "Transfer state unavailable")?;
        entries.retain(|_, p| p.expires > now());
        if entries.len() >= 4 {
            return Err("Too many selected packages".into());
        }
        entries.insert(key.clone(), stage);
        let weak = Arc::downgrade(&self.staged_imports);
        let expiry_key = key.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(TTL));
            if let Some(entries) = weak.upgrade() {
                if let Ok(mut guard) = entries.lock() {
                    guard.remove(&expiry_key);
                }
            }
        });
        Ok(key)
    }
    fn staged_package(
        &self,
        id: &str,
        window: &str,
        workspace: &str,
    ) -> Result<(EncryptedPackageBytes, Option<EncryptedPackageBytes>), String> {
        let mut entries = self
            .staged_imports
            .lock()
            .map_err(|_| "Transfer state unavailable")?;
        entries.retain(|_, p| p.expires > now());
        let stage = entries.get(id).ok_or("transfer-selection-expired")?;
        if stage.window != window || stage.workspace != workspace {
            return Err("Selected package belongs to another workspace or window".into());
        }
        Ok((stage.bytes.clone(), stage.backup.clone()))
    }
    fn staged_import(
        &self,
        id: &str,
        window: &str,
        workspace: &str,
    ) -> Result<Arc<Zeroizing<Vec<u8>>>, String> {
        let (bytes, backup) = self.staged_package(id, window, workspace)?;
        if backup.is_some() {
            return Err("Choose a secrets export package".into());
        }
        Ok(bytes)
    }
}
#[derive(Default)]
struct Inventory {
    owners: BTreeMap<String, Vec<String>>,
    public_count: usize,
    assets: BTreeSet<String>,
    dependencies: BTreeSet<String>,
    variables: BTreeMap<String, Vec<DependencyVariable>>,
    revisions: BTreeMap<String, String>,
}
struct DependencyVariable {
    owner: String,
    kind: String,
    reference: Option<String>,
    expression: Option<String>,
}
fn dependency_summary(
    local: &LocalStateStore,
    inv: &Inventory,
    mut names: BTreeSet<String>,
    selected: &[String],
) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut summary = BTreeSet::new();
    while let Some(name) = names.pop_first() {
        if !seen.insert(name.clone()) {
            continue;
        }
        if seen.len() > MAX_ENTRIES {
            summary.insert("Additional dependencies omitted by metadata limit".into());
            break;
        }
        let Some(variables) = inv.variables.get(&name) else {
            summary.insert(format!(
                "{{{{{name}}}}}: global or unresolved dependency (not included)"
            ));
            continue;
        };
        for variable in variables {
            if summary.len() >= MAX_ENTRIES - 1 {
                summary.insert("Additional dependencies omitted by metadata limit".into());
                return summary.into_iter().collect();
            }
            let status = if let Some(reference) = &variable.reference {
                match local.get_secret(reference) {
                    Ok(Some(value)) => {
                        let value = Zeroizing::new(value);
                        templates(&value, &mut names);
                        if selected.contains(reference) {
                            "selected local secret"
                        } else {
                            "omitted local secret"
                        }
                    }
                    Ok(None) => "missing local secret",
                    Err(_) => "unavailable local secret",
                }
            } else if variable.kind == "static" {
                if let Some(value) = &variable.expression {
                    templates(value, &mut names);
                }
                "public variable in configuration"
            } else if variable.kind == "dynamic-request" {
                "dynamic dependency (not evaluated)"
            } else {
                "external dependency (not included)"
            };
            summary.insert(format!("{{{{{name}}}}} [{}]: {status}", variable.owner));
        }
    }
    summary.into_iter().collect()
}
fn credential_ref(workspace: &str, reference: &str) -> Result<(), String> {
    if ProtectionScope::from_secret_ref(reference)?
        != (ProtectionScope::WorkspaceCredential {
            workspace_id: workspace.into(),
        })
    {
        return Err("Reference is outside workspace credentials".into());
    }
    Ok(())
}
fn templates(value: &str, deps: &mut BTreeSet<String>) {
    let mut rest = value;
    while let Some((_, tail)) = rest.split_once("{{") {
        let Some((name, next)) = tail.split_once("}}") else {
            break;
        };
        let name = name.trim_matches(crate::template::template_whitespace);
        if !name.is_empty() && name.len() <= 256 {
            deps.insert(name.into());
        }
        rest = next;
    }
}
fn optional_shape(v: &Value, key: &str, valid: fn(&Value) -> bool) -> Result<(), String> {
    if v.get(key).is_some_and(|field| !valid(field)) {
        return Err("Invalid saved definition field type".into());
    }
    Ok(())
}
fn credential_containers(v: &Value) -> Result<(), String> {
    optional_shape(v, "auth", Value::is_object)?;
    optional_shape(v, "headers", Value::is_array)?;
    optional_shape(v, "variables", Value::is_array)?;
    optional_shape(v, "introspectionHeaders", Value::is_array)?;
    optional_shape(v, "credentials", Value::is_object)
}
fn fields(v: &Value, allowed: &[&str]) -> Result<(), String> {
    let object = v.as_object().ok_or("Invalid saved definition shape")?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("Unsupported fields in saved definition; save it before export".into());
    }
    Ok(())
}
impl Inventory {
    fn add(&mut self, workspace: &str, reference: &str, owner: &str) -> Result<(), String> {
        credential_ref(workspace, reference)?;
        let owners = self.owners.entry(reference.into()).or_default();
        if !owners.iter().any(|v| v == owner) {
            owners.push(owner.into());
        }
        if self.owners.len() > MAX_ENTRIES {
            return Err("Too many declared credentials".into());
        }
        Ok(())
    }
    fn credential(&mut self, workspace: &str, v: &Value, owner: &str) -> Result<(), String> {
        let allowed = if v["kind"] == "secret" {
            &["kind", "ref"][..]
        } else {
            &["kind", "value"][..]
        };
        fields(v, allowed)?;
        match v["kind"].as_str() {
            Some("secret") => self.add(
                workspace,
                v["ref"].as_str().ok_or("Invalid credential declaration")?,
                owner,
            )?,
            Some("plain") => {
                if !v["value"].is_string() {
                    return Err("Invalid public credential".into());
                }
                self.public_count += 1
            }
            Some("template") => {
                let text = v["value"].as_str().ok_or("Invalid credential template")?;
                if !crate::template::template_only(text) {
                    return Err("Protected templates must be a single reference".into());
                }
                templates(text, &mut self.dependencies)
            }
            _ => return Err("Invalid credential declaration".into()),
        }
        Ok(())
    }
    fn protected(&mut self, workspace: &str, v: &Value, owner: &str) -> Result<(), String> {
        if v["kind"] == "plain" {
            return Err("Save protected literal values as secrets before export".into());
        }
        self.credential(workspace, v, owner)
    }
    fn auth(&mut self, workspace: &str, v: &Value, owner: &str) -> Result<(), String> {
        if v.is_null() {
            return Ok(());
        }
        let allowed: &[&str] = match v["type"].as_str() {
            Some("none") => &["type"],
            Some("inherit") => &["type", "source", "profileId"],
            Some("bearer") => &["type", "token", "prefix"],
            Some("basic") => &["type", "username", "password"],
            Some("api-key") => &["type", "name", "placement", "value"],
            Some("oauth2") => &[
                "type",
                "grantType",
                "authorizationUrl",
                "tokenUrl",
                "clientId",
                "clientSecret",
                "scopes",
                "redirectUri",
                "clientAuthentication",
                "autoRefresh",
            ],
            _ => return Err("Invalid saved authentication".into()),
        };
        fields(v, allowed)?;
        optional_shape(v, "autoRefresh", Value::is_boolean)?;
        let key = match v["type"].as_str() {
            Some("bearer") => "token",
            Some("basic") => "password",
            Some("api-key") => "value",
            Some("oauth2") => "clientSecret",
            Some("none" | "inherit") => return Ok(()),
            None if v.is_null() => return Ok(()),
            _ => return Err("Invalid authentication definition".into()),
        };
        let field = match key {
            "token" => "Bearer token",
            "password" => "Password",
            "value" => "API key",
            _ => "OAuth client secret",
        };
        self.protected(workspace, &v[key], &format!("{owner} / {field}"))
    }
    fn headers(&mut self, workspace: &str, v: &Value, owner: &str) -> Result<(), String> {
        if let Some(rows) = v.as_array() {
            for row in rows {
                fields(
                    row,
                    &["id", "name", "enabled", "sensitive", "value", "scope"],
                )?;
                let name = row["name"]
                    .as_str()
                    .ok_or("Invalid header declaration")?
                    .trim()
                    .to_ascii_lowercase();
                if name.len() > 256 {
                    return Err("Header name exceeds transfer metadata limit".into());
                }
                let label = format!("{owner} / Header {name}");
                optional_shape(row, "sensitive", Value::is_boolean)?;
                optional_shape(row, "enabled", Value::is_boolean)?;
                let sensitive = row["sensitive"].as_bool().unwrap_or(false);
                if matches!(name.as_str(), "cookie" | "set-cookie") && !sensitive {
                    return Err("Cookie header must be protected".into());
                }
                if sensitive {
                    self.protected(workspace, &row["value"], &label)?;
                } else {
                    if row["value"]["kind"] == "secret" {
                        return Err("Secret header must be marked sensitive".into());
                    }
                    self.credential(workspace, &row["value"], &label)?;
                }
            }
        }
        Ok(())
    }
    fn variables(&mut self, workspace: &str, v: &Value, owner: &str) -> Result<(), String> {
        if let Some(rows) = v.as_array() {
            for row in rows {
                let allowed: &[&str] = match row["kind"].as_str() {
                    Some("static") => &[
                        "id",
                        "name",
                        "enabled",
                        "sensitive",
                        "kind",
                        "value",
                        "secretRef",
                    ],
                    Some("dynamic-request") => &[
                        "id",
                        "name",
                        "enabled",
                        "sensitive",
                        "kind",
                        "documentId",
                        "expression",
                        "language",
                        "refresh",
                        "cacheTtlSeconds",
                        "environment",
                    ],
                    Some("external-secret") => &[
                        "id",
                        "name",
                        "enabled",
                        "sensitive",
                        "kind",
                        "provider",
                        "key",
                    ],
                    _ => return Err("Invalid variable definition".into()),
                };
                fields(row, allowed)?;
                optional_shape(row, "sensitive", Value::is_boolean)?;
                optional_shape(row, "enabled", Value::is_boolean)?;
                optional_shape(row, "secretRef", Value::is_string)?;
                let name = row["name"].as_str().ok_or("Invalid variable name")?;
                if name.len() > 256 {
                    return Err("Variable name exceeds transfer metadata limit".into());
                }
                self.variables
                    .entry(name.into())
                    .or_default()
                    .push(DependencyVariable {
                        owner: owner.chars().take(128).collect(),
                        kind: row["kind"].as_str().unwrap_or("").into(),
                        reference: row["secretRef"].as_str().map(str::to_owned),
                        expression: row["value"].as_str().map(str::to_owned),
                    });
                match row["kind"].as_str() {
                    Some("static") => {
                        if let Some(reference) = row["secretRef"].as_str() {
                            if row["sensitive"] != true || row.get("value").is_some() {
                                return Err("Invalid sensitive variable declaration".into());
                            }
                            self.add(workspace, reference, &format!("{owner} / {name}"))?;
                        } else {
                            if row["sensitive"] == true || !row["value"].is_string() {
                                return Err(
                                    "Sensitive variable value must use a secret reference".into()
                                );
                            }
                            self.public_count += 1;
                            templates(row["value"].as_str().unwrap_or(""), &mut self.dependencies);
                        }
                    }
                    Some("external-secret" | "dynamic-request") => {
                        if let Some(name) = row["name"].as_str() {
                            self.dependencies.insert(name.into());
                        }
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }
}
fn collect_assets(v: &Value, assets: &mut BTreeSet<String>) -> Result<(), String> {
    for key in ["pinned", "schema"] {
        if let Some(path) = v[key].as_str() {
            if !path.starts_with("schemas/") || path.contains("..") || path.contains('\\') {
                return Err("Invalid canonical schema path".into());
            }
            assets.insert(path.into());
        }
    }
    let body = &v["body"];
    let mut files = Vec::new();
    if body["type"] == "binary" {
        files.push(&body["file"]);
    }
    if let Some(fields) = body["fields"].as_array() {
        for field in fields {
            if !field["file"].is_null() {
                files.push(&field["file"]);
            }
        }
    }
    for file in files {
        if file.is_null() {
            continue;
        }
        let id = file["id"].as_str().ok_or("Invalid canonical attachment")?;
        if id.is_empty()
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err("Invalid canonical attachment identifier".into());
        }
        assets.insert(format!("assets/{id}.bin"));
    }
    Ok(())
}
fn inventory(files: &BTreeMap<String, ProjectFile>, workspace: &str) -> Result<Inventory, String> {
    let mut inv = Inventory::default();
    let manifest = files
        .get("purr.yaml")
        .ok_or("Save workspace before exporting")?;
    let manifest: Value =
        serde_yaml::from_str(&manifest.content).map_err(|_| "Invalid saved workspace")?;
    if manifest["workspace"]["id"] != workspace {
        return Err("Saved workspace identity does not match".into());
    }
    for (path, file) in files {
        inv.revisions.insert(path.clone(), file.revision.clone());
        if !path.ends_with(".yaml") {
            continue;
        }
        if file.content.len() > MAX_PAYLOAD {
            return Err("Saved definition exceeds transfer limit".into());
        }
        let v: Value =
            serde_yaml::from_str(&file.content).map_err(|_| "Invalid saved definition")?;
        if v["purr"] != 2 {
            return Err("Save definitions in the current project format before transfer".into());
        }
        let owner = v["name"]
            .as_str()
            .or_else(|| v["workspace"]["name"].as_str())
            .unwrap_or(path);
        if path == "purr.yaml" {
            fields(&v, &["purr", "workspace", "defaults"])?;
            fields(
                &v["workspace"],
                &[
                    "id",
                    "name",
                    "description",
                    "variables",
                    "defaultGraphqlSchemaId",
                    "tracePropagation",
                ],
            )?;
            credential_containers(&v["workspace"])?;
            if let Some(defaults) = v.get("defaults") {
                fields(defaults, &["headers", "auth"])?;
                optional_shape(defaults, "headers", Value::is_array)?;
                optional_shape(defaults, "auth", Value::is_array)?;
            }
            inv.variables(workspace, &v["workspace"]["variables"], owner)?;
            inv.headers(workspace, &v["defaults"]["headers"], owner)?;
            if let Some(auth) = v["defaults"]["auth"].as_array() {
                for profile in auth {
                    fields(profile, &["id", "name", "scope", "enabled", "config"])?;
                    optional_shape(profile, "enabled", Value::is_boolean)?;
                    if !profile.get("config").is_some_and(Value::is_object) {
                        return Err("Invalid shared authentication configuration".into());
                    }
                    let profile_name = profile["name"].as_str().unwrap_or("Authentication");
                    if profile_name.len() > 256 {
                        return Err("Authentication name exceeds transfer metadata limit".into());
                    }
                    inv.auth(
                        workspace,
                        &profile["config"],
                        &format!("{owner} / {profile_name}"),
                    )?;
                }
            }
        } else {
            let common = ["purr", "id", "name", "description", "folderId", "kind"];
            let extra: &[&str] = match v["kind"].as_str() {
                Some("http" | "graphql") => &[
                    "url",
                    "method",
                    "documentation",
                    "params",
                    "pathParams",
                    "headers",
                    "body",
                    "auth",
                    "environmentId",
                    "overrides",
                    "origin",
                    "settings",
                    "tracing",
                    "tracePropagation",
                    "graphql",
                ],
                Some("schema") => &[
                    "endpoint",
                    "auth",
                    "introspectionHeaders",
                    "source",
                    "pin",
                    "pinned",
                ],
                Some("environment") => &["variables"],
                Some("integration") => &[
                    "tracing",
                    "provider",
                    "enabled",
                    "configVersion",
                    "config",
                    "credentials",
                ],
                Some("extension") => &["extensionType", "configVersion", "config"],
                Some("api-schema") => &["format", "source", "schema"],
                Some("folder") => &[],
                _ => return Err("Unsupported saved resource kind".into()),
            };
            let allowed = common
                .into_iter()
                .chain(extra.iter().copied())
                .collect::<Vec<_>>();
            fields(&v, &allowed)?;
            credential_containers(&v)?;
            match v["kind"].as_str() {
                Some("http" | "graphql") => {
                    inv.auth(workspace, &v["auth"], owner)?;
                    inv.headers(workspace, &v["headers"], owner)?;
                    templates(v["url"].as_str().unwrap_or(""), &mut inv.dependencies);
                }
                Some("schema") => {
                    let source = &v["source"];
                    let allowed: &[&str] = match source["type"].as_str() {
                        Some("introspection") => &["type", "endpoint", "requestId"],
                        Some("sdl-file" | "introspection-json") => {
                            &["type", "location", "endpoint"]
                        }
                        Some("registry") => &["type", "provider", "resource", "credential"],
                        _ => return Err("Invalid schema source type".into()),
                    };
                    fields(source, allowed)?;
                    optional_shape(source, "credential", Value::is_object)?;
                    inv.auth(workspace, &v["auth"], owner)?;
                    inv.headers(workspace, &v["introspectionHeaders"], owner)?;
                    if v["source"]["type"] == "registry" && !v["source"]["credential"].is_null() {
                        inv.protected(
                            workspace,
                            &v["source"]["credential"],
                            &format!("{owner} / Registry credential"),
                        )?;
                    }
                }
                Some("environment") => inv.variables(workspace, &v["variables"], owner)?,
                Some("integration") => {
                    if let Some(credentials) = v["credentials"].as_object() {
                        for (name, credential) in credentials {
                            if name.len() > 256 {
                                return Err(
                                    "Credential name exceeds transfer metadata limit".into()
                                );
                            }
                            inv.protected(workspace, credential, &format!("{owner} / {name}"))?;
                        }
                    }
                }
                Some("folder" | "extension" | "api-schema") => {}
                _ => return Err("Unsupported saved resource kind".into()),
            }
        }
        collect_assets(&v, &mut inv.assets)?;
    }
    Ok(inv)
}
/// Shared credential/format checks for opening a portable canonical project.
/// Full domain validation remains in the application's canonical decoder.
pub(crate) fn validate_project_files(
    files: &BTreeMap<String, ProjectFile>,
    workspace: &str,
) -> Result<(), String> {
    inventory(files, workspace).map(|_| ())
}
fn inventory_json(local: &LocalStateStore, inv: &Inventory) -> Value {
    let items: Vec<_> = inv
        .owners
        .iter()
        .map(|(reference, owners)| {
            let status = match local.get_secret_typed(reference) {
                Ok(Some(mut value)) => {
                    value.zeroize();
                    "available".to_string()
                }
                Ok(None) => "missing".into(),
                Err(e) => serde_json::to_value(e.status)
                    .ok()
                    .and_then(|s| s.as_str().map(str::to_owned))
                    .unwrap_or_else(|| "unavailable".into()),
            };
            json!({"ref":reference,"owners":owners,"status":status})
        })
        .collect();
    json!({"items":items,"publicValueCount":inv.public_count,"dependencies":dependency_summary(local,inv,inv.dependencies.clone(),&[]),"unsavedExcluded":true})
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretEntry {
    #[serde(rename = "ref")]
    reference: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    value: Zeroizing<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretArchive {
    version: u32,
    workspace_id: String,
    entries: Vec<SecretEntry>,
    omissions: Vec<String>,
    dependencies: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyArchive {
    version: u32,
    workspace_id: String,
    keys: Vec<CredentialRecoveryKey>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CipherRow {
    #[serde(rename = "ref")]
    reference: String,
    version: i64,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupArchive {
    version: u32,
    workspace_id: String,
    rows: Vec<CipherRow>,
    omissions: Vec<String>,
    dependencies: Vec<String>,
}
fn validate_selection(inv: &Inventory, refs: &[String]) -> Result<(), String> {
    if refs.len() > MAX_ENTRIES
        || refs.iter().collect::<BTreeSet<_>>().len() != refs.len()
        || refs.iter().any(|r| !inv.owners.contains_key(r))
    {
        return Err("Selection contains undeclared or duplicate references".into());
    }
    Ok(())
}
fn selected(
    local: &LocalStateStore,
    inv: &Inventory,
    workspace: &str,
    refs: &[String],
    omitted: &[String],
) -> Result<SecretArchive, String> {
    validate_selection(inv, refs)?;
    validate_selection(inv, omitted)?;
    if refs.is_empty() || refs.iter().any(|r| omitted.contains(r)) {
        return Err("Choose at least one available credential".into());
    }
    let mut entries = Vec::new();
    let mut deps = inv.dependencies.clone();
    let mut size = 0;
    for reference in refs {
        let value = local
            .get_secret(reference)?
            .ok_or("Selected secret is missing; exclude it explicitly")?;
        let entry = SecretEntry {
            reference: reference.clone(),
            label: inv
                .owners
                .get(reference)
                .and_then(|owners| owners.first())
                .filter(|name| name.len() <= 512)
                .cloned(),
            value: Zeroizing::new(value),
        };
        size += entry.value.len();
        if entry.value.len() > MAX_VALUE || size > MAX_PAYLOAD {
            return Err("Credential export exceeds limit".into());
        }
        templates(&entry.value, &mut deps);
        entries.push(entry);
    }
    Ok(SecretArchive {
        version: 1,
        workspace_id: workspace.into(),
        entries,
        omissions: inv
            .owners
            .keys()
            .filter(|r| !refs.contains(r))
            .cloned()
            .collect(),
        dependencies: dependency_summary(local, inv, deps, refs),
    })
}
fn backup(
    local: &LocalStateStore,
    inv: &Inventory,
    workspace: &str,
) -> Result<BackupArchive, String> {
    let tx = local
        .db
        .unchecked_transaction()
        .map_err(|_| "Cannot snapshot credentials")?;
    let mut rows = vec![];
    let mut omissions = vec![];
    let mut size = 0usize;
    use rusqlite::OptionalExtension;
    for reference in inv.owners.keys() {
        let length: Option<i64> = tx
            .query_row(
                "SELECT length(ciphertext) FROM secret_values WHERE reference=?1",
                [reference],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "Cannot inspect credential snapshot")?;
        if length.is_some_and(|length| {
            length < 0
                || length as usize > MAX_VALUE + 2048
                || size.saturating_add(length as usize) > MAX_PAYLOAD
        }) {
            return Err("Credential backup exceeds limit".into());
        }
        let row = tx
            .query_row(
                "SELECT crypto_version,nonce,ciphertext FROM secret_values WHERE reference=?1",
                [reference],
                |row| {
                    Ok(CipherRow {
                        reference: reference.clone(),
                        version: row.get(0)?,
                        nonce: row.get(1)?,
                        ciphertext: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(|_| "Cannot snapshot credentials")?;
        if let Some(row) = row {
            size += row.ciphertext.len();
            if row.ciphertext.len() > MAX_VALUE + 2048 || size > MAX_PAYLOAD {
                return Err("Credential backup exceeds limit".into());
            }
            rows.push(row)
        } else {
            omissions.push(reference.clone())
        }
    }
    tx.rollback()
        .map_err(|_| "Cannot finish credential snapshot")?;
    Ok(BackupArchive {
        version: 1,
        workspace_id: workspace.into(),
        rows,
        omissions,
        dependencies: dependency_summary(
            local,
            inv,
            inv.dependencies.clone(),
            &inv.owners.keys().cloned().collect::<Vec<_>>(),
        ),
    })
}
#[allow(clippy::too_many_arguments)]
fn prepare(
    state: &TransferState,
    local: &LocalStateStore,
    inv: Inventory,
    window: &str,
    workspace: &str,
    archive: SecretArchive,
    check: impl Fn() -> Result<(), String>,
) -> Result<Value, String> {
    check()?;
    if archive.version != 1 || archive.workspace_id != workspace {
        return Err("Package belongs to another workspace or unsupported version".into());
    }
    if archive.entries.len() > MAX_ENTRIES
        || archive.omissions.len() > MAX_ENTRIES
        || archive.dependencies.len() > MAX_ENTRIES
    {
        return Err("Package exceeds entry limit".into());
    }
    let mut seen = BTreeSet::new();
    let mut size = 0;
    let mut rows = vec![];
    let mut items = vec![];
    for entry in &archive.entries {
        credential_ref(workspace, &entry.reference)?;
        size += entry.value.len();
        if !seen.insert(&entry.reference)
            || entry.value.len() > MAX_VALUE
            || size > MAX_PAYLOAD
            || entry.label.as_ref().is_some_and(|label| label.len() > 512)
        {
            return Err("Invalid duplicate or oversized credential".into());
        }
        let known = inv.owners.contains_key(&entry.reference);
        let (revision, status) = if known {
            let mut current = local.read_secret(&entry.reference)?;
            let status = if current.value.is_some() {
                "existing"
            } else {
                "missing"
            };
            if let Some(value) = current.value.as_mut() {
                value.zeroize();
            }
            (current.revision, status)
        } else {
            (0, "unknown")
        };
        let owners = inv
            .owners
            .get(&entry.reference)
            .cloned()
            .unwrap_or_else(|| entry.label.clone().into_iter().collect());
        items.push(json!({"ref":entry.reference,"owners":owners,"status":status}));
        rows.push(PreparedRow {
            reference: entry.reference.clone(),
            value: entry.value.clone(),
            revision,
            known,
        });
    }
    let mut omitted = BTreeSet::new();
    for reference in &archive.omissions {
        credential_ref(workspace, reference)?;
        if !omitted.insert(reference) || seen.contains(reference) {
            return Err("Duplicate or overlapping package omissions".into());
        }
    }
    if archive.dependencies.iter().any(|d| d.len() > 1024) {
        return Err("Invalid dependency metadata".into());
    }
    check()?;
    let expires = now() + TTL;
    let key = state.insert(Preview {
        window: window.into(),
        workspace: workspace.into(),
        expires,
        rows,
        files: inv.revisions,
        receipt: None,
    })?;
    if let Err(error) = check() {
        if let Ok(mut entries) = state.previews.lock() {
            entries.remove(&key);
        }
        return Err(error);
    }
    Ok(
        json!({"id":key,"workspaceId":workspace,"expiresAt":expires,"items":items,"omissions":archive.omissions,"dependencies":archive.dependencies}),
    )
}
#[allow(clippy::too_many_arguments)]
fn commit(
    state: &TransferState,
    local: &mut LocalStateStore,
    files: &FilesystemWorkspaceStore,
    window: &str,
    workspace: &str,
    preview_id: &str,
    operation_id: &str,
    references: &[String],
    check: impl Fn() -> Result<(), String>,
) -> Result<Value, String> {
    check()?;
    let mut entries = state
        .previews
        .lock()
        .map_err(|_| "Transfer state unavailable")?;
    entries.retain(|_, p| p.expires > now());
    let preview = entries
        .get_mut(preview_id)
        .ok_or("Import preview expired; open the package again")?;
    if preview.window != window || preview.workspace != workspace {
        return Err("Import preview does not belong to this window and workspace".into());
    }
    if let Some((operation, selection, status)) = &preview.receipt {
        if operation != operation_id || selection != references {
            return Err("operation-conflict: import preview already completed".into());
        }
        return Ok(json!({"operationId":operation_id,"status":status}));
    }
    crate::persistence::secret_commits::validate_operation_id(operation_id)?;
    if references.iter().collect::<BTreeSet<_>>().len() != references.len()
        || references.iter().any(|reference| {
            !preview
                .rows
                .iter()
                .any(|row| row.reference == *reference && row.known)
        })
    {
        return Err("Import selection contains unknown or duplicate references".into());
    }
    let current = inventory(&files.load_transfer_definitions()?, workspace)?;
    if current.revisions != preview.files {
        return Err("Saved configuration changed; open a new import preview".into());
    }
    let mut batch = SecretBatch {
        operation_id: operation_id.into(),
        mutations: preview
            .rows
            .iter()
            .filter(|row| references.contains(&row.reference))
            .map(|row| SecretMutation {
                reference: row.reference.clone(),
                scope: Some(ProtectionScope::WorkspaceCredential {
                    workspace_id: workspace.into(),
                }),
                expected_revision: row.revision,
                value: Some(row.value.to_string()),
            })
            .collect(),
    };
    check()?;
    let result = commit_coordinator::commit(local, files, workspace, &[], &[], &batch);
    for mutation in &mut batch.mutations {
        if let Some(value) = &mut mutation.value {
            value.zeroize();
        }
    }
    let status = match result {
        Ok(_) => "committed",
        Err(error) if error.contains("recovery-required") => "recovery-required",
        Err(error) => return Err(error),
    };
    preview.rows.clear();
    preview.receipt = Some((operation_id.into(), references.to_vec(), status.into()));
    Ok(json!({"operationId":operation_id,"status":status}))
}
struct BoundedPayload(Zeroizing<Vec<u8>>);
impl Write for BoundedPayload {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_PAYLOAD {
            return Err(std::io::Error::other("Credential package exceeds limit"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn json_bytes(value: &impl Serialize) -> Result<Zeroizing<Vec<u8>>, String> {
    let mut bytes = BoundedPayload(Zeroizing::new(Vec::new()));
    serde_json::to_writer(&mut bytes, value)
        .map_err(|_| "Cannot encode credential package within size limit")?;
    Ok(bytes.0)
}
fn save(
    app: &tauri::AppHandle,
    kind: ContainerKind,
    password: &str,
    value: &impl Serialize,
    name: &str,
    job: &Job,
) -> Result<Value, String> {
    job.check()?;
    let bytes = json_bytes(value)?;
    let Some(file) = app
        .dialog()
        .file()
        .set_title("Export encrypted package")
        .set_file_name(name)
        .add_filter("Purr encrypted package", &["purrsecrets"])
        .blocking_save_file()
    else {
        return Ok(json!({"status":"cancelled"}));
    };
    let path = file.into_path().map_err(|_| "Invalid export destination")?;
    atomic_cipher_file(&path, kind, password, &bytes, || job.check())?;
    Ok(json!({"status":"written"}))
}
fn atomic_cipher_file(
    path: &Path,
    kind: ContainerKind,
    password: &str,
    bytes: &[u8],
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    check()?;
    let parent = path.parent().ok_or("Invalid export destination")?;
    let mut temp =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "Cannot create encrypted export")?;
    codec::encode(temp.as_file_mut(), kind, password, bytes)?;
    temp.as_file_mut()
        .flush()
        .map_err(|_| "Cannot flush encrypted export")?;
    temp.as_file()
        .sync_all()
        .map_err(|_| "Cannot sync encrypted export")?;
    check()?;
    temp.persist(path)
        .map_err(|_| "Cannot finish encrypted export")?;
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|_| "Cannot sync export directory")?;
    Ok(())
}
fn select_import_file(
    app: &tauri::AppHandle,
    title: &str,
    job: &Job,
) -> Result<Option<SelectedImportFile>, String> {
    job.check()?;
    let Some(file) = app
        .dialog()
        .file()
        .set_title(title)
        .add_filter("Purr encrypted package", &["purrsecrets"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|_| "Invalid package path")?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Selected package")
        .to_owned();
    let file = fs::File::open(path).map_err(|_| "Cannot open credential package")?;
    if file
        .metadata()
        .map_err(|_| "Cannot inspect credential package")?
        .len()
        > 64 * 1024 * 1024
    {
        return Err("Credential package exceeds file limit".into());
    }
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read credential package")?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("Credential package exceeds file limit".into());
    }
    job.check()?;
    Ok(Some(SelectedImportFile { name, bytes }))
}
fn decode_recovery(
    key_bytes: &[u8],
    backup_bytes: &[u8],
    workspace_id: &str,
    key_password: &str,
    backup_password: &str,
    check: impl Fn() -> Result<(), String>,
) -> Result<SecretArchive, String> {
    let bytes = codec::decode(
        std::io::Cursor::new(key_bytes),
        ContainerKind::RecoveryKeys,
        key_password,
    )
    .map_err(|_| "recovery-key-unlock-failed")?;
    let keys: KeyArchive = decode(&bytes).map_err(|_| "recovery-payload-invalid")?;
    if keys.workspace_id != workspace_id {
        return Err("recovery-workspace-mismatch".into());
    }
    if keys.version != 1 || keys.keys.is_empty() || keys.keys.len() > 128 {
        return Err("recovery-payload-invalid".into());
    }
    let mut key_ids = BTreeSet::new();
    for key in &keys.keys {
        key.validate(workspace_id)
            .map_err(|_| "recovery-key-mismatch")?;
        if !key_ids.insert(key.key_id()) {
            return Err("recovery-payload-invalid".into());
        }
    }
    check()?;
    let bytes = codec::decode(
        std::io::Cursor::new(backup_bytes),
        ContainerKind::CredentialBackup,
        backup_password,
    )
    .map_err(|_| "recovery-backup-unlock-failed")?;
    let backup: BackupArchive = decode(&bytes).map_err(|_| "recovery-payload-invalid")?;
    if backup.workspace_id != workspace_id {
        return Err("recovery-workspace-mismatch".into());
    }
    if backup.version != 1 || backup.rows.len() > MAX_ENTRIES {
        return Err("recovery-payload-invalid".into());
    }
    let mut entries = vec![];
    let mut size = 0usize;
    for row in backup.rows {
        let bytes = crate::security::decrypt_recovery_secret(
            &keys.keys,
            workspace_id,
            &row.reference,
            row.version,
            &row.nonce,
            &row.ciphertext,
        )
        .map_err(|_| "recovery-key-mismatch")?;
        size += bytes.len();
        if bytes.len() > MAX_VALUE || size > MAX_PAYLOAD {
            return Err("recovery-payload-invalid".into());
        }
        let value = std::str::from_utf8(&bytes)
            .map_err(|_| "recovery-payload-invalid")?
            .to_owned();
        entries.push(SecretEntry {
            reference: row.reference,
            label: None,
            value: Zeroizing::new(value),
        });
    }
    Ok(SecretArchive {
        version: 1,
        workspace_id: workspace_id.into(),
        entries,
        omissions: backup.omissions,
        dependencies: backup.dependencies,
    })
}
fn recovery_pair(
    first: SelectedImportFile,
    second: SelectedImportFile,
) -> Result<(SelectedImportFile, SelectedImportFile), String> {
    match (
        codec::kind_hint(&first.bytes),
        codec::kind_hint(&second.bytes),
    ) {
        (Ok(ContainerKind::RecoveryKeys), Ok(ContainerKind::CredentialBackup)) => {
            Ok((first, second))
        }
        (Ok(ContainerKind::CredentialBackup), Ok(ContainerKind::RecoveryKeys)) => {
            Ok((second, first))
        }
        _ => Err("recovery-files-invalid".into()),
    }
}
fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    serde_json::from_slice(bytes).map_err(|_| "Invalid credential package payload".into())
}
fn configuration_snapshot(
    files: &FilesystemWorkspaceStore,
    workspace_id: &str,
) -> Result<BTreeMap<String, ProjectFile>, String> {
    let mut snapshot = files.load_transfer_definitions()?;
    let inv = inventory(&snapshot, workspace_id)?;
    let mut total = 0u64;
    for path in &inv.assets {
        let source = files.path(path)?;
        let file = fs::File::open(source).map_err(|_| "A canonical asset is missing")?;
        let mut bytes = Vec::new();
        file.take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read canonical asset")?;
        total += bytes.len() as u64;
        if bytes.len() > 64 * 1024 * 1024 || total > 512 * 1024 * 1024 {
            return Err("Configuration assets exceed export limit".into());
        }
        use base64::{engine::general_purpose::STANDARD, Engine};
        let revision = crate::persistence::project_files::revision(&bytes);
        let content = if path.starts_with("assets/") {
            STANDARD.encode(bytes)
        } else {
            String::from_utf8(bytes).map_err(|_| "Invalid canonical schema encoding")?
        };
        snapshot.insert(path.clone(), ProjectFile { content, revision });
    }
    Ok(snapshot)
}
fn configuration(
    files: &BTreeMap<String, ProjectFile>,
    destination: &Path,
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    check()?;
    if fs::symlink_metadata(destination)
        .map_err(|_| "Cannot inspect export directory")?
        .file_type()
        .is_symlink()
        || fs::read_dir(destination)
            .map_err(|_| "Cannot inspect export directory")?
            .next()
            .is_some()
    {
        return Err("Choose a new empty directory".into());
    }
    let staging = tempfile::tempdir_in(destination.parent().ok_or("Invalid export directory")?)
        .map_err(|_| "Cannot stage configuration")?;
    let store = FilesystemWorkspaceStore {
        directory: staging.path().into(),
    };
    use base64::{engine::general_purpose::STANDARD, Engine};
    for (path, file) in files {
        let target = store.path(path)?;
        fs::create_dir_all(target.parent().ok_or("Invalid project path")?)
            .map_err(|_| "Cannot export configuration")?;
        let bytes = if path.starts_with("assets/") {
            STANDARD
                .decode(&file.content)
                .map_err(|_| "Invalid canonical asset")?
        } else {
            file.content.as_bytes().to_vec()
        };
        fs::write(target, bytes).map_err(|_| "Cannot export configuration")?;
    } // Only publish into the explicitly selected empty directory.
    check()?;
    if fs::read_dir(destination)
        .map_err(|_| "Cannot inspect export directory")?
        .next()
        .is_some()
    {
        return Err("Export directory changed".into());
    }
    fs::rename(staging.path(), destination)
        .map_err(|_| "Cannot atomically publish configuration into selected empty directory")?;
    Ok(())
}

fn cancel(
    state: &TransferState,
    window: &str,
    preview_id: Option<&str>,
    operation_id: Option<&str>,
) -> Result<Value, String> {
    if let Some(preview_id) = preview_id {
        {
            let mut stages = state
                .staged_imports
                .lock()
                .map_err(|_| "Transfer state unavailable")?;
            if stages.get(preview_id).is_some_and(|p| p.window != window) {
                return Err("Selected package belongs to another window".into());
            }
            stages.remove(preview_id);
        }
        let mut entries = state
            .previews
            .lock()
            .map_err(|_| "Transfer state unavailable")?;
        if entries.get(preview_id).is_some_and(|p| p.window != window) {
            return Err("Preview belongs to another window".into());
        }
        if let Some((operation, _, status)) =
            entries.get(preview_id).and_then(|p| p.receipt.as_ref())
        {
            return Ok(json!({"operationId":operation,"status":status}));
        }
        entries.remove(preview_id);
    }
    if let Some(operation) = operation_id {
        let completed = || -> Result<Option<Value>, String> {
            let entries = state
                .previews
                .lock()
                .map_err(|_| "Transfer state unavailable")?;
            Ok(entries
                .values()
                .filter(|preview| preview.window == window)
                .find_map(|preview| {
                    preview
                        .receipt
                        .as_ref()
                        .filter(|(id, _, _)| id == operation)
                        .map(|(id, _, status)| json!({"operationId":id,"status":status}))
                }))
        };
        if let Some(receipt) = completed()? {
            return Ok(receipt);
        }
        state.cancel_job(window, operation)?;
        if let Some(receipt) = completed()? {
            return Ok(receipt);
        }
    }
    Ok(json!({"status":"cancelled"}))
}
fn cancellation_result(
    action: &Action,
    result: Result<Value, String>,
    receipt: impl FnOnce(&str) -> Result<String, String>,
) -> Result<Value, String> {
    if result.as_ref().is_err_and(|error| error == CANCELLED) {
        match action {
            Action::SelectImportFile { .. }
            | Action::SelectRecoveryFiles { .. }
            | Action::PrepareImport { .. }
            | Action::PrepareRecovery { .. } => Ok(Value::Null),
            Action::ExportSelected { .. }
            | Action::ExportRecoveryKey { .. }
            | Action::ExportCredentialBackup { .. }
            | Action::ExportConfiguration { .. } => Ok(json!({"status":"cancelled"})),
            Action::CommitImport { operation_id, .. } => {
                let durable = receipt(operation_id)?;
                let status = match durable.as_str() {
                    "committed" => "committed",
                    "missing" | "aborted" => "aborted",
                    _ => "recovery-required",
                };
                Ok(json!({"operationId":operation_id,"status":status}))
            }
            _ => result,
        }
    } else {
        result
    }
}
pub fn dispatch(app: &tauri::AppHandle, window: &str, action: Action) -> Result<Value, String> {
    let result = dispatch_inner(app, window, &action);
    cancellation_result(&action, result, |operation| {
        crate::persistence::runtime::secure_operation_status(
            app.clone(),
            app.state::<crate::persistence::PersistenceState>(),
            operation.into(),
        )
        .map(|receipt| receipt.status)
    })
}
// Plaintext leaves the preview only for an explicit, capability-bound single-row reveal.
fn reveal_preview_value(
    state: &TransferState,
    window: &str,
    workspace: &str,
    preview_id: &str,
    reference: &str,
) -> Result<String, String> {
    let mut previews = state
        .previews
        .lock()
        .map_err(|_| "Transfer state unavailable")?;
    previews.retain(|_, preview| preview.expires > now());
    let preview = previews
        .get(preview_id)
        .ok_or("Secret preview expired or unavailable")?;
    if preview.window != window || preview.workspace != workspace || preview.receipt.is_some() {
        return Err("Secret preview unavailable".into());
    }
    preview
        .rows
        .iter()
        .find(|row| row.reference == reference)
        .map(|row| row.value.to_string())
        .ok_or_else(|| "Secret is not in this preview".into())
}
fn dispatch_inner(app: &tauri::AppHandle, window: &str, action: &Action) -> Result<Value, String> {
    let state = app.state::<TransferState>();
    let operation = match &action {
        Action::ExportSelected { operation_id, .. }
        | Action::ExportRecoveryKey { operation_id, .. }
        | Action::ExportCredentialBackup { operation_id, .. }
        | Action::ExportConfiguration { operation_id, .. }
        | Action::SelectImportFile { operation_id, .. }
        | Action::SelectRecoveryFiles { operation_id, .. }
        | Action::PrepareImport { operation_id, .. }
        | Action::PrepareRecovery { operation_id, .. }
        | Action::CommitImport { operation_id, .. } => Some(operation_id.as_str()),
        _ => None,
    };
    let job = operation
        .map(|operation| state.start_job(window, operation))
        .transpose()?;
    match &action {
        Action::Inventory { workspace_id } => transfer_access(app, workspace_id, |local, files| {
            let inv = inventory(&files.load_transfer_definitions()?, workspace_id)?;
            Ok(inventory_json(local, &inv))
        }),
        Action::ExportSelected {
            workspace_id,
            references,
            omitted_refs,
            password,
            ..
        } => {
            let archive = transfer_access(app, workspace_id, |local, files| {
                selected(
                    local,
                    &inventory(&files.load_transfer_definitions()?, workspace_id)?,
                    workspace_id,
                    references,
                    omitted_refs,
                )
            })?;
            save(
                app,
                ContainerKind::SelectedSecrets,
                password,
                &archive,
                "selected-secrets.purrsecrets",
                job.as_ref().ok_or("Missing transfer operation")?,
            )
        }
        Action::ExportRecoveryKey {
            workspace_id,
            password,
            ..
        } => {
            let archive = transfer_access(app, workspace_id, |local, files| {
                inventory(&files.load_transfer_definitions()?, workspace_id)?;
                Ok(KeyArchive {
                    version: 1,
                    workspace_id: workspace_id.clone(),
                    keys: local
                        .secret_cipher
                        .export_credential_recovery_keys(workspace_id)?,
                })
            })?;
            save(
                app,
                ContainerKind::RecoveryKeys,
                password,
                &archive,
                "recovery-key.purrsecrets",
                job.as_ref().ok_or("Missing transfer operation")?,
            )
        }
        Action::ExportCredentialBackup {
            workspace_id,
            password,
            ..
        } => {
            let archive = transfer_access(app, workspace_id, |local, files| {
                backup(
                    local,
                    &inventory(&files.load_transfer_definitions()?, workspace_id)?,
                    workspace_id,
                )
            })?;
            save(
                app,
                ContainerKind::CredentialBackup,
                password,
                &archive,
                "credential-backup.purrsecrets",
                job.as_ref().ok_or("Missing transfer operation")?,
            )
        }
        Action::ExportConfiguration { workspace_id, .. } => {
            let files = transfer_access(app, workspace_id, |_, files| {
                configuration_snapshot(files, workspace_id)
            })?;
            let Some(folder) = app
                .dialog()
                .file()
                .set_title("Export configuration to an empty directory")
                .blocking_pick_folder()
            else {
                return Ok(json!({"status":"cancelled"}));
            };
            job.as_ref().ok_or("Missing transfer operation")?.check()?;
            configuration(
                &files,
                &folder.into_path().map_err(|_| "Invalid export directory")?,
                || job.as_ref().ok_or("Missing transfer operation")?.check(),
            )?;
            Ok(json!({"status":"written"}))
        }
        Action::SelectImportFile { workspace_id, .. } => {
            // Verify the workspace before holding even encrypted package bytes in memory.
            transfer_access(app, workspace_id, |_, files| {
                inventory(&files.load_transfer_definitions()?, workspace_id).map(|_| ())
            })?;
            let Some(SelectedImportFile { name, bytes }) = select_import_file(
                app,
                "Choose secrets package",
                job.as_ref().ok_or("Missing transfer operation")?,
            )?
            else {
                return Ok(Value::Null);
            };
            if codec::kind_hint(&bytes) != Ok(ContainerKind::SelectedSecrets) {
                return Err("transfer-file-kind-invalid".into());
            }
            let staged_id = state.stage_import(StagedImport {
                window: window.into(),
                workspace: workspace_id.clone(),
                expires: now() + TTL,
                bytes: Arc::new(bytes),
                backup: None,
            })?;
            if let Err(error) = job.as_ref().ok_or("Missing transfer operation")?.check() {
                if let Ok(mut stages) = state.staged_imports.lock() {
                    stages.remove(&staged_id);
                }
                return Err(error);
            }
            Ok(json!({"id":staged_id,"name":name}))
        }
        Action::PrepareImport {
            workspace_id,
            staged_id,
            password,
            ..
        } => {
            let bytes = state.staged_import(staged_id, window, workspace_id)?;
            job.as_ref().ok_or("Missing transfer operation")?.check()?;
            let bytes = codec::decode(
                std::io::Cursor::new(bytes.as_slice()),
                ContainerKind::SelectedSecrets,
                password,
            )?;
            let archive = decode(&bytes)?;
            job.as_ref().ok_or("Missing transfer operation")?.check()?;
            let result = transfer_access(app, workspace_id, |local, files| {
                prepare(
                    &state,
                    local,
                    inventory(&files.load_transfer_definitions()?, workspace_id)?,
                    window,
                    workspace_id,
                    archive,
                    || job.as_ref().ok_or("Missing transfer operation")?.check(),
                )
            })?;
            if let Ok(mut stages) = state.staged_imports.lock() {
                stages.remove(staged_id);
            }
            Ok(result)
        }
        Action::SelectRecoveryFiles { workspace_id, .. } => {
            transfer_access(app, workspace_id, |_, files| {
                inventory(&files.load_transfer_definitions()?, workspace_id).map(|_| ())
            })?;
            let job = job.as_ref().ok_or("Missing transfer operation")?;
            let Some(key) =
                select_import_file(app, "Choose recovery key or credential backup", job)?
            else {
                return Ok(Value::Null);
            };
            let Some(backup) = select_import_file(app, "Choose the other recovery file", job)?
            else {
                return Ok(Value::Null);
            };
            let (key, backup) = recovery_pair(key, backup)?;
            let staged_id = state.stage_import(StagedImport {
                window: window.into(),
                workspace: workspace_id.clone(),
                expires: now() + TTL,
                bytes: Arc::new(key.bytes),
                backup: Some(Arc::new(backup.bytes)),
            })?;
            if let Err(error) = job.check() {
                if let Ok(mut stages) = state.staged_imports.lock() {
                    stages.remove(&staged_id);
                }
                return Err(error);
            }
            Ok(json!({"id":staged_id,"keyName":key.name,"backupName":backup.name}))
        }
        Action::PrepareRecovery {
            workspace_id,
            staged_id,
            key_password,
            backup_password,
            ..
        } => {
            let (key_bytes, backup_bytes) =
                state.staged_package(staged_id, window, workspace_id)?;
            let backup_bytes = backup_bytes.ok_or("recovery-files-invalid")?;
            job.as_ref().ok_or("Missing transfer operation")?.check()?;
            let archive = decode_recovery(
                &key_bytes,
                &backup_bytes,
                workspace_id,
                key_password,
                backup_password,
                || job.as_ref().ok_or("Missing transfer operation")?.check(),
            )?;
            job.as_ref().ok_or("Missing transfer operation")?.check()?;
            let result = transfer_access(app, workspace_id, |local, files| {
                prepare(
                    &state,
                    local,
                    inventory(&files.load_transfer_definitions()?, workspace_id)?,
                    window,
                    workspace_id,
                    archive,
                    || job.as_ref().ok_or("Missing transfer operation")?.check(),
                )
            })?;
            if let Ok(mut stages) = state.staged_imports.lock() {
                stages.remove(staged_id);
            }
            Ok(result)
        }
        Action::RevealPreviewValue {
            workspace_id,
            preview_id,
            reference,
        } => reveal_preview_value(&state, window, workspace_id, preview_id, reference)
            .map(Value::String),
        Action::CommitImport {
            workspace_id,
            preview_id,
            operation_id,
            references,
        } => transfer_access(app, workspace_id, |local, files| {
            commit(
                &state,
                local,
                files,
                window,
                workspace_id,
                preview_id,
                operation_id,
                references,
                || job.as_ref().ok_or("Missing transfer operation")?.check(),
            )
        }),
        Action::Cancel {
            preview_id,
            operation_id,
        } => cancel(
            &state,
            window,
            preview_id.as_deref(),
            operation_id.as_deref(),
        ),
    }
}

#[cfg(test)]
mod tests;
