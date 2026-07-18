# Changes

This project follows a lightweight milestone changelog while packages remain private.

## Unreleased — Browser coding workbench

### Added

- Transparent SVG exports and a Lottie-ready After Effects builder that reveals the accepted
  `loom-mark-08.svg` ribbon silhouettes through centerline Trim Paths, preserving the original
  S-curves and crossings without scaling.
- A responsive Loom.js welcome page that separates the provider-neutral library from the
  experimental browser workbench, plus a browser-readable onboarding manual covering repository
  setup, first sessions, plugin lifecycle, typed capability registration, secure model transports,
  runtime execution, security, and current limitations.
- Chrome Web Store readiness infrastructure: a stable website deployment configuration, documented
  development-to-Store ID migration, required extension icons, explicit in-product data disclosure,
  bundled/public privacy disclosures, terms, legal notice, support and installation pages, a
  production-origin ZIP packager and verification gate, and a submission dossier with
  listing/privacy/reviewer fields.
- `@loom/coding`, a reusable session-level orchestration API for streamed prompts, follow-ups,
  transcript events, cancellation, injected execution runtimes, and deterministic disposal.
- Binary-capable `ProjectWorkspace` contracts, a memory implementation, expanded FSA/OPFS adapter,
  strict unified patches, and stat/mkdir/move/remove project tools while preserving the original
  text-workspace API.
- Safe recursive folder and ZIP import/export with traversal, symlink, conflict, entry-count, size,
  and compression-ratio validation.
- `@loom/execution-browser` with lazy, credential-free QuickJS, WebContainer Node.js, and Pyodide
  adapters, streamed output, cancellation/timeouts, and explicit workspace snapshot/commit.
- A multi-mode browser workbench for direct directories, disposable memory projects, and persistent
  OPFS projects, including file editing, folder/ZIP transfer, model chat, and runtime execution.
- A tab-scoped Manifest V3 callback bridge that transforms the audited localhost OAuth callback into
  a web-accessible extension callback page. It validates PKCE state, tab, expiry, and replay;
  device-code authentication remains an explicit fallback.
- Classic Responses and Responses Lite request modes. Lite requests carry developer instruction and
  `additional_tools` input items; only the extension adds the internal Lite transport header.

### Security

- The extension owns login, token refresh, account routing, ChatGPT model fetches, and streaming.
  Access, refresh, and ID tokens never enter the workbench, project workspace, browser runtimes,
  OPFS project archive, IndexedDB, configuration, or logs.
- The experimental bridge rejects external access-token requests, derives its runtime origin
  authorization from the packaged manifest, and keeps refresh/routing secrets only in trusted
  session storage so they are cleared when Chrome exits.
- Browser runtimes accept no environment map, credentials, headers, cookies, or host fetch adapter.
  Runtime caches such as `node_modules`, `.venv`, and `__pycache__` are excluded from write-back.
- Direct-directory runtime write-back requires an explicit confirmation. ZIP import is atomic and
  bounded, and unified patches use exact context with no fuzzy matching.

### Changed

- The experimental package now serves the project introduction at `index.html`, documentation at
  `docs.html`, and the runnable ChatGPT-backed composition at `workbench.html`.
- The experimental extension is presented under the neutral single-purpose name **Loom Secure Model
  Bridge**. Public submission remains blocked on a supported provider contract and verified
  publisher/legal details.
- The experimental example now defaults to `gpt-5.6-sol` and selects Responses Lite for GPT-5.6
  model IDs, while retaining classic mode for older audited models.
- The coding agent exposes optional stat, mkdir, move, remove, and exact-patch definitions only when
  their corresponding tools are supplied. Hosted programs remain read-only.

## Unreleased — Phase 5.5

### Added

- `@loom/model-openai-responses`, a separate adapter for the documented OpenAI Platform Responses
  API with injected secure transport and trusted-host direct modes.
