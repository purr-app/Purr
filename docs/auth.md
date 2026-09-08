# Authentication in Purr

Run `yarn tauri dev` (or `npm run tauri dev`) for HTTP requests and OAuth. `yarn dev` previews the UI only: it does not emulate native networking or silently fall back to browser fetch.

## Request authentication

- **None** adds no generated authentication. Explicit manual headers and the independently enabled cookie jar still apply.
- **Bearer Token** accepts a token with or without the `Bearer` prefix, masks it by default, and provides reveal/copy. The prefix can be Bearer, Token, or empty. JWT inspection decodes the header/claims locally and shows expiry; it does **not** verify signatures.
- **Basic Auth** generates `Authorization: Basic base64(UTF-8(username:password))`. The password supports reveal/copy. Colons in usernames are rejected.
- **API Key** uses a single form with **Add to: Header / Query param / Cookie**. Query and cookie values are encoded for their target. Transport-owned headers cannot be used as API key destinations.
- **OAuth 2.0** supports Client Credentials and Authorization Code + PKCE (S256). Refresh Token is a behavior of OAuth, not another auth type.
- **Inherit** resolves the active environment before the workspace, or explicitly chooses either. Credentials are resolved at send time without copying. Missing sources and cycles are reported. `AuthContext` accepts profiles today; a workspace/environment management UI is not part of this implementation.

Auth-generated headers and query parameters are read-only in their editors. Secret values are masked and can be revealed explicitly. Manual values are retained underneath and return when the auth type changes. API key query parameters are applied to the outgoing URL at send time.

Credential fields support `{{VARIABLE_NAME}}` references through `AuthContext.variables`. Missing variables fail visibly instead of being sent literally. The environment editor is future work.

## OAuth setup and lifecycle

For Client Credentials, enter Token URL, Client ID, Client Secret and optional space-separated Scopes, then **Fetch & use token**. Client credentials can be sent in the form body or with HTTP Basic authentication, according to the provider. The resulting Bearer token is applied to the request's `Authorization` header.

For Authorization Code + PKCE, also enter Authorization URL and register the exact **Callback URL** with your provider. The default is `http://127.0.0.1:8976/oauth/callback`. Purr listens only on IPv4 loopback, opens the system browser, checks state and callback path, and exchanges the code with the PKCE verifier. Client Secret is optional. Cancellation, occupied ports, provider denial and a three-minute timeout are handled. Custom URI callbacks and device/password grants are not implemented.

**Refresh automatically** renews shortly before expiry (10% of the lifetime, capped at 30 seconds). It continues while other request section tabs are open. Client Credentials obtains a new token; Authorization Code uses the issued refresh token. Rotated refresh tokens replace the old value; when a refresh response omits it, the previous refresh token is retained. The request send path also checks expiry. A failed automatic refresh pauses automatic retries until an explicit retry/configuration change; the token endpoint's raw response is not put in errors.

Only Bearer access tokens are accepted. Tokens without an expiry cannot be scheduled, but can be refreshed manually. OAuth endpoints require HTTPS except on loopback/localhost for development. Token exchanges do not follow redirects. In-flight results are discarded after cancellation or client-configuration changes.

The native browser flow follows [OAuth for Native Apps (RFC 8252)](https://www.rfc-editor.org/rfc/rfc8252.html) and the grants/client authentication follow [OAuth 2.0 (RFC 6749)](https://www.rfc-editor.org/rfc/rfc6749.html).

## Session cookies

Cookies are opened with the standalone **Cookies** button on the right side of the request-options row. **Use cookie jar** independently controls capture and sending on a request. The jar uses [tough-cookie](https://github.com/salesforce/tough-cookie) for domain/path, expiry, public suffix and cookie-prefix validation.

Purr collects all `Set-Cookie` headers, including on intermediate redirects, and sends matching cookies. Secure cookies require HTTPS; HttpOnly is retained and permits HTTP transmission. SameSite=None requires Secure. A direct request is treated as same-site; a cross-site redirect chain excludes Strict/Lax and unspecified (Lax by default) cookies. Cross-origin redirects also drop explicit Authorization, API-key and Cookie credentials. HTTPS-to-HTTP redirects are rejected.

Cookies can be added, edited, disabled and deleted, with domain, path, host-only, Secure, HttpOnly, SameSite and optional expiry controls. A disabled cookie remains disabled if the server updates it. Manually specified cookies override matching jar cookies by name.

Tokens, cookie contents and credentials are **in memory for the current session only**. They are not persisted in localStorage, files or an OS vault. Restarting/reloading clears them; persistent encrypted storage will need a separate lifecycle and workspace design.

## Response-derived tokens

Bearer's **Use token from response** mode watches one endpoint path, such as `/auth/token`, and extracts a string using a jq-style property path such as `.access_token`, `.auth.token`, or `.items[0].token`. `$response.auth.token` is accepted as a friendly equivalent. Quoted bracket keys are also supported.

Every matching response replaces the previous in-memory token. Requests to the configured token endpoint are sent without the generated Bearer header, allowing that request to acquire the first token; other endpoints use the latest captured token. This is response chaining, not a background request scheduler.

## Verification

- `yarn test`: auth resolution, encoding, managed field preservation, PKCE vector, OAuth exchange/rotation/error handling, cookie policies, redirect handling, and existing Body tests.
- `yarn test:ui`: forms, masking, disabled headers/params, responsive layout, request injection/cookie capture, response-token automation, background renewal, stale async results and PKCE exchange. Native calls are stubbed in these browser tests.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`: callback validation and native transport round-trip against a local TCP server, preserving binary bodies and repeated Set-Cookie headers.

Real provider authorization still requires that provider's registered client and callback configuration. No external account credentials are bundled in tests.
