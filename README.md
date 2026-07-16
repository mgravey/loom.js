# Loom.js

Loom.js is a provider-neutral runtime for composing AI agents in browser-capable JavaScript
environments. Its core behaves like a small operating system: plugins declare what they provide, the
runtime validates and orders them, and consumers resolve capabilities through stable public
contracts.

Phases 1 through 5.5 are consolidated on `master`. Phase 1 established the architecture-only
runtime. Phase 2 added a minimal Codex-style orchestration plugin and text-workspace tools. Phase 3
added replaceable browser plugins for explicit host capabilities, IndexedDB storage, and File System
Access workspaces. Phase 4 added a provider-neutral Manifest V3 credential broker and a Loom
authentication adapter. Phase 5 adds an isolated, disabled-by-default Codex authentication
experiment based on an audited open-source CLI revision. Phase 5.5 adds a runnable experimental
vertical slice: a provider-specific model leaf, extension-owned provider transport, status/logout,
and a localhost browser application. Core and the agent packages remain free of provider, browser,
and extension APIs. Loom still contains no supported OpenAI OAuth product or execution runtime.

## Packages

| Package                              | Responsibility                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| `@loom/types`                        | Dependency-free primitives shared across the ecosystem                              |
| `@loom/plugin-api`                   | Contracts used by plugin authors                                                    |
| `@loom/core`                         | Runtime composition, lifecycle, registries, DI, events, configuration, and sessions |
| `@loom/tool-workspace`               | Normalized text-workspace paths and adapter-backed list/read/write tools            |
| `@loom/agent-codex`                  | Minimal streamed model/tool orchestration; no provider integration                  |
| `@loom/platform-browser`             | Explicitly supplied browser host capability                                         |
| `@loom/storage-indexeddb`            | Namespaced byte storage implemented with IndexedDB                                  |
| `@loom/workspace-fsa`                | File System Access implementation of the text-workspace tools                       |
| `@loom/credential-broker-api`        | Transport-neutral, validated access-token request/response protocol                 |
| `@loom/credential-provider-api`      | Host-neutral provider, refresh, and interactive-authorization contracts             |
| `@loom/auth-extension`               | External-message client and Loom `AuthProvider` adapter                             |
| `@loom/extension`                    | Manifest V3 credential broker with extension-owned refresh state                    |
| `@loom/auth-codex-experimental`      | Audited Codex PKCE/device-auth experiment with injected host services               |
| `@loom/extension-codex-experimental` | Separate disabled-by-default Manifest V3 experiment composition                     |
| `@loom/model-codex-experimental`     | Experimental Responses/SSE adapter with an injected credential-free transport       |
| `@loom/examples`                     | Provider-neutral examples that use public package exports only                      |
| `@loom/example-browser`              | Browser application demonstrating explicit Phase 3 composition                      |
| `@loom/example-extension`            | Browser application demonstrating the Phase 4 extension boundary                    |
| `@loom/example-codex-experimental`   | Phase 5.5 localhost app joining agent, tools, model transport, and extension        |

Dependency direction is intentional:

```text
@loom/types <- @loom/plugin-api <- @loom/core
             ^       ^
             |       +-- @loom/tool-workspace <- @loom/agent-codex
             +------------------------- browser plugins and examples

@loom/credential-broker-api <- @loom/auth-extension <- @loom/example-extension
             ^
             +-- @loom/extension <- @loom/extension-codex-experimental

@loom/credential-provider-api <- @loom/extension
             ^
             +-- @loom/auth-codex-experimental <- @loom/extension-codex-experimental

@loom/agent-codex <- @loom/model-codex-experimental <- @loom/example-codex-experimental
```

Plugins may use the public runtime composition API when acting as an application entry point, but
must never import core internals. `@loom/types` cannot depend on another Loom package.

## Getting started

Requirements:

