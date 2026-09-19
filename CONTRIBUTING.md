# Contributing to Purr

Thank you for contributing to Purr.

Before starting a substantial change, open an issue or discussion to confirm the scope and approach. Keep pull requests focused, explain the resulting behavior, and include appropriate tests and documentation. Follow the architecture and UI guidance in [AGENTS.md](AGENTS.md), and run the checks relevant to your change before requesting review.

Add a changeset for every user-visible change or public TypeScript/Rust contract change:

```bash
npm run changeset
```

Choose `patch` for compatible fixes, `minor` for new capabilities or a breaking pre-1.0 extension API change, and write the summary as a release note. Tests, internal tooling, and documentation-only changes may omit one. Changesets, rather than commit-message parsing, are the source of truth for releases; see [the release guide](docs/releases.md).

Do not submit code, assets, data, or other material that you do not have the right to contribute. Never include credentials, private customer data, or proprietary source material.

Automatic CI runs secret scanning, dependency audits, unit tests, type checking, lint, and native build checks. Playwright UI tests are temporarily separate because some scenarios have unresolved timing failures on CI runners. For UI changes, run `npm run test:ui` locally and report the result. Maintainers can also run the **UI tests (manual)** workflow from GitHub Actions; it does not run on pushes or pull requests.

By submitting a contribution, you agree that it is licensed under the [MIT License](LICENSE) that covers this repository. No Contributor License Agreement is currently required.
