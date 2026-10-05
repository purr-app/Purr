//! Postman exports are untrusted data, never executable scripts or local file grants.
use super::*;

pub(super) struct CollectionAdapter;
pub(super) struct EnvironmentAdapter;

fn root(source: &LoadedSource) -> &Value {
    &source.documents[&source.root]
}
fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Null) | None => String::new(),
        Some(value) => value.to_string(),
    }
}
fn description(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|v| {
            v.as_str()
                .or_else(|| v.get("content").and_then(Value::as_str))
        })
        .map(str::to_owned)
}
fn array<'a>(value: Option<&'a Value>, path: &str) -> Result<&'a [Value], String> {
    match value {
        None => Ok(&[]),
        Some(Value::Array(values)) => Ok(values),
        _ => Err(format!("Expected an array at {path}.")),
    }
}
fn sensitive_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase().replace(['-', '_'], "");
    [
        "authorization",
        "cookie",
        "password",
        "secret",
        "token",
        "apikey",
    ]
    .iter()
    .any(|part| name.contains(part))
}
fn template_only(value: &str) -> bool {
    let value = value.trim();
    value.starts_with("{{")
        && value.ends_with("}}")
        && !value[2..value.len() - 2].contains(['{', '}'])
}

impl ImportAdapter for CollectionAdapter {
    fn can_import(&self, source: &LoadedSource) -> bool {
        root(source)
            .pointer("/info/schema")
            .and_then(Value::as_str)
            .is_some_and(|schema| {
                ["/v2.0.0/", "/v2.1.0/"]
                    .iter()
                    .any(|version| schema.contains(version))
                    && schema.ends_with("collection.json")
            })
    }
    fn normalize_project(
        &self,
        source: &LoadedSource,
        workspace_id: &str,
        import_id: &str,
    ) -> Result<NormalizedImportResult, String> {
        let root = root(source);
        let mut builder = Builder::new(
            workspace_id,
            import_id,
            "postman-collection",
            &text(root.pointer("/info/name")),
        );
        if let Some(desc) = description(root.pointer("/info/description")) {
            builder.result.workspace["description"] = json!(desc);
        }
        builder.result.workspace["variables"] =
            json!(builder.variables(root.get("variable"), "#/variable")?);
        builder.events(root, "#")?;
        let auth = builder.auth(root.get("auth"), &json!({"type":"none"}), "#/auth")?;
        if root.get("item").is_none() {
            return Err("Postman collection is missing item.".into());
        }
        builder.items(array(root.get("item"), "#/item")?, None, &auth, "#/item", 0)?;
        builder.dynamic_variables(root, "#");
        Ok(builder.result)
    }
}
impl ImportAdapter for EnvironmentAdapter {
    fn can_import(&self, source: &LoadedSource) -> bool {
        root(source)
            .get("_postman_variable_scope")
            .and_then(Value::as_str)
            == Some("environment")
            || (root(source).get("values").is_some_and(Value::is_array)
                && root(source).get("name").is_some_and(Value::is_string)
                && root(source).get("info").is_none())
    }
    fn is_environment(&self) -> bool {
        true
    }
    fn normalize_project(
        &self,
        source: &LoadedSource,
        workspace_id: &str,
        import_id: &str,
    ) -> Result<NormalizedImportResult, String> {
        let root = root(source);
        if root
            .get("_postman_variable_scope")
            .and_then(Value::as_str)
            .is_some_and(|scope| scope != "environment")
        {
            return Err("Select a Postman environment export.".into());
        }
        let name = text(root.get("name"));
        if name.trim().is_empty() || root.get("values").is_none() {
            return Err("Postman environment requires a name and values array.".into());
        }
        let mut builder = Builder::new(workspace_id, import_id, "postman-environment", &name);
        let variables = builder.variables(root.get("values"), "#/values")?;
        builder.result.resources.push(json!({"kind":"environment", "id":builder.id("environment", "#"), "name":name.trim(), "variables":variables}));
        builder.dynamic_variables(root.get("values").unwrap(), "#/values");
        Ok(builder.result)
    }
}

