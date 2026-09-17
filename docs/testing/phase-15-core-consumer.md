# Phase 15: public core composition verification

The fixture in `tests/fixtures/core-consumer/` represents a sibling official-build repository. It has its own frontend entry, native entry, Tauri configuration, capability manifest, icon and plugin crate. It consumes built package exports and the public Rust crate surface; it does not copy Purr application source.

## Automated boundary checks

From the repository root run:

```sh
npm run check:core-package
npm run check:core-determinism
```

The first command builds `dist-core`, type-checks and bundles the external frontend, checks every package export, verifies React resolves once and remains external to the core library, scans the fixture for unsupported imports, and compiles the external Tauri shell/provider/plugin. The second command builds the core artifact twice and compares every emitted file by path and SHA-256. These commands do not launch a desktop window.

## Launch the external consumer

Build the frontend, then run the fixture binary:

```sh
npm run build:consumer
cargo run --manifest-path tests/fixtures/core-consumer/src-tauri/Cargo.toml
```

Use a disposable workspace. In the launched app:

- Open **External consumer** in the extension navigation. **Run module service** increments the counter without changing core workspace state. **Call native plugin** reports `consumer native plugin ready`.
- Return to **Workbench**, create a workspace, use the new-document menu to create **External protocol**, edit Message, switch documents and return. The value remains in the extension document.
- Open Workspace settings → Integrations, add **Consumer trace provider**, rename it if desired and save. It appears once with the `traces` capability and no credential slot.
- Send any ordinary request, open Trace, select the consumer provider, enter manual trace ID `0123456789abcdef0123456789abcdef`, then load. One normalized `fixture.trace` span from service `external-consumer` appears.
- Confirm the core UI typography/theme and extension controls render normally and the developer console has no duplicate-React hook error.

Stop the fixture. Launch ordinary OSS Purr with `npm run tauri dev`; existing REST/GraphQL, persistence, download and OAuth behavior must remain available without the consumer fixture process or source.

The fixture Cargo manifest lists `tauri-plugin-dialog` and `tauri-plugin-opener` directly even though the public core initializes them. Tauri discovers ACL manifests from the final binary dependency graph; omitting those direct dependencies makes the external capability manifest invalid at build time.
