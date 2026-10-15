# Secret transfer and recovery

Purr desktop supports four distinct operations. **Export workspace** is under **Workspace settings → General**; selected secret export/import and Recovery are under **Secrets and encryption**. Export workspace opens the native folder picker directly after pending saves finish; its inline description explains which data is excluded. Browser preview exposes transfer and recovery as unavailable. Windows/Linux credential providers and real cross-OS acceptance remain later work.

| Operation | Contents | Destination |
| --- | --- | --- |
| Export workspace | Saved project YAML and referenced assets; declarations keep SecretRefs | New empty directory; Git-friendly |
| Export selected secrets | Selected saved credential values, including literal template expressions | Password-protected `.purrsecrets` file |
| Export recovery key | Workspace credential scope keys and authenticated identities/keychecks | Separate password-protected file |
| Export credential backup | Saved-declaration credential ciphertext rows and omission metadata | Separate password-protected file |

These are not full-profile backups. Globals, drafts, inactive editor values, cookies, runtime OAuth sessions, history, responses, installation keys and runtime keys are excluded. Public fields/assets are public because the canonical model classifies them that way; exporting configuration cannot discover secrets a user placed in public text. Credentials are collected only from typed positions, never recursively from opaque integration/extension config.

## Transfer flow

Save credential owners before exporting. Pending autosaves are flushed; unsaved request drafts are not promoted to saved definitions. Available secrets start selected; deselect any you do not want to transfer and choose a password of at least 12 Unicode characters and at most 1024 UTF-8 bytes. The eye reveals one saved value on demand without changing selection. Export and import use compact text lists on a shared neutral surface. The dialog validates the password and confirmation as they are typed, and keeps selection across search filters. Native inventory labels include owning variable names. Export requires confirmation; spaces and Unicode are preserved exactly. New blank sensitive variables are declarations with missing values, and the local-secret manager rejects an empty replacement; use Remove to make an existing value missing. Older available empty values remain readable and can still be transferred without changing their meaning. A missing credential is never serialized as empty. Unselected declarations are listed as omissions. Unavailable values appear in a separate section with the reason and an explicit omission option.

Copy configuration to the destination first and attach the same workspace identity. Import only targets a copy with the same workspace ID and SecretRefs. Packages cannot map credentials into an arbitrary new workspace. In Import secrets, choose the encrypted file first, then enter its password. Native code holds bounded encrypted file bytes behind a short-lived, window- and workspace-bound ID; encrypted file bytes stay native. A wrong password leaves the file selection available for retry. The entire file is authenticated before a preview is returned. Values never appear in that metadata preview. The eye action explicitly reveals one incoming value through a separate typed IPC call, bound to the preview, requesting window, workspace and five-minute expiry. Consumed or cancelled previews cannot reveal values. The UI hides the revealed value again on hide, close, expiry or completion; recovery keys never cross IPC. Missing declared values are selected by default; existing values default to Keep and require explicit Replace. Unknown declarations are disabled until configuration is updated; packages created by this version include an encrypted human-readable source label so the skipped secret can be identified. Older packages without that label display a generic description.

Expressions are copied verbatim. Dependency metadata identifies referenced names and declarations that may need destination configuration; no template resolution, dynamic request or network access occurs during export/import. Globals are not bundled. A selected secret expression can therefore require separately provisioned dependencies.

Preview capabilities expire after five minutes and are bound to their native window and workspace. Closing/cancelling, expiration or window destruction removes staged values. Import validates saved-definition revisions and destination credential revisions, then publishes the selected batch through the same transactional coordinator as Save. Imports do not change active destination keys. Autosave and imports share the frontend persistence queue; cached values and unchanged imported editor buffers are invalidated without discarding pending edits.

A conflict requires a new preview. If a reply is lost, **Check outcome** uses the retained operation ID and durable receipt. Cancellation before publication leaves values unchanged; a completed durable commit remains committed even if cancellation arrives later. An unknown result is never described as a rollback.

## Recovery

Recover secrets first asks for the recovery-key file and matching credential-backup file, then their passwords. Both encrypted files remain native behind one window- and workspace-bound capability for five minutes (maximum 64 MiB per file and four staged selections). Cancelling either picker retains neither file. Wrong passwords keep the selection for retry; successful preview consumes it. Closing the dialog, cancelling the selection, expiry, or closing its window releases both buffers.

Keep both **Export recovery key** and **Export credential backup**, together with their passwords. A recovery key alone cannot reconstruct values from a Git clone. Update the credential backup after changing secrets; export another recovery key after credential-key changes. Key packages grant access to matching credential ciphertext, so treat them more carefully than a selected-value package.

