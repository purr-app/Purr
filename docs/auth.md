# Authentication and cookie jar

This document owns authentication schemes, OAuth token lifecycle, credential storage, and the workspace cookie jar. The exact point where auth joins URL/header/body composition is described in [Request lifecycle](request-lifecycle.md).

## Authentication model

`RequestAuth` keeps every auth editor form in runtime and chooses one active `type`:

- `none`;
- `bearer` with configurable HTTP auth-scheme prefix;
- `basic`;
- `api-key` in a header, query parameter, or cookie;
- `oauth2` using Client Credentials or Authorization Code with PKCE;
- `inherit`.

The canonical `AuthDefinition` stores only the active scheme. Inactive editor forms are local session state and their credential fields are protected through `protectRuntime` before the local record is written.

`resolveAuth` follows inheritance through `AuthContext`. The runtime type can represent workspace or environment profiles, but current product configuration exposes workspace shared auth; environments currently contain variables only. Cycles and missing inherited profiles fail before transport.

## Effective bindings

`getAuthBinding` produces at most one managed binding:

- Bearer/custom token and Basic → `Authorization` header;
- API key → configured header/query/cookie;
- OAuth 2.0 → `Authorization: Bearer <access token>`.

Auth input values support `{{variable}}` interpolation. Validation rejects whitespace in bearer tokens, invalid token/header names, colon in Basic username, unsafe control characters, empty API-key names/values, and API-key attempts to own restricted transport headers. Basic credentials are UTF-8 then Base64 encoded.

The managed binding replaces a same-name manual row only in the effective request. The original row remains in the editor/persistence model and returns if auth changes. API-key cookie mode contributes to the manual/effective Cookie header and therefore wins over a same-name jar cookie.

Workspace shared auth entries have `all`, `http`, or `graphql` scope. Exact kind wins over `all`, overlapping scopes are invalid, and requests can opt out. The effective workspace config is assembled without mutating the saved request.

## Credential storage and redaction

`authToDefinition` converts credential-bearing fields to `Credential` values:

- `{kind: "secret", ref: SecretRef}` by default;
- bearer tokens may explicitly use `{kind: "plain", value}` when configured or when a templated value must remain shareable as a template.

Passwords, API keys, OAuth client secrets, acquired access/refresh tokens, and ordinary literal bearer tokens use the secure path. Project YAML contains refs/definitions, not their values. The macOS Keychain owns one root key; encrypted SQLite `secret_values` owns individual ref values. See [Persistence architecture](persistence-architecture.md).

`prepareWireRequest` builds a real and a masked display request. Response → Request, Timeline, and Request Code default to the masked version. Copy can expose credentials only after an explicit Reveal action. Native error strings are sanitized and OAuth token response bodies are never included in user-facing errors.

## OAuth 2.0 lifecycle

`services/oauth-client.ts` implements two grants.

### Client Credentials

`fetchOAuthToken` sends an URL-encoded POST to the token endpoint. Client authentication is either request-body `client_id`/`client_secret` or HTTP Basic. It validates a JSON success response, accepts only Bearer token type, validates expiry, and retains a previous refresh token when a refresh response omits one.

### Authorization Code with PKCE

`authorizeOAuth` creates a random state and S256 PKCE verifier/challenge, opens the system browser through Rust, and waits for a loopback callback. The redirect must be `http://127.0.0.1:<port>/...` without query/fragment. `src-tauri/src/oauth.rs` binds the callback listener, verifies state, and returns the authorization code; cancellation is a separate `cancel_oauth` command.

OAuth endpoints require HTTPS except `localhost`, `127.0.0.1`, or `::1` for development, and endpoint fragments are rejected. Browser development cannot perform the native authorization callback.

### Token ownership

`executeRequest` acquires an initial token when necessary and refreshes an expired token when auto-refresh and a refresh token allow it. In-flight results are accepted only when the OAuth configuration identity still matches.

Saved OAuth configuration is canonical with secret-backed client credentials. Acquired access/refresh tokens are runtime state in the versioned `workspace_local_state/auth-runtime` record and their values remain in the secret vault. The definition hash prevents a token acquired for an old config from being attached to a changed definition. Switching environment clears document OAuth tokens.

## Cookie jar as a runtime entity