struct Builder<'a> {
    workspace_id: &'a str,
    import_id: &'a str,
    result: NormalizedImportResult,
}
impl<'a> Builder<'a> {
    fn new(workspace_id: &'a str, import_id: &'a str, adapter: &str, name: &str) -> Self {
        Self {
            workspace_id,
            import_id,
            result: NormalizedImportResult {
                adapter: adapter.into(),
                workspace: json!({"id":workspace_id,"name":if name.trim().is_empty(){"Postman collection"}else{name.trim()},"variables":[],"headers":[],"auth":[]}),
                resources: vec![],
                secrets: vec![],
                diagnostics: vec![],
                active_environment_id: None,
            },
        }
    }
    fn id(&self, kind: &str, path: &str) -> String {
        stable_id(
            kind,
            self.workspace_id,
            &format!("{}:{path}", self.import_id),
        )
    }
    fn warn(&mut self, code: &'static str, message: &str, path: &str) {
        self.result
            .diagnostics
            .push(warning(code, message.into(), Some(path.into())));
    }
    fn credential(&mut self, value: &str, path: &str) -> Value {
        if template_only(value) {
            return json!({"kind":"plain","value":value});
        }
        let reference = format!(
            "purr/{}/imports/postman/{}",
            self.workspace_id,
            self.id("secret", path)
        );
        self.result
            .secrets
            .push(json!({"ref":reference,"value":value}));
        json!({"kind":"secret","ref":reference})
    }
    fn variables(&mut self, input: Option<&Value>, path: &str) -> Result<Vec<Value>, String> {
        let mut names = HashSet::new();
        array(input, path)?.iter().enumerate().map(|(index, variable)| {
            let pointer = format!("{path}/{index}");
            let name = text(variable.get("key")).trim().to_owned();
            if name.is_empty() || name.contains(['{', '}']) || !names.insert(name.clone()) {
                return Err(format!("Invalid or duplicate variable name at {pointer}."));
            }
            let value = text(variable.get("value"));
            let sensitive = variable.get("type").and_then(Value::as_str) == Some("secret") || sensitive_name(&name);
            let mut definition = json!({"id":self.id("variable", &pointer),"name":name,"kind":"static","enabled":variable.get("enabled").and_then(Value::as_bool).unwrap_or(true) && !variable.get("disabled").and_then(Value::as_bool).unwrap_or(false),"sensitive":sensitive});
            if sensitive {
                // Secret variables always have a vault entry, including empty values and templates.
                let reference = format!("purr/{}/imports/postman/{}", self.workspace_id, self.id("variable", &pointer));
                self.result.secrets.push(json!({"ref":reference,"value":value}));
                definition["secretRef"] = json!(reference);
            } else { definition["value"] = json!(value); }
            Ok(definition)
        }).collect()
    }
    fn events(&mut self, owner: &Value, path: &str) -> Result<(), String> {
        for (index, event) in array(owner.get("event"), path)?.iter().enumerate() {
            if event.get("script").is_some() {
                self.warn(
                    "unsupported-script",
                    "Postman script was not imported or executed.",
                    &format!("{path}/event/{index}"),
                );
            }
        }
        if owner.get("protocolProfileBehavior").is_some() {
            self.warn("unsupported-feature", "Postman transport overrides (including redirects) were not imported; Purr transport settings apply.", &format!("{path}/protocolProfileBehavior"));
        }
        Ok(())
    }
    fn dynamic_variables(&mut self, value: &Value, path: &str) {
        match value {
            Value::String(value) if value.contains("{{$") => self.warn(
                "unsupported-feature",
                "Postman dynamic variable templates were preserved but are not generated by Purr.",
                path,
            ),
            Value::Array(values) => {
                for (index, value) in values.iter().enumerate() {
                    self.dynamic_variables(value, &format!("{path}/{index}"));
                }
            }
            Value::Object(values) => {
                for (key, value) in values {
                    if !matches!(key.as_str(), "event" | "response") {
                        self.dynamic_variables(
                            value,
                            &format!("{path}/{}", key.replace('~', "~0").replace('/', "~1")),
                        );
                    }
                }
            }
            _ => {}
        }
    }
    fn auth(
        &mut self,
        input: Option<&Value>,
        inherited: &Value,
        path: &str,
    ) -> Result<Value, String> {
        let Some(input) = input.filter(|v| !v.is_null()) else {
            return Ok(inherited.clone());
        };
        let kind = input
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("Invalid auth at {path}."))?;
        if kind == "noauth" {
            return Ok(json!({"type":"none"}));
        }
        let entries = array(input.get(kind), path)?;
        let get = |key: &str| {
            text(
                entries
                    .iter()
                    .find(|v| v.get("key").and_then(Value::as_str) == Some(key))
                    .and_then(|v| v.get("value")),
            )
        };
        let config = match kind {
            "bearer" => {
                json!({"type":"bearer","token":self.credential(&get("token"), &format!("{path}/token")),"prefix":"Bearer"})
            }
            "basic" => {
                json!({"type":"basic","username":get("username"),"password":self.credential(&get("password"), &format!("{path}/password"))})
            }
            "apikey" if matches!(get("in").as_str(), "header" | "query") => {
                json!({"type":"api-key","name":get("key"),"placement":get("in"),"value":self.credential(&get("value"), &format!("{path}/value"))})
            }
            "oauth2"
                if matches!(
                    get("grant_type").as_str(),
                    "client_credentials" | "authorization_code"
                ) && !get("accessTokenUrl").is_empty() =>
            {
                if !get("accessToken").is_empty() {
                    self.warn(
                        "unsupported-feature",
                        "Existing OAuth tokens were omitted; authorize in Purr to obtain a token.",
                        path,
                    );
                }
                json!({"type":"oauth2","grantType":get("grant_type"),"tokenUrl":get("accessTokenUrl"),"authorizationUrl":get("authUrl"),"clientId":get("clientId"),"clientSecret":self.credential(&get("clientSecret"), &format!("{path}/clientSecret")),"scopes":get("scope"),"redirectUri":get("redirect_uri"),"clientAuthentication":if get("client_authentication") == "header" {"basic"} else {"body"},"autoRefresh":true})
            }
            _ => {
                self.warn("unsupported-auth", "This Postman authentication configuration is unsupported; configure authentication in Purr.", path);
                return Ok(json!({"type":"none"}));
            }
        };
        let id = self.id("auth", path);
        let name = format!(
            "Postman auth {}",
            self.result.workspace["auth"].as_array().unwrap().len() + 1
        );
        self.result.workspace["auth"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":id,"name":name,"scope":"all","enabled":true,"config":config}));
        Ok(json!({"type":"inherit","profileId":id}))
    }
    fn protect_pair(&mut self, mut pair: Value, path: &str) -> Value {
        let value = text(pair.get("value"));
        if sensitive_name(&text(pair.get("name"))) && !value.is_empty() && !template_only(&value) {
            let id = self.id("variable", path);
            let name = format!("postman_{}", self.id("credential", path));
            let credential = self.credential(&value, path);
            self.result.workspace["variables"].as_array_mut().unwrap().push(json!({"id":id,"name":name,"kind":"static","enabled":true,"sensitive":true,"secretRef":credential["ref"]}));
            pair["value"] = json!(format!("{{{{{name}}}}}"));
        }
        pair
    }
    fn pairs(&mut self, input: Option<&Value>, path: &str) -> Result<Vec<Value>, String> {
        array(input, path)?.iter().enumerate().map(|(index, row)| {
            if !row.is_object() { return Err(format!("Invalid parameter at {path}/{index}.")); }
            let pair = json!({"name":text(row.get("key")),"value":text(row.get("value")),"enabled":!row.get("disabled").and_then(Value::as_bool).unwrap_or(false)});
            Ok(self.protect_pair(pair, &format!("{path}/{index}")))
        }).collect()
    }
    fn body(&mut self, body: Option<&Value>, path: &str) -> Result<(Value, Option<Value>), String> {
        let Some(body) = body.filter(|v| !v.is_null()) else {
            return Ok((json!({"type":"none"}), None));
        };
        if body.get("disabled").and_then(Value::as_bool) == Some(true) {
            self.warn(
                "unsupported-feature",
                "Disabled request body was omitted.",
                path,
            );
            return Ok((json!({"type":"none"}), None));
        }
        let mode = body.get("mode").and_then(Value::as_str).unwrap_or("");
        let definition = match mode {
            "" => json!({"type":"none"}),
            "raw" => {
                let language = body
                    .pointer("/options/raw/language")
                    .and_then(Value::as_str)
                    .unwrap_or("text");
                let kind = match language {
                    "json" => "json",
                    "xml" => "xml",
                    _ => "text",
                };
                json!({"type":kind,"data":text(body.get("raw"))})
            }
            "urlencoded" | "formdata" => {
                let mut fields = Vec::new();
                for (index, row) in array(body.get(mode), path)?.iter().enumerate() {
                    let pointer = format!("{path}/{mode}/{index}");
                    if !row.is_object() {
                        return Err(format!("Invalid body field at {pointer}."));
                    }
                    if row.get("type").and_then(Value::as_str) == Some("file") {
                        self.warn(
                            "unsupported-feature",
                            "Multipart file field was omitted; attach the file again in Purr.",
                            &pointer,
                        );
                        continue;
                    }
                    let mut pair = self.protect_pair(json!({"name":text(row.get("key")),"value":text(row.get("value")),"enabled":!row.get("disabled").and_then(Value::as_bool).unwrap_or(false)}), &pointer);
                    if let Some(content_type) = row.get("contentType").and_then(Value::as_str) {
                        pair["contentType"] = json!(content_type);
                    }
                    fields.push(pair);
                }
                json!({"type":if mode=="formdata" {"form-data"}else{"url-encoded"},"fields":fields})
            }
            "file" => {
                self.warn(
                    "unsupported-feature",
                    "Binary body has no imported attachment; choose the file again in Purr.",
                    path,
                );
                json!({"type":"binary","file":null})
            }
            "graphql" => {
                let graphql = body
                    .get("graphql")
                    .ok_or_else(|| format!("Missing GraphQL body at {path}."))?;
                return Ok((
                    json!({"type":"none"}),
                    Some(
                        json!({"query":text(graphql.get("query")),"variables":text(graphql.get("variables"))}),
                    ),
                ));
            }
            _ => {
                self.warn(
                    "unsupported-feature",
                    "Unsupported request body was omitted.",
                    path,
                );
                json!({"type":"none"})
            }
        };
        Ok((definition, None))
    }
    fn url(
        &mut self,
        input: &Value,
        path: &str,
    ) -> Result<(String, Vec<Value>, Vec<Value>), String> {
        if !input.is_string() && !input.is_object() {
            return Err(format!("Invalid URL at {path}."));
        }
        let mut raw = if let Some(raw) = input.as_str() {
            raw.to_owned()
        } else {
            text(input.get("raw"))
        };
        if raw.is_empty() && input.is_object() {
            let join = |key: &str, separator: &str| {
                input
                    .get(key)
                    .map(|v| {
                        if let Some(values) = v.as_array() {
                            values
                                .iter()
                                .map(|v| text(Some(v)))
                                .collect::<Vec<_>>()
                                .join(separator)
                        } else {
                            text(Some(v))
                        }
                    })
                    .unwrap_or_default()
            };
            let protocol = text(input.get("protocol"));
            raw = format!(
                "{}{}{}{}",
                if protocol.is_empty() {
                    String::new()
                } else {
                    format!("{protocol}://")
                },
                join("host", "."),
                input
                    .get("port")
                    .map(|v| format!(":{}", text(Some(v))))
                    .unwrap_or_default(),
                if input.get("path").is_some() {
                    format!("/{}", join("path", "/"))
                } else {
                    String::new()
                }
            );
        }
        let (base, fragment) = raw
            .split_once('#')
            .map(|(a, b)| (a.to_owned(), format!("#{b}")))
            .unwrap_or((raw.clone(), String::new()));
        let (base, query) = base
            .split_once('?')
            .map(|(a, b)| (a.to_owned(), Some(b.to_owned())))
            .unwrap_or((base, None));
        let params = if input.get("query").is_some() {
            self.pairs(input.get("query"), &format!("{path}/query"))?
        } else if let Some(query) = query {
            // Decode percent escapes without allowing '+' to change URL-query semantics.
            let rows = query
                .split('&')
                .map(|entry| {
                    let (key, value) = entry.split_once('=').unwrap_or((entry, ""));
                    let decode = |v: &str| {
                        Url::parse(&format!(
                            "https://import.invalid/?v={}",
                            v.replace('+', "%2B")
                        ))
                        .ok()
                        .and_then(|url| url.query_pairs().next().map(|(_, v)| v.into_owned()))
                        .unwrap_or_else(|| v.into())
                    };
                    json!({"key":decode(key),"value":decode(value)})
                })
                .collect::<Vec<_>>();
            self.pairs(Some(&json!(rows)), &format!("{path}/query"))?
        } else {
            Vec::new()
        };
        let mut base = base;
        // URL userinfo is credential-bearing; never persist it as plain URL text.
        if let Some((scheme, rest)) = base.split_once("://") {
            if let Some((userinfo, host)) =
                rest.split_once('@').filter(|(info, _)| !info.contains('/'))
            {
                let pair = self.protect_pair(
                    json!({"name":"password","value":userinfo,"enabled":true}),
                    &format!("{path}/userinfo"),
                );
                base = format!("{scheme}://{}@{host}", text(pair.get("value")));
            }
        }
        Ok((
            format!("{base}{fragment}"),
            params,
            self.pairs(input.get("variable"), &format!("{path}/variable"))?,
        ))
    }
    fn items(
        &mut self,
        items: &[Value],
        parent: Option<&str>,
        inherited: &Value,
        path: &str,
        depth: usize,
    ) -> Result<(), String> {
        if depth > 64 {
            return Err("Postman folder nesting exceeds 64 levels.".into());
        }
        for (index, item) in items.iter().enumerate() {
            let pointer = format!("{path}/{index}");
            if !item.is_object() {
                return Err(format!("Invalid item at {pointer}."));
            }
            self.events(item, &pointer)?;
            let name = text(item.get("name"));
            if let Some(children) = item.get("item") {
                let id = self.id("folder", &pointer);
                let mut folder =
                    json!({"kind":"folder","id":id,"name":if name.is_empty(){"Folder"}else{&name}});
                if let Some(parent) = parent {
                    folder["folderId"] = json!(parent);
                }
                if let Some(desc) = description(item.get("description")) {
                    folder["description"] = json!(desc);
                }
                self.result.resources.push(folder);
                if item.get("variable").is_some() {
                    self.warn("unsupported-feature", "Folder variables were not imported; define them in the workspace or environment.", &format!("{pointer}/variable"));
                }
                let auth = self.auth(item.get("auth"), inherited, &format!("{pointer}/auth"))?;
                self.items(
                    array(Some(children), &pointer)?,
                    Some(&id),
                    &auth,
                    &format!("{pointer}/item"),
                    depth + 1,
                )?;
            } else if let Some(request) = item.get("request") {
                let request = if request.is_string() {
                    json!({"url":request,"method":"GET"})
                } else {
                    request.clone()
                };
                let method = request
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or("GET")
                    .to_ascii_uppercase();
                if method.is_empty()
                    || !method
                        .bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b"_-".contains(&b))
                {
                    return Err(format!("Invalid HTTP method at {pointer}/request/method."));
                }
                let auth = self.auth(
                    request.get("auth"),
                    inherited,
                    &format!("{pointer}/request/auth"),
                )?;
                let mut headers =
                    self.pairs(request.get("header"), &format!("{pointer}/request/header"))?;
                let (url, params, path_params) = self.url(
                    request
                        .get("url")
                        .ok_or_else(|| format!("Missing URL at {pointer}/request."))?,
                    &format!("{pointer}/request/url"),
                )?;
                if request.pointer("/body/mode").and_then(Value::as_str) == Some("raw")
                    && !headers.iter().any(|row| {
                        row["enabled"] == true
                            && text(row.get("name")).eq_ignore_ascii_case("content-type")
                    })
                {
                    let language = request
                        .pointer("/body/options/raw/language")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let media_type = match language {
                        "html" => Some("text/html"),
                        "javascript" => Some("application/javascript"),
                        _ => None,
                    };
                    if let Some(media_type) = media_type {
                        headers
                            .push(json!({"name":"Content-Type","value":media_type,"enabled":true}));
                    }
                }
                let (body, graphql) =
                    self.body(request.get("body"), &format!("{pointer}/request/body"))?;
                let mut resource = json!({"kind":if graphql.is_some(){"graphql"}else{"http"},"id":self.id("request", &pointer),"name":if name.is_empty(){format!("{method} request")}else{name},"method":method,"url":url,"params":params,"pathParams":path_params,"headers":headers,"body":body,"auth":auth});
                if resource["auth"]["type"] == "none" {
                    resource["overrides"] =
                        json!({"headers":true,"auth":false,"excludedHeaderIds":[],"cookies":true});
                }
                if let Some(graphql) = graphql {
                    resource["graphql"] = graphql;
                }
                if let Some(parent) = parent {
                    resource["folderId"] = json!(parent);
                }
                let mut documentation = description(
                    request
                        .get("description")
                        .or_else(|| item.get("description")),
                )
                .unwrap_or_default();
                for (label, fields) in [
                    ("Header", request.get("header")),
                    ("Query parameter", request.pointer("/url/query")),
                    ("Path parameter", request.pointer("/url/variable")),
                    ("Body field", request.pointer("/body/urlencoded")),
                    ("Body field", request.pointer("/body/formdata")),
                ] {
                    for field in fields.and_then(Value::as_array).into_iter().flatten() {
                        if let Some(note) = description(field.get("description")) {
                            documentation.push_str(&format!(
                                "\n\n### {label}: {}\n\n{note}",
                                text(field.get("key"))
                            ));
                        }
                    }
                }
                if !documentation.is_empty() {
                    resource["documentation"] = json!(documentation);
                }
                if !array(item.get("response"), &pointer)?.is_empty() {
                    self.warn(
                        "unsupported-feature",
                        "Saved response examples were not imported.",
                        &format!("{pointer}/response"),
                    );
                }
                self.result.resources.push(resource);
            } else {
                return Err(format!(
                    "Item has neither a folder nor a request at {pointer}."
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn normalize(
        value: Value,
        environment: bool,
        import_id: &str,
    ) -> Result<NormalizedImportResult, String> {
        let source = LoadedSource {
            source: ImportSource::Text {
                name: "fixture.json".into(),
                content: value.to_string(),
            },
            name: "fixture.json".into(),
            root: "text:///fixture.json".into(),
            raw: value.to_string(),
            documents: HashMap::from([("text:///fixture.json".into(), value)]),
        };
        if environment {
            EnvironmentAdapter.normalize_project(&source, "workspace", import_id)
        } else {
            CollectionAdapter.normalize_project(&source, "workspace", import_id)
        }
    }
    fn collection(items: Value) -> Value {
        json!({"info":{"name":"Fixture","schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},"item":items})
    }
    #[test]
    fn supplied_collection_preserves_resources_and_reports_scripts() {
        let result = normalize(
            serde_json::from_str(include_str!(
                "../../../tests/fixtures/imports/postman-http-toolbox.json"
            ))
            .unwrap(),
            false,
            "first",
        )
        .unwrap();
        assert_eq!(
            result
                .resources
                .iter()
                .filter(|v| v["kind"] == "folder")
                .count(),
            5
        );
        assert_eq!(
            result
                .resources
                .iter()
                .filter(|v| v["kind"] == "http")
                .count(),
            41
        );
        assert_eq!(result.workspace["variables"].as_array().unwrap().len(), 3);
        assert_eq!(
            result
                .diagnostics
                .iter()
                .filter(|d| d.code == "unsupported-script")
                .count(),
            43
        );
        assert!(result
            .resources
            .iter()
            .all(|v| v.get("origin").is_none() && v["kind"] != "api-schema"));
        assert!(result
            .diagnostics
            .iter()
            .any(|d| d.message.contains("redirects")));
        assert!(result
            .resources
            .iter()
            .filter(|v| v["kind"] == "http")
            .all(|v| v["documentation"].is_string()));
    }
    #[test]
    fn environment_preserves_disabled_and_empty_secrets_with_fresh_ids() {
        let source: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/imports/postman-environment.json"
        ))
        .unwrap();
        let result = normalize(source.clone(), true, "first").unwrap();
        let again = normalize(source, true, "second").unwrap();
        let variables = result.resources[0]["variables"].as_array().unwrap();
        assert_eq!(variables.len(), 27);
        assert_eq!(
            variables.iter().filter(|v| v["enabled"] == false).count(),
            1
        );
        assert_eq!(result.secrets.len(), 4);
        assert_eq!(
            result.secrets.iter().filter(|v| v["value"] == "").count(),
            3
        );
        assert!(!serde_json::to_string(&result.resources)
            .unwrap()
            .contains("fixture-secret"));
        assert_ne!(result.resources[0]["id"], again.resources[0]["id"]);
        assert_ne!(result.secrets[0]["ref"], again.secrets[0]["ref"]);
    }
    #[test]
    fn nested_folders_auth_graphql_and_duplicate_disabled_rows() {
        let mut source = collection(
            json!([{"name":"Parent","item":[{"name":"Child","auth":{"type":"noauth"},"item":[{"name":"GraphQL","request":{"method":"POST","url":{"raw":"{{host}}/:id?a=wrong","query":[{"key":"a","value":"one"},{"key":"a","value":"two","disabled":true}],"variable":[{"key":"id","value":"42"}]},"header":[{"key":"X-Test","value":"a"},{"key":"X-Test","value":"b","disabled":true}],"body":{"mode":"graphql","graphql":{"query":"query { hello }","variables":"{\"x\":1}"}}}}]},{"name":"Inherited","request":{"method":"GET","url":"{{host}}/"}}]}]),
        );
        source["auth"] =
            json!({"type":"bearer","bearer":[{"key":"token","value":"literal-token"}]});
        let result = normalize(source, false, "first").unwrap();
        let parent = &result.resources[0];
        let child = &result.resources[1];
        let request = &result.resources[2];
        assert_eq!(child["folderId"], parent["id"]);
        assert_eq!(request["folderId"], child["id"]);
        assert_eq!(request["kind"], "graphql");
        assert_eq!(request["url"], "{{host}}/:id");
        assert_eq!(request["params"].as_array().unwrap().len(), 2);
        assert_eq!(request["params"][1]["enabled"], false);
        assert_eq!(request["headers"][1]["enabled"], false);
        assert_eq!(request["auth"]["type"], "none");
        assert_eq!(request["overrides"]["auth"], false);
        assert_eq!(
            result.resources[3]["auth"]["profileId"],
            result.workspace["auth"][0]["id"]
        );
        assert!(!result.workspace.to_string().contains("literal-token"));
        assert_eq!(result.secrets[0]["value"], "literal-token");
    }
    #[test]
    fn secrets_are_protected_even_in_disabled_headers_query_and_form_fields() {
        let source = collection(
            json!([{"request":{"method":"POST","url":"https://api.test/?api_key=query-secret&x=%2B&x=a+b","header":[{"key":"Authorization","value":"Bearer header-secret","disabled":true}],"body":{"mode":"urlencoded","urlencoded":[{"key":"password","value":"form-secret"},{"key":"tag","value":"one"},{"key":"tag","value":"two","disabled":true}]}}}]),
        );
        let result = normalize(source, false, "first").unwrap();
        let canonical = format!(
            "{}{}",
            result.workspace,
            serde_json::to_string(&result.resources).unwrap()
        );
        for secret in ["query-secret", "header-secret", "form-secret"] {
            assert!(!canonical.contains(secret));
        }
        assert_eq!(result.secrets.len(), 3);
        assert_eq!(result.resources[0]["params"][1]["value"], "+");
        assert_eq!(result.resources[0]["params"][2]["value"], "a+b");
        assert_eq!(result.resources[0]["body"]["fields"][2]["enabled"], false);
    }
    #[test]
    fn raw_body_is_verbatim_and_files_are_never_read() {
        let raw = "{\n  \"template\": \"{{value}}\"\n}";
        let source = collection(json!([
            {"request":{"method":"POST","url":"https://api.test","body":{"mode":"raw","raw":raw,"options":{"raw":{"language":"json"}}}}},
            {"request":{"method":"POST","url":"https://api.test","body":{"mode":"formdata","formdata":[{"key":"file","type":"file","src":"/definitely-not-readable"},{"key":"a","value":"1"},{"key":"a","value":"2","disabled":true}]}}},
            {"request":{"method":"POST","url":"https://api.test","body":{"mode":"file","file":{"src":"/definitely-not-readable"}}}}
        ]));
        let result = normalize(source, false, "first").unwrap();
        assert_eq!(result.resources[0]["body"]["data"], raw);
        assert_eq!(
            result.resources[1]["body"]["fields"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            result.resources[2]["body"],
            json!({"type":"binary","file":null})
        );
        assert_eq!(result.diagnostics.len(), 2);
    }
    #[test]
    fn malformed_and_duplicate_variables_fail_without_echoing_values() {
        let error=normalize(json!({"name":"Env","values":[{"key":"x","value":"private"},{"key":"x","value":"private2"}]}),true,"first").err().unwrap();
        assert!(error.contains("duplicate"));
        assert!(!error.contains("private"));
        assert!(normalize(collection(json!([{"request":{"url":42}}])), false, "first").is_err());
        assert!(normalize(collection(json!("bad")), false, "first").is_err());
    }
    #[test]
    fn supported_auth_templates_and_unsupported_auth_have_explicit_bindings() {
        let source = collection(json!([
            {"request":{"url":"https://test","auth":{"type":"basic","basic":[{"key":"username","value":"user"},{"key":"password","value":"password-value"}]}}},
            {"request":{"url":"https://test","auth":{"type":"apikey","apikey":[{"key":"key","value":"X-Key"},{"key":"value","value":"{{api_key}}"},{"key":"in","value":"header"}]}}},
            {"request":{"url":"https://test","auth":{"type":"oauth2","oauth2":[{"key":"grant_type","value":"client_credentials"},{"key":"accessTokenUrl","value":"{{auth_url}}/token"},{"key":"clientId","value":"client"},{"key":"clientSecret","value":"client-secret-value"},{"key":"client_authentication","value":"header"},{"key":"accessToken","value":"omit-token"}]}}},
            {"request":{"url":"https://test","auth":{"type":"digest","digest":[]}}}
        ]));
        let result = normalize(source, false, "first").unwrap();
        let profiles = result.workspace["auth"].as_array().unwrap();
        assert_eq!(profiles.len(), 3);
        assert_eq!(profiles[0]["config"]["password"]["kind"], "secret");
        assert_eq!(
            profiles[1]["config"]["value"],
            json!({"kind":"plain","value":"{{api_key}}"})
        );
        assert_eq!(profiles[2]["config"]["tokenUrl"], "{{auth_url}}/token");
        assert_eq!(profiles[2]["config"]["clientAuthentication"], "basic");
        assert_eq!(result.resources[3]["auth"]["type"], "none");
        assert_eq!(result.resources[3]["overrides"]["auth"], false);
        assert_eq!(result.secrets.len(), 2);
        assert_eq!(result.diagnostics.len(), 2);
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("omit-token"));
    }
    #[test]
    fn disabled_graphql_body_is_not_executed_and_parameter_notes_are_preserved() {
        let source = collection(
            json!([{"request":{"url":"https://test","header":[{"key":"X-Note","value":"1","description":{"content":"Header note"}}],"body":{"mode":"graphql","disabled":true,"graphql":{"query":"mutation { change }"}}}}]),
        );
        let result = normalize(source, false, "first").unwrap();
        assert_eq!(result.resources[0]["kind"], "http");
        assert_eq!(result.resources[0]["body"]["type"], "none");
        assert!(result.resources[0]["documentation"]
            .as_str()
            .unwrap()
            .contains("Header note"));
        assert_eq!(result.diagnostics.len(), 1);
    }
    #[tokio::test]
    async fn dispatch_checks_destination_and_does_not_resolve_postman_refs() {
        let source = collection(
            json!([{"request":{"url":"https://api.test","body":{"mode":"raw","raw":"{\"$ref\":\"private-file\"}"}}}]),
        );
        let source = ImportSource::Text {
            name: "postman.json".into(),
            content: source.to_string(),
        };
        assert!(import(
            source.clone(),
            "workspace".into(),
            ImportTarget::Environment,
            "first".into()
        )
        .await
        .is_err());
        let result = import(
            source,
            "workspace".into(),
            ImportTarget::Workspace,
            "first".into(),
        )
        .await
        .unwrap();
        assert_eq!(result.adapter, "postman-collection");
    }
}