**Recover secrets** opens the key package and then the matching credential backup. Native code validates container purpose, workspace, key identity, keycheck, ciphertext identity/purpose/ref and all values before preview. It decrypts using the temporary source credential keys, without the source installation root or source database. Import re-encrypts selected values using current destination keys. Source keys never replace entries in the destination key registry. An unavailable destination credential key must still be unlocked/repaired before import; recovery is not a bypass for destination key custody.

The backup is a versioned detached ciphertext bundle, not an arbitrary SQLite reader. It does not restore runtime/history/cookie data. S06 introduces no SQLite schema change, profile reset, old-workspace migration or new OS key identity.

## Container v1

Implementation: `src-tauri/src/transfer/codec.rs`. All numeric header fields use big-endian byte order. No compression or executable content is supported.

| Offset | Length | Field |
| --- | --- | --- |
| 0 | 8 | Magic `PURRSEC\0` |
| 8 | 1 | Version: 1 |
| 9 | 1 | Kind: 1 selected values, 2 recovery keys, 3 credential backup |
| 10 | 16 | Four u32 values: Argon2 version 19, memory 65536 KiB, iterations 3, parallelism 4 |
| 26 | 16 | Random KDF salt |
| 42 | 12 | Random archive-key wrapping nonce |
| 54 | 7 | Random STREAM nonce prefix |
| 61 | 8 | Plaintext payload length |
| 69 | 48 | AES-256-GCM encrypted random 32-byte archive key, including 16-byte tag |
| 117 | variable | Authenticated payload chunks |

Argon2id produces a 32-byte password wrapping key. AES-256-GCM wraps an independent random archive key with the 69-byte header as associated data. RustCrypto `aead-stream` STREAM BE32 encrypts the payload with that archive key: 64 KiB plaintext chunks, 16-byte tags, authenticated chunk counter and final marker. Header plus wrapped key are associated data on every chunk. Even an empty payload has a final authenticated chunk. Decoder rejects unexpected EOF, changed order/content/header/kind, missing final authentication and trailing bytes before exposing any plaintext to the service.

V1 accepts only this fixed KDF profile; hostile cost parameters are rejected before KDF allocation. Limits: 64 MiB file, 32 MiB serialized plaintext, 10,000 credential entries, 1 MiB UTF-8 per value; key packages allow at most 128 credential keys. JSON payloads carry their own version and workspace ID, entries/rows/keys and applicable omissions/dependencies. The header necessarily reveals package purpose, KDF profile and payload length; values, names and refs are encrypted.

Selected entries contain `{ref, value}` and an optional encrypted display label. The optional field is backward-compatible with earlier v1 packages; it is never used to authorize import. Credential backup rows contain ref, crypto version, nonce and the original scoped ciphertext envelope; the whole bundle has a second password-encryption layer. Recovery keys contain their original scoped identities and keychecks, authenticated inside the password container. Stored credential-envelope details are documented in [Database structure](database-structure.md).

## Files, memory and limits

Export writes ciphertext into a temporary sibling file, flushes/syncs it and publishes by rename. It never stages a plaintext secret export. Configuration export separately stages public canonical files and publishes into the chosen empty directory. It excludes unreferenced assets and unrelated files; symlinks are not followed and unsafe referenced paths are rejected. Definition reads are limited to 4 MiB per file, 32 MiB total and 10,000 files; referenced assets are limited to 64 MiB each and 512 MiB total.

Chunk encryption is streamed to the file, but bounded JSON payloads and authenticated import plaintext are assembled in memory. This is not constant-memory archive processing. Rust plaintext/key buffers and Argon2 working memory use explicit zeroization where owned; frontend password strings and serialization/library copies cannot promise complete memory erasure. Passwords/values are not intentionally logged or copied to the clipboard. Encryption at rest does not protect an unlocked running application from a compromised process or OS.

Cryptographic primitives and construction come from RustCrypto; this implementation has automated adversarial tests, not a claimed independent security audit. Tests use synthetic temporary vaults and mock UI adapters. Real file-picker behavior, signed macOS prompt trust and eventual Windows/Linux interoperability require device acceptance separately.

Manage local secrets uses a compact searchable list. Value fields are disabled until the pencil action starts an empty replacement; Save is explicit. The eye reveals one value without editing it. Values and replacement buffers are discarded when the manager closes.

The secret manager filters variables, request values and other credential fields. New secret explicitly creates a sensitive static variable in workspace scope, regardless of the active environment, using the normal transactional save path. Its footer counts inspected nonempty saved values. Transfer dialogs group search/selection, individual masked values and passwords; password fields have explicit reveal controls.