- Node.js 20.19 or newer (tooling only)
- pnpm 11.7.0
- Chromium for compatibility smoke tests

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
```

Use Node.js 22 to match CI. On Linux machines that do not already have Chromium system libraries,
install the browser with `pnpm exec playwright install --with-deps chromium`. No OpenAI credentials,
refresh tokens, extension installation, or live OAuth access is needed for acceptance: Phase 5.5
tests use deterministic synthetic credentials and local network fixtures.

Useful commands:

| Command              | Purpose                                                 |
| -------------------- | ------------------------------------------------------- |
| `pnpm build`         | Build all packages as ESM with declarations             |
| `pnpm typecheck`     | Typecheck the strict TypeScript project-reference graph |
| `pnpm lint`          | Enforce correctness and package boundaries              |
| `pnpm test`          | Run unit and real-Chromium compatibility tests          |
| `pnpm test:coverage` | Run unit tests with repository coverage gates           |
| `pnpm format:check`  | Verify formatting                                       |
| `pnpm check`         | Run the complete CI acceptance suite                    |

`pnpm check` is the release gate. It covers formatting, package-boundary linting, strict TypeScript,
coverage thresholds, ESM and declaration builds, browser-window and dedicated-worker smoke tests,
and Manifest V3 extension tests. See [Testing](./docs/testing.md) for focused commands and
troubleshooting.

## Design guarantees

- The core knows capabilities by structural `(kind, id)` keys, never by implementations.
- Plugins are fixed for a runtime instance and execute in deterministic dependency order.
- Registrations are owned, frozen before startup, and removed during rollback or disposal.
- DI services are separate from ecosystem capabilities.
- Configuration is JSON-only, cloned, immutable, and visible only to its owning plugin.
- Sessions have isolated cancellation, events, configuration overlays, and child service scopes.
- Multiple runtimes do not share mutable state.
- Agent protocols stay in agent packages rather than becoming core wire formats.
- Workspace tools depend on an injected adapter and cannot access a host filesystem directly.
- Browser APIs are isolated in browser packages and supplied explicitly by applications.
- Refresh credentials are owned by the extension and never enter a Loom page or runtime.
- External token requests require an exact authorized origin and a validated versioned envelope.
- Experimental provider failures remain sanitized and refresh rotation is persisted before an access
  token is exposed.
- The experimental browser page receives authentication state and streamed response bytes, never
  extension-owned access, refresh, or ID credentials.

Start with [the documentation index](./DOCUMENTATION.md), then read
[the architecture guide](./docs/architecture.md) and
[the plugin-authoring guide](./docs/plugin-authoring.md). The
[minimal-agent guide](./docs/minimal-agent.md) covers Phase 2 composition, and the
[browser-platform guide](./docs/browser-platform.md) covers Phase 3. The
[credential-broker guide](./docs/credential-broker.md) covers the Phase 4 trust boundary and local
extension workflow. The [Codex authentication experiment](./docs/codex-auth-experiment.md) records
the Phase 5 source audit, threat model, test policy, and current feasibility blockers. Architectural
decisions are recorded in [`docs/adr`](./docs/adr/README.md).

The [Phase 5.5 vertical-slice guide](./docs/phase-5-5-vertical-slice.md) explains how to build, load
the unpacked extension, serve the browser application, authenticate from trusted extension UI, run
an agent, inspect secret-safe diagnostics on both sides of the extension boundary, log out, and
perform the fully local acceptance test. The example currently suggests `gpt-5.5`, the newest
audited classic Responses model compatible with its ordinary function-tool envelope; the current
GPT-5.6 Codex models use a distinct Responses Lite protocol that this experiment does not yet
implement.

The interactive [browser example](./packages/example-browser/README.md) composes the scripted agent
with an application-selected directory using the Phase 3 plugins. The
[credential-broker example](./packages/example-extension/README.md) requests a short-lived mock
token from the separately loaded extension and resolves it through Loom's public `AuthProvider`
capability.

The [experimental Codex example](./packages/example-codex-experimental/README.md) is the only
browser-to-extension real-provider composition and remains explicitly unsupported.

## Project status

Loom.js packages remain private at `0.1.0`. The generic Phase 4 extension remains development-only
and ships a mock provider. The separate Phase 5.5 provider is unsupported, disabled by default, and
must not be described as production ChatGPT/Codex authentication: the direct Chrome redirect is not
registered for the audited CLI client, while device authorization can be server-disabled and is not
a documented third-party contract. Publishing, license selection, Changesets, public namespace
ownership, hot plugin mutation, version-range negotiation, and multi-browser CI are intentionally
deferred. See [CHANGES.md](./CHANGES.md) for milestone history.