- Programmatic Tool Calling request support, including `output_schema`, `allowed_callers`, hosted
  `program`/`program_output` continuation items, caller-preserving function results, and
  final-message continuation semantics.
- Caller-aware parallel execution for hosted-program read-only calls. Workspace writes remain
  direct-only and are rejected when attributed to a hosted program.
- `@loom/model-codex-experimental`, an isolated adapter from the Phase 2 agent protocol to an
  audited Responses-style request and streamed SSE response, with an injected credential-free
  transport as its preferred mode.
- A separate versioned `chrome.runtime.Port` transport. The experimental extension owns the ChatGPT
  backend request, credential and account-routing headers, cancellation, and sanitized failure
  boundary.
- `@loom/example-codex-experimental`, a localhost browser application composing the browser
  platform, File System Access tools, extension auth, experimental model, and Codex-style agent.
- Credential status and logout operations in the provider-neutral broker protocol and extension
  options/application UI.
- A real Chromium vertical-slice test using the unpacked extension, local auth and model fixtures,
  an OPFS directory handle, a workspace tool turn, response streaming, and logout.
- Current Codex inference protocol re-audit, a Phase 5.5 guide, and ADR-010.
- Secret-safe page and extension-service-worker diagnostics for every model transport stage,
  including explicit pre-fetch failure codes and streamed byte-count metadata.
- Authentication status now requires both a refresh credential and ChatGPT account-routing state;
  partial legacy state is surfaced as incomplete and cannot reach the model transport.
- The browser example now defaults to the audited classic Responses model `gpt-5.5`; requests carry
  the catalog's reasoning/verbosity defaults plus session-scoped cache and client metadata.
- Provider fetch diagnostics now name the non-secret target/method/model and expose only bounded,
  allowlisted error code/type/parameter metadata for non-2xx responses.

### Security

- The initial ID token is parsed only in the extension. Only the non-bearer ChatGPT account routing
  ID is persisted in trusted storage; raw ID tokens are neither retained nor exposed to the page.
- The application never receives access or refresh credentials. The provider request runs in the
  extension because the audited ChatGPT backend does not allow the localhost page's CORS preflight.
- Automated tests remain offline from OpenAI and use synthetic credentials and local responses.

### Still deferred

- Supported OpenAI client registration, a production API-key backend, extension-store publication,
  production model selection and entitlement checks, and local execution runtimes.

## Phase 5

### Changed

- Consolidated the completed Phase 3, Phase 4, and Phase 5 linear history onto `master` and
  clarified the clean-checkout, Chromium, and credential-free acceptance workflow.

### Added

- `@loom/credential-provider-api`, extracting host-neutral refresh, interactive authorization,
  token-result, and sanitized provider-error contracts from the extension implementation.
- `@loom/auth-codex-experimental`, reproducing the audited Codex CLI refresh, device-code, and
  direct authorization-code/PKCE request shapes behind injected clock, network, digest, randomness,
  redirect, polling, and transaction interfaces.
- A separate experimental Manifest V3 composition with an extension-owned, disabled-by-default
  authorization surface; the shared credential broker remains provider-neutral.
- Deterministic tests for PKCE, state consumption, device polling, response validation, refresh
  rotation, permanent rejection, and secret-safe error handling.
- Phase 5 feasibility report, threat model, source-pinned re-audit policy, and ADR-009.

### Security

- Direct `chrome.identity` authorization cannot run unless redirect registration is explicitly
  approved; the audited Codex CLI client documents only localhost callbacks.
- Device authorization is a manual, unsupported experiment and never activates as a silent fallback.
  Automated tests never contact OpenAI.
- Refresh credentials are persisted before related access tokens are cached or returned. Permanent
  refresh rejection deletes the stored credential and requires reauthorization.

### Still deferred

- Supported OpenAI extension-client registration, production Codex authentication, extension-store
  publication, OS-keyring-grade credential protection, model providers, and execution runtimes.

## Phase 4

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

### Deferred at completion

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
