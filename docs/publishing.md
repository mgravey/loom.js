# Publishing Loom.js packages

Loom.js publishes stable libraries and explicitly named experimental clients as public ESM packages
under `@mgravey/loom-*`. The repository root, examples, and extension-owned provider implementation
remain private. The source and package tarballs are licensed under the Mozilla Public License 2.0
(`MPL-2.0`).

## Public package boundary

The public set contains the provider-neutral runtime and its stable adapters:

- `@mgravey/loom-types`, `@mgravey/loom-plugin-api`, and `@mgravey/loom-core`;
- `@mgravey/loom-tool-workspace`, `@mgravey/loom-agent-codex`, and `@mgravey/loom-coding`;
- `@mgravey/loom-execution-browser`, `@mgravey/loom-platform-browser`,
  `@mgravey/loom-storage-indexeddb`, and `@mgravey/loom-workspace-fsa`;
- `@mgravey/loom-model-openai-responses`;
- `@mgravey/loom-credential-broker-api`, `@mgravey/loom-credential-provider-api`,
  `@mgravey/loom-auth-extension`, and `@mgravey/loom-extension`.

The public, unsupported compatibility set is intentionally named as experimental:

- `@mgravey/loom-model-codex-experimental`;
- `@mgravey/loom-companion-codex-experimental`.

The experimental Companion path additionally publishes `loom-tool-workspace`, `loom-agent-codex`,
and `loom-coding`. The extension-owned OAuth and provider implementation remains private.

Core does not communicate with Chrome directly. The website-side Chrome path is
`loom-auth-extension -> loom-credential-broker-api`; the extension-side path is
`loom-extension -> loom-credential-provider-api`. Experimental provider authentication remains
private.

## Validate a release

Install the pinned workspace dependencies and run the full acceptance gate:

```sh
pnpm install --frozen-lockfile
pnpm release:check
pnpm release:pack
```

`release:check` runs the full repository acceptance suite and validates every public manifest,
README, license, build, export, repository path, provenance setting, and internal dependency.
`release:pack` builds every workspace, runs each public package's clean `prepack`, writes tarballs
to the ignored `release-artifacts/` directory, installs all tarballs together in a new temporary npm
consumer, and imports every package. Inspect the tarballs before publication.

## Version changes

For a user-visible public package change, add a Changeset in the pull request:

```sh
pnpm changeset
```

Before release, apply the accumulated version plan and review all changed versions and internal
dependency ranges:

```sh
pnpm version-packages
pnpm release:check
pnpm release:pack
```

Update `CHANGES.md` with the release summary and commit the version changes before publishing.
Workspace dependencies use `workspace:^`; pnpm converts those references into normal compatible
semver ranges in published tarballs.

## Initial npm releases

The first `0.1.0` release completed on 22 July 2026 for the minimal reusable set:

- `@mgravey/loom-types`;
- `@mgravey/loom-plugin-api`;
- `@mgravey/loom-core`;
- `@mgravey/loom-credential-broker-api`;
- `@mgravey/loom-auth-extension`.

A clean npm consumer was able to install the two top-level packages, resolve all three transitive
packages, and import all five public entry points.

The second `0.1.0` publication set adds the dependency-complete coding and extension-model path:

- `@mgravey/loom-tool-workspace`;
- `@mgravey/loom-agent-codex`;
- `@mgravey/loom-coding`;
- `@mgravey/loom-model-codex-experimental`;
- `@mgravey/loom-companion-codex-experimental`.

The remaining stable packages listed above are release-ready but have not yet had their first
registry release.

For a remaining package's first npm release, the maintainer must control the `@mgravey` npm scope
and use an npm account with two-factor authentication. Create each package record deliberately only
after reviewing `release-artifacts/`:

```sh
npm login
cd packages/<package-directory>
NPM_CONFIG_PROVENANCE=false pnpm publish --access public
```

The local first publish disables provenance because npm provenance requires a supported CI identity.
The package metadata still requires provenance for normal automated releases.

After each first release, configure the package on npmjs.com with this trusted publisher:

- provider: GitHub Actions;
- repository: `mgravey/loom.js`;
- workflow filename: `release.yml`;
- environment: `npm`;
- allowed action: `npm publish`.

Create a protected GitHub `npm` environment that requires maintainer approval. Once every package
uses trusted publishing, remove any `NPM_TOKEN` repository secret. The manual **Publish npm
packages** workflow has `id-token: write`, reruns the complete verification and tarball smoke test,
installs an npm CLI with trusted-publishing support, and invokes `changeset publish` with
short-lived OIDC credentials and automatic provenance.

For the initial CI-based publication instead of a local first publish, create a narrowly scoped npm
automation token as the `NPM_TOKEN` GitHub secret, run the protected workflow once, configure
trusted publishing on the newly created package records, and then delete the token.
