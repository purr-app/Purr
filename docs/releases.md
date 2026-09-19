# Versioning and releases

Purr uses [Changesets](https://github.com/changesets/changesets) for release intent and a GitHub Actions release job for immutable tags and GitHub Releases. `package.json` is the version source of truth. Release automation copies that version to the npm lockfile, Cargo manifest and lockfile, and Tauri configuration.

The repository does not derive versions or release notes from commit messages. Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, and `chore:` are welcome because they make history readable, but they are not required. A changeset is explicit about both SemVer impact and the user-facing description, so squash merges and maintenance commits cannot accidentally change a release version.

## Add a change

For a user-visible change or a public TypeScript/Rust contract change, run:

```bash
npm run changeset
```

Select `@purr/core`, then select:

- `patch` for a compatible fix, performance improvement, or internal change worth mentioning;
- `minor` for a new capability or a breaking extension API change while Purr remains below `1.0.0`;
- `major` only for an intentional stable major release.

Write the summary in user-facing language. It becomes part of `CHANGELOG.md` and the GitHub Release body, so describe the resulting behavior rather than the implementation process. Commit the generated `.changeset/*.md` file with the code. Documentation-only, test-only, and CI-only changes may omit a changeset. Multiple pull requests can accumulate before a release; their highest requested SemVer impact wins.

Use these checks while developing:

```bash
npm run changeset:status
npm run check:repo
```

Do not manually edit version fields. Do not run `npm run release:version` as part of a normal feature pull request because it consumes all pending changesets.

## Prepare and publish a release

Every successful Public CI run on `main` starts the release job:

1. If pending changesets exist, `changesets/action` creates or updates the `chore: release Purr` pull request.
2. That pull request consumes the changesets, updates `CHANGELOG.md`, increments `package.json`, and runs `scripts/sync-release-version.mjs --write` to synchronize npm, Cargo, and Tauri metadata.
3. Review the proposed version and changelog. Merge the release pull request when that version should become public.
4. Public CI validates the merged release commit. Only after secret scanning, tests, type checking, lint, Rust checks, dependency audits, and the unsigned OSS bundle build pass does the release job continue.
5. With no pending changesets and no existing release for the current version, `scripts/create-github-release.mjs` creates the immutable `vN.N.N` tag at the validated commit and publishes a GitHub Release using that version's `CHANGELOG.md` section.

The workflow is idempotent: rerunning it does not move an existing tag or recreate an existing release. If a tag already points elsewhere, it fails instead of retagging history. A manual **Run workflow** entry exists for recovery, but normal releases need no manual dispatch.

The initial `v0.1.0` tag and GitHub Release are a manual bootstrap. Until the first release changelog exists, the automation deliberately exits without creating a tag or release. Subsequent releases start only after a pull request adds an explicit changeset.

Repository maintainers must enable **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**. If an organization policy disables this control, an organization owner must allow it first under the organization's Actions settings. The workflow receives write permissions only in its release job on `main`; validation jobs and pull-request builds remain read-only.

## Update a downstream commercial build

The GitHub Release is also the compatibility boundary for Git consumers. After `vN.N.N` exists, update the commercial repository in one pull request:

```json
"@purr/core": "git+https://github.com/purr-app/Purr.git#vN.N.N"
```

```toml
purr_core = { package = "purr", version = "=N.N.N", git = "https://github.com/purr-app/Purr.git", tag = "vN.N.N" }
```

Update its `core-version.json`, run `npm install` and the appropriate Cargo command to refresh both lockfiles, then run the commercial compatibility suite. A merge to public `main` never changes the commercial build by itself; only this reviewed pin update does.

`core-v0.1.0` is the historical dependency bootstrap tag. Keep existing consumers pinned until the manually created unified `v0.1.0` release is available, then use only the unified `vN.N.N` convention.
