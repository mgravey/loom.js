# Changes

This project follows a lightweight milestone changelog while packages remain private.

## Unreleased — Phase 4

### Added

- `@loom/credential-broker-api`, defining a transport-neutral, versioned, strictly validated
  access-token protocol.
- `@loom/auth-extension`, adapting an explicitly supplied external-message runtime to Loom's
  provider-neutral `AuthProvider` capability.
- `@loom/extension`, a Manifest V3 credential broker with exact-origin authorization, trusted-only
  refresh-credential storage, access-token caching, rotation support, and concurrent refresh
  deduplication.
- `@loom/example-extension`, demonstrating end-to-end composition through public APIs with the
  development mock provider.
- Real Chromium tests loading the unpacked extension and exercising allowed and unauthorized
  origins, concurrent requests, unknown providers, and missing credentials.
- Credential-broker security guide and ADR-008 for the extension-owned trust boundary.

### Security

- Refresh credentials remain inside the extension and are never included in broker responses, Loom
  configuration, sessions, events, IndexedDB, or application logs.
- `chrome.storage.local` access is restricted to `TRUSTED_CONTEXTS` before credential
  initialization, and the service worker authorizes the sender's exact HTTP(S) origin before parsing
  a request.

### Still deferred

- Real OAuth providers, Codex authentication research, login/logout UI, provider network calls,
  extension publication, production origin configuration, and execution runtimes.

## Phase 3

### Added

- Explicit browser-platform capability plugin for window and dedicated-worker composition.
- IndexedDB implementation of Loom's namespaced byte-oriented storage contract.
- File System Access implementation of the list/read/write text-workspace tools.
- Browser example with application-owned directory selection and deterministic model orchestration.
- Real Chromium window and worker coverage using IndexedDB and OPFS directory handles.
- Browser-platform guide and ADR-007 for explicit host injection.

### Still deferred

- Production model providers, real authentication providers, execution runtimes, Git, terminal,
  search, package management, and persisted conversations.

## Phase 2

### Added

- `@loom/agent-codex`, a small stateless coding-agent loop with a provider-neutral streamed model
  protocol, serial tool calls, cancellation propagation, and bounded turns.
- `@loom/tool-workspace`, defining normalized relative paths and adapter-backed list/read/write text
  tools without host filesystem access.
- Deterministic scripted-model and in-memory-workspace examples plus runtime, browser-window, and
  dedicated-worker integration coverage.
- Phase 2 composition documentation and ADR-006 for agent-owned protocols.

### Changed

- Agent, model, tool, and execution-runtime key/registration helpers preserve specialized public
  protocols through generic typing.
- DI scope disposal now waits for pending async factories and disposes values that finish after a
  scope begins closing.

### Still deferred

- Model providers, authentication, browser filesystem adapters, execution runtimes, Git, terminal,
  search, persisted conversation history, and automatic agent selection.

## 0.1.0 — Phase 1

### Added

- pnpm monorepo with strict TypeScript, ESM builds, formatting, linting, coverage gates, and CI.
- Dependency-free shared types and provider-neutral plugin contracts.
- Deterministic plugin lifecycle with validation, rollback, and owned-registration cleanup.
- Runtime-local capability registry, typed events, dependency injection, and immutable
  configuration.
- Isolated, in-memory session scopes with deterministic disposal.
- Public-API examples plus browser window and dedicated Web Worker smoke-test infrastructure.
- Architecture, plugin-authoring, testing, and decision-record documentation.

### Intentionally deferred

- Concrete agents, models, tools, authentication, storage, platform, UI, and execution runtimes.
- Hot plugin installation/removal, lifecycle restart, dependency version ranges, configuration
  mutation, persistence, and conversation history.
- Package publication, license selection, Changesets, and multi-browser CI.