Each workspace owns one `SessionCookieJar` backed by `tough-cookie`’s in-memory store. It is not a canonical project resource and is never shared through Git. `Workspace.cookies` is the serializable snapshot used for local persistence and the Cookies workspace tab.

The jar records stable identity from domain, path, and name plus value, Secure, HttpOnly, SameSite, expiry, host-only, and enabled state. Expired or invalid persisted cookies are ignored on restore. Users can create/edit, enable/disable, and delete entries; validation enforces cookie token/value syntax, path, host, and `SameSite=None` + Secure.

### Request matching and precedence

Immediately before every HTTP hop, `executeHttp` asks the jar for cookies matching URL, domain/host, path, Secure, expiry, disabled state, and SameSite context. HttpOnly cookies are intentionally eligible because Purr is an HTTP client, not page script.

Manual Cookie headers and auth/API-key cookie bindings are merged with jar cookies. For duplicate names, explicit request cookies win. A request can turn off the jar with `useCookieJar`/canonical `overrides.cookies`; manual cookies still remain part of that request.

### Redirects and Set-Cookie

Every hop’s repeated `Set-Cookie` headers are passed to `SessionCookieJar.receive`, including redirect responses. `tough-cookie` rejects foreign-domain and otherwise invalid cookies; Purr additionally rejects insecure `SameSite=None`. A bad cookie cannot fail the HTTP response.

Cross-site redirects request jar cookies with the restrictive `none` context used by the current policy. Cross-origin redirects strip explicit Cookie and other sensitive headers before the next hop. HTTPS-to-HTTP redirects are blocked. Redirect policy is TypeScript-owned because native Reqwest redirects are disabled.

### Persistence and encryption

`projectWorkspace` emits one `cookie_jar` local record per cookie. Rust encrypts the record payload, including the value. `cookie_metadata` stores the searchable workspace/id/name/domain/path/flags/expiry metadata in SQLite columns; those metadata columns are local but not encrypted. The cookie value is not placed in that metadata table or project files.

`EncryptedCookieJarStore` is a narrower storage adapter available for cookie-only replacement, while normal workspace saves currently project the jar through `projectWorkspace`.

## Response-derived values

The JSON response context menu can create a sensitive static variable or a dynamic-request variable. It does not silently rewrite request auth. The user explicitly references the variable from bearer/API-key/OAuth fields, after which normal variable, secure-store, and redaction rules apply.

## Invariants

- Never equate masking with secure storage.
- Never persist acquired OAuth tokens in project YAML.
- Do not let Rust or a second caller reconstruct auth independently of `getAuthBinding`/`executeRequest`.
- Keep cookie matching/capture in the shared TypeScript redirect loop; do not enable native automatic redirects behind it.
- Preserve manual-over-jar cookie precedence and request jar opt-out.
- Do not expose OAuth response bodies or real wire credentials in default UI, logs, errors, history metadata, or clipboard output.

## Key files

- `src/features/request-workbench/model/request-auth.ts` — runtime auth forms, inheritance, variable resolution, validation, and managed bindings.
- `src/features/request-workbench/components/auth-editor.tsx` — active auth selection and forms.
- `src/features/request-workbench/hooks/use-auth-runtime.ts` — OAuth acquisition/cancellation state in the UI.
- `src/features/request-workbench/services/oauth-client.ts` — PKCE, token exchange, refresh, and endpoint policy.
- `src/features/request-workbench/services/execute-request.ts` — auth resolution and token use in request execution.
- `src/features/request-workbench/model/cookie-jar.ts` — matching, capture, edit/delete/disable, and serializable jar state.
- `src/features/request-workbench/services/http-client.ts` — per-hop cookie merge, redirects, and Set-Cookie capture.
- `src/features/request-workbench/components/cookie-jar-editor.tsx` — workspace cookie management UI.
- `src/application/project-projection.ts` — canonical auth, auth runtime, cookies, and secure refs.
- `src/storage/cookie-jar-store.ts` — cookie-specific local adapter.
- `src/storage/secrets.ts` — credentials and protected runtime envelopes.
- `src-tauri/src/oauth.rs` — native browser callback boundary.
- `src-tauri/src/secure_store.rs` — Keychain root-key boundary.
- `src-tauri/src/local_state.rs` — encrypted local records and secret vault.
