# Environments, variables, and secrets

This document is the source of truth for variable scopes, interpolation, dynamic-request dependencies, caches, and secret-variable storage. Auth credentials use the same `SecretRef` boundary but are detailed in [Authentication and cookies](auth.md).

## Runtime and canonical models

`Variable` in `src/features/workspaces/model/workspace.ts` is the runtime form. `VariableDefinition` in `src/domain/project.ts` is the canonical form. Supported discriminants are:

- `static`: a plain or sensitive literal;
- `dynamic-request`: a value extracted from a saved request’s JSON response;
- `external-secret`: a provider/key reference reserved for a future provider adapter.

Environments are canonical `EnvironmentDefinition` resources containing static variables only. Workspace variables can be static or dynamic-request. Global variables are application-local definitions, not part of any project repository, and are currently restricted to static variables.

## Scopes and effective namespace

`getVariableNamespace` concatenates scopes in this order:

```text
global → workspace → selected environment
```

`getEffectiveVariables` uses name-keyed replacement, so a later enabled definition would win defensively. Normal product state avoids relying on that precedence:

- names must be unique inside each scope;
- workspace names cannot overlap environment names;
- the Variables UI also prevents global names from overlapping any workspace/environment effective namespace;
- dynamic resolution rejects any ambiguous duplicate name, enabled or disabled.

Disabled variables are omitted from the effective value map. If a request explicitly references a disabled definition, `resolveDynamicVariables` reports it instead of treating it as missing or falling back silently.

The active environment ID is workspace-local state. A dynamic variable may use the request’s current environment or a specific environment ID. Changing the active environment lazily unlocks that environment’s sensitive values and clears document OAuth tokens.

## Static interpolation

Templates use `{{name}}`. `resolveEnvironmentValue` recursively expands nested static references, rejects missing names, and rejects cycles/depth beyond 32.

`resolveRequestEnvironment` resolves only fields that can affect the active outgoing request:

- URL and enabled query/path rows;
- enabled headers;
- GraphQL query, operation name, and variable JSON;
- active JSON/XML/text body or enabled form fields;
- active auth inputs through auth resolution.

Disabled rows and inactive body/auth modes are deliberately ignored at send time. The stored/canonical request keeps templates; resolution creates an effective copy.

## Dynamic-request variables

A dynamic variable definition names:

- a saved HTTP or GraphQL source document ID;
- jq-subset or JSONPath-subset extraction expression;
- refresh policy `every-time`, `session`, or `cache`;
- optional positive TTL for `cache`;
- current or specific source environment;
- whether the extracted value is sensitive.

`resolveDynamicVariables` scans the root request’s active template text and recursively follows static-variable references. Only dynamic variables actually needed by that graph execute. For each source request it:

```text
resolve that request's effective namespace
  → resolve its own dynamic dependencies
  → execute the source request through normal request/auth/cookie transport
  → require JSON response text
  → queryResponseJson(expression, language)
  → stringify scalar/object result for {{name}}
```

Missing/unsaved source requests, disabled dependencies, JSON parse failures, extraction failures, and document cycles stop the root request before it is sent. `inspectDynamicVariableGraph` provides the side-effect-free dependency preview used by the Variables UI.

The extraction languages are the same limited evaluator used by the response viewer, not full jq/JSONPath implementations. See [Response lifecycle](response-lifecycle.md).

## Cache behavior

Cache keys are `${variableId}:${environmentId ?? "none"}`. The definition’s JSON fingerprint invalidates entries when its source, expression, refresh policy, sensitivity, or environment changes.

- `every-time`: executes once per root resolution run; a stored entry can be shown diagnostically but is not reused on the next run.
- `session`: reuses an in-memory workspace/session map during the running application; persisted diagnostic data is not used as a new-session hit.
- `cache`: reuses a successful encrypted local entry while its fingerprint matches and its TTL has not expired.

