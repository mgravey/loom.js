# Loom.js

Loom.js is a provider-neutral runtime for composing AI agents in browser-capable JavaScript
environments. Its core behaves like a small operating system: plugins declare what they provide, the
runtime validates and orders them, and consumers resolve capabilities through stable public
contracts.

Phase 1 established the architecture-only runtime. Phase 2 added a minimal Codex-style orchestration
plugin and text-workspace tools. Phase 3 adds replaceable browser plugins for explicit host
capabilities, IndexedDB storage, and File System Access workspaces. Core and the agent packages
remain free of browser APIs. Loom still contains no model provider, authentication, extension, or
execution runtime.

## Packages

| Package                   | Responsibility                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `@loom/types`             | Dependency-free primitives shared across the ecosystem                              |
| `@loom/plugin-api`        | Contracts used by plugin authors                                                    |
| `@loom/core`              | Runtime composition, lifecycle, registries, DI, events, configuration, and sessions |
| `@loom/tool-workspace`    | Normalized text-workspace paths and adapter-backed list/read/write tools            |
| `@loom/agent-codex`       | Minimal streamed model/tool orchestration; no provider integration                  |
| `@loom/platform-browser`  | Explicitly supplied browser host capability                                         |
| `@loom/storage-indexeddb` | Namespaced byte storage implemented with IndexedDB                                  |
| `@loom/workspace-fsa`     | File System Access implementation of the text-workspace tools                       |
| `@loom/examples`          | Provider-neutral examples that use public package exports only                      |
| `@loom/example-browser`   | Browser application demonstrating explicit Phase 3 composition                      |

Dependency direction is intentional:

```text
@loom/types <- @loom/plugin-api <- @loom/core
             ^       ^
             |       +-- @loom/tool-workspace <- @loom/agent-codex
             +------------------------- browser plugins and examples
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

Start with [the documentation index](./DOCUMENTATION.md), then read
[the architecture guide](./docs/architecture.md) and
[the plugin-authoring guide](./docs/plugin-authoring.md). The
[minimal-agent guide](./docs/minimal-agent.md) covers Phase 2 composition, and the
[browser-platform guide](./docs/browser-platform.md) covers Phase 3. Architectural decisions are
recorded in [`docs/adr`](./docs/adr/README.md).

The interactive [browser example](./packages/example-browser/README.md) composes the scripted agent
with an application-selected directory using the Phase 3 plugins.

## Project status

Loom.js packages remain private at `0.1.0` while Phase 3 is developed. Publishing, license
selection, Changesets, public namespace ownership, hot plugin mutation, version-range negotiation,
and multi-browser CI are intentionally deferred. See [CHANGES.md](./CHANGES.md) for milestone
history.
