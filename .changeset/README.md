# Changesets

User-visible changes and public contract changes need a changeset in their pull request:

```bash
npm run changeset
```

Choose the SemVer impact and write the release note in user-facing language. Use:

- `patch` for fixes and compatible improvements;
- `minor` for new capabilities and, while Purr is below `1.0.0`, breaking extension API changes;
- `major` only when intentionally moving to the next stable major line.

Tests, internal tooling, and documentation-only pull requests may omit a changeset. Commit messages may use Conventional Commit prefixes for readability, but changesets are the source of truth for versions and release notes.

Do not edit package, Cargo, Tauri, or lockfile versions by hand. The release workflow consumes pending changesets into one version pull request and synchronizes every version location.