Errors are recorded with message, timestamp, duration, environment, and fingerprint, but never used as successful hits. Editing/deleting variables or environments prunes invalid entries. A forced Execute from the Variables UI bypasses an existing hit for that variable.

Sensitive successful cache values are replaced with secret-backed envelopes by `protectDynamicVariableCache` before the local record is encrypted. They are restored transiently through `resolveRuntime` when the workspace opens.

## Secret is not masked

`sensitive: true` is a storage/security decision, not just a UI mask.

For a sensitive static variable:

```text
runtime Variable.value
  → storeCredential(SecureStore, stable SecretRef)
  → canonical VariableDefinition contains secretRef only
  → secret value stored in encrypted SQLite secret_values
```

`SecretRef` has a validated `purr/<workspace>/<owner>/<field>` shape. Global variables use the `purr/global/...` namespace. Workspace/environment YAML contains the stable reference and metadata, never the value. The frontend resolves values only when needed and may hold them transiently in runtime state; UI masking alone must never be treated as persistence protection.

On macOS, `NativeSecureStore` calls Rust `secure_*` commands. The Keychain stores one root encryption key (`purr/local-storage/master-key-v1`); individual secret values live in the separately keyed AES-GCM SQLite vault. Non-macOS native secure storage currently fails closed. Browser development uses its preview secure adapter and is not the desktop security contract.

## External secret providers

`external-secret {provider,key}` is present in the canonical type so future integrations need not change request templates. There is currently no provider registry, resolver, authentication flow, or UI capable of producing its value. Treat it as reserved and fail explicitly if execution would require it. When a provider becomes real, document its lookup, cache, permission, error, and redaction boundaries in [Imports and integrations](imports-and-integrations.md).

## Persistence summary

- Workspace and environment plain definitions: canonical Git-friendly YAML.
- Workspace/environment sensitive definition: canonical YAML with `SecretRef`; value in secure vault.
- Global definitions: encrypted application-local state; sensitive values still in secure vault.
- Active environment: encrypted workspace-local state.
- Dynamic `every-time`/session status and cache entries: encrypted workspace-local state; only TTL cache is reusable across sessions.
- Sensitive dynamic cache values: secure-vault refs embedded inside encrypted local cache payload.

See [Persistence architecture](persistence-architecture.md) for the full ownership table.

## Invariants

- Do not serialize runtime secret values into YAML, drafts, logs, history metadata, or clipboard output.
- Preserve stable variable IDs and secret refs when editing; deleting a definition should release unused refs.
- Dynamic source documents must be saved canonical requests.
- Environment variables remain static until the canonical validator, resolver, UX, and documentation change together.
- Cache identity includes environment and definition fingerprint.
- A disabled or ambiguous variable must fail clearly when referenced.

## Key files

- `src/features/workspaces/model/workspace.ts` — runtime variable/environment types, namespace assembly, validation, and effective values.
- `src/features/workspaces/model/environment.ts` — active request-field interpolation.
- `src/features/workspaces/services/dynamic-variable-resolver.ts` — dependency graph, execution, extraction, cache identity, and cycles.
- `src/features/workspaces/components/variables-explorer.tsx` — scope editor, duplicate rules, dependency preview, reveal, and forced execution.
- `src/features/workspaces/components/environment-editor.tsx` — environment definition UI.
- `src/shared/lib/resolve-variables.ts` — recursive `{{name}}` resolver.
- `src/domain/project.ts` — canonical variable/environment/SecretRef schemas and cross-resource validation.
- `src/application/environment-secrets.ts` — lazy environment-secret resolution.
- `src/application/project-projection.ts` — variable projection and sensitive cache protection.
- `src/storage/secrets.ts` — stable refs, `SecureStore` helpers, and runtime secret envelopes.
- `src/storage/native-backend.ts` — `NativeSecureStore` IPC adapter.
- `src-tauri/src/secure_store.rs` — Keychain root and derived ciphers.
- `src-tauri/src/local_state.rs` — encrypted secret-values vault.
