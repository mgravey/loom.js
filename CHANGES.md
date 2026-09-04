# Changes

This project follows a milestone changelog alongside Changesets for public package versioning.

## Unreleased — Codex transport terminal handshake

### Fixed

- The experimental Companion transport now acknowledges a validated, request-scoped `end` message
  before the extension closes its Chrome Port, preventing a completed response from being
  misreported as a connection failure.
- Terminal cleanup is idempotent across completion, provider failure, cancellation, malformed
  messages, and disconnects. An acknowledgement timeout keeps older Companion versions compatible
  without leaving extension ports open indefinitely.

## Public package releases

- Renamed workspace packages to the search-friendly `@mgravey/loom-*` scope and marked the stable
  runtime, browser, model, workspace, credential protocol, website extension client, and generic
  extension broker packages for public npm access.
- Added the Mozilla Public License 2.0, package-specific READMEs, descriptions, repository metadata,
  explicit ESM/declaration payloads, clean prepack builds, and npm provenance configuration.
- Added Changesets, release verification, reproducible package tarballs, clean-project installation
  and import smoke tests, plus a manual GitHub Actions trusted-publishing workflow.
- Published the initial `0.1.0` minimal runtime and website-to-extension set: `loom-types`,
  `loom-plugin-api`, `loom-core`, `loom-credential-broker-api`, and `loom-auth-extension`; verified
  a clean registry installation and import of all five packages.
- Added a public, explicitly experimental Companion client that requests exact-origin approval and
  routes credential-free model request bodies and streamed responses through the published Chrome
  extension.
- Published and registry-verified the dependency-complete `0.1.0` coding path:
  `loom-tool-workspace`, `loom-agent-codex`, `loom-coding`, `loom-model-codex-experimental`, and
  `loom-companion-codex-experimental`.
- Kept examples and extension-owned Codex authentication/provider implementations private.

## 0.1.1 — Structured experimental provider failures

- Structured experimental Codex provider failures preserve bounded codes, sanitized messages,
  incomplete reasons, retryability, and Retry-After delays across streamed events and the Companion
  extension boundary without exposing response bodies or headers.

## 0.2.0 — Provider-native context compaction and Companion presentation

- Added an explicit credential-free `compact` transport operation for the experimental Codex model,
  routed only to `responses/compact` by the extension.
- Added bounded validation and opaque replay for compacted provider items; ordinary generation now
  preserves completed continuation items needed by later model turns.
- Coding sessions can opt into automatic character-threshold compaction and expose a serializable
  checkpoint that records both the opaque items and the covered transcript prefix.
- Context-window provider codes now set `contextCompactionRequired`; the agent preserves completed
  in-run tool history, compacts once before partial output, and retries only the failed model turn.
- Declared the existing colored Loom artwork as an always-enabled Chrome toolbar action, preventing
  permission-based visual dimming without adding page access, content scripts, or click behavior.
- Updated the Companion manifest and provider client identifier to `0.2.0` for the corresponding
  Chrome Web Store release.
- Isolated Store verification artifacts from production upload archives so test configuration can
  never overwrite the ZIP prepared for submission.

## Unreleased — Browser coding workbench

### Added

- Production Pages artifacts now default to Store Companion ID `gdcebopdllcifgleoefgbobdopiaholg`;
  the workbench checks it automatically and migrates the known legacy unpacked ID retained by
  earlier production visits.
- A subtle homepage footer signature: “Carefully vibe coded agentically engineered,” with the
  original “vibe coded” claim struck through.
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
- Deterministic Chrome Web Store release exports: normalized ZIP metadata, exact archive inventory,
  public-origin and contact validation, icon-dimension checks, SHA-256 checksums, and generated
  440×280 promotional media plus a real 1280×800 packaged-options screenshot. Support and security
  contacts now use `sideproject@mgravey.com`; the submitted archive also preserves the bundled
  `lottie-web` MIT notice.
- A GitHub Pages production workflow and validated static-site artifact for
  `https://mgravey.com/loom.js/`. The deployment generates production browser configuration from
  non-secret repository variables, while the Store packager now defaults to the same homepage,
  privacy, support, and exact-origin values.
- The deployed static artifact now includes the bundled `lottie-web` MIT notice.
- `@mgravey/loom-coding`, a reusable session-level orchestration API for streamed prompts,
  follow-ups, transcript events, cancellation, injected execution runtimes, and deterministic
  disposal.
- Binary-capable `ProjectWorkspace` contracts, a memory implementation, expanded FSA/OPFS adapter,
  strict unified patches, and stat/mkdir/move/remove project tools while preserving the original
  text-workspace API.
- Safe recursive folder and ZIP import/export with traversal, symlink, conflict, entry-count, size,
  and compression-ratio validation.
- `@mgravey/loom-execution-browser` with lazy, credential-free QuickJS, WebContainer Node.js, and
  Pyodide adapters, streamed output, cancellation/timeouts, and explicit workspace snapshot/commit.
- A multi-mode browser workbench for direct directories, disposable memory projects, and persistent
  OPFS projects, including file editing, folder/ZIP transfer, model chat, and runtime execution.
- A tab-scoped Manifest V3 callback bridge that transforms the audited localhost OAuth callback into
  a web-accessible extension callback page. It validates PKCE state, tab, expiry, and replay;
  device-code authentication remains an explicit fallback.
- Classic Responses and Responses Lite request modes. Lite requests carry developer instruction and
  `additional_tools` input items; direct mode adds the internal Lite transport header.
- A provider-specific direct-auth message lets the exact authorized workbench origin obtain a
  short-lived access token and account-routing ID for page-originated model requests.
- An explicit **Remember sign-in on this Chrome profile** option migrates the refresh credential and
  routing ID between trusted session and local extension storage. Session-only storage remains the
  default.
- A first-contact website approval flow records only user-approved exact origins. Pending requests
  are session-only; approved origins persist until individually revoked or the bridge is disabled.
- A direct-first model transport retries through the extension only when the browser fails before
  receiving an HTTP response, covering CORS and indistinguishable connection failures.
- After that first direct failure, the workbench keeps using the extension relay for the remaining
  tab session, including reloads, and does not repeat the fallback notice in the conversation.
- The workbench automatically checks a configured extension on load and presents agent output in a
  chat-first layout with compact, collapsible tool activity and hidden-by-default local utilities.
- Recoverable workspace-tool failures are returned to the model as structured results so it can
  inspect the error and retry instead of aborting the coding run.
- Tool activity now uses human-readable titles, purpose descriptions, running/completed states, and
  a conversation-level progress indicator. Long responses scroll independently so the composer
  remains fixed and ready for follow-up commands.
- Assistant Markdown now renders as structured headings, lists, inline code, and compact code/output
  panels with copy controls instead of exposing literal backtick fences in the conversation.
- Workspaces can persist multiple resumable chats under `.loom/conversations/`. The workbench adds
  conversation switching, creation, individual deletion, and a confirmed full `.loom` cleanup;
  runtime sandboxes neither receive nor overwrite saved conversation records.
- `@mgravey/loom-agent-codex` and `@mgravey/loom-coding` now accept application-defined, namespaced
  `CodexTool` operations with model-facing JSON schemas, descriptions, output schemas, caller
  policies, and website-owned executors.
- The workbench exposes QuickJS, WebContainer Node.js, and Pyodide Python as an agent-callable
  run-file tool with bounded captured output and workspace write-back. Pyodide resolves bundled
  packages from entrypoint imports before execution.
- Pyodide now preloads NumPy and Matplotlib, installs additional compatible registry requirements
  with micropip, and exports open Matplotlib figures as PNG artifacts rendered in the chat.
- A model-callable package tool installs Node dependencies with npm and persists dependency
  metadata. WebContainer restores those dependencies before Node execution while excluding
  `node_modules` and caches from project write-back.

### Security

- The extension owns login, token refresh, ID-token parsing, and account-routing persistence.
  Refresh and ID tokens never enter the workbench. Direct model mode temporarily exposes a
  short-lived access token and routing ID to the authorized page process; they never enter project
  storage, browser runtimes, configuration, or logs.
- The experimental direct-auth bridge requires both a packaged-manifest match and a durable,
  user-approved exact-origin grant. Refresh/routing state defaults to trusted session storage;
  persistent local extension storage is used only after a private-computer warning and explicit user
  confirmation. Logout, disable, credential rejection, and switching persistence off scrub local
  copies.
- Browser runtimes accept no environment map, credentials, headers, cookies, or host fetch adapter.
  Runtime caches such as `node_modules`, `.venv`, and `__pycache__` are excluded from write-back.
- Direct-directory runtime execution uses the read or read/write permission selected when the folder
  opens, without an additional prompt for every run. Visible sidebar controls shape the agent tool
  set; read-only runtime changes are discarded. ZIP import remains atomic and bounded, and unified
  patches use exact context with no fuzzy matching.

### Changed

- Fixed fresh GitHub Pages runners by building the experimental example's transitive workspace
  dependencies before bundling the site.

- Updated every browser example and experimental extension surface to Direction 08: self-contained
  Lottie animation on the landing and extension onboarding pages, compact optimized marks in site
  navigation, workbench/example headings and favicons, and the full SVG where space permits.
  Animated placements keep a static reduced-motion fallback.
- The experimental package now serves the project introduction at `index.html`, documentation at
  `docs.html`, and the runnable ChatGPT-backed composition at `workbench.html`.
- The experimental extension is presented under the neutral single-purpose name **Loom Secure Model
  Bridge**. Public submission remains blocked on a supported provider contract and verified
  publisher/legal details.
- The experimental example now defaults to `gpt-5.6-sol` and selects Responses Lite for GPT-5.6
  model IDs, while retaining classic mode for older audited models. Lite requests now match the
  current Codex contract with `reasoning.context: "all_turns"` and parallel tool calls disabled.
- The runnable workbench now performs model requests directly from the page so POST/preflight
  behavior is visible in its Network panel. A narrowly restored extension model port and ChatGPT
  host permission provide the pre-response fallback; HTTP errors and cancellations are not retried.
- The coding agent exposes optional stat, mkdir, move, remove, and exact-patch definitions only when
  their corresponding tools are supplied. Hosted programs remain read-only.

## Unreleased — Phase 5.5

### Added

- `@mgravey/loom-model-openai-responses`, a separate adapter for the documented OpenAI Platform
  Responses API with injected secure transport and trusted-host direct modes.
- Programmatic Tool Calling request support, including `output_schema`, `allowed_callers`, hosted
  `program`/`program_output` continuation items, caller-preserving function results, and
  final-message continuation semantics.
- Caller-aware parallel execution for hosted-program read-only calls. Workspace writes remain
  direct-only and are rejected when attributed to a hosted program.
- `@mgravey/loom-model-codex-experimental`, an isolated adapter from the Phase 2 agent protocol to
  an audited Responses-style request and streamed SSE response, with an injected credential-free
  transport as its preferred mode.
- A separate versioned `chrome.runtime.Port` transport. The experimental extension owns the ChatGPT
  backend request, credential and account-routing headers, cancellation, and sanitized failure
  boundary.
- `@mgravey/loom-example-codex-experimental`, a localhost browser application composing the browser
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
- The original Phase 5.5 composition kept access and refresh credentials in the extension because
  the audited ChatGPT backend rejected the localhost CORS preflight. ADR-013 deliberately tries a
  page-originated request first; ADR-015 restores an extension relay only for pre-response failures.
- Automated tests remain offline from OpenAI and use synthetic credentials and local responses.

### Still deferred

- Supported OpenAI client registration, a production API-key backend, extension-store publication,
  production model selection and entitlement checks, and local execution runtimes.

## Phase 5

### Changed

- Consolidated the completed Phase 3, Phase 4, and Phase 5 linear history onto `master` and
  clarified the clean-checkout, Chromium, and credential-free acceptance workflow.

### Added

- `@mgravey/loom-credential-provider-api`, extracting host-neutral refresh, interactive
  authorization, token-result, and sanitized provider-error contracts from the extension
  implementation.
- `@mgravey/loom-auth-codex-experimental`, reproducing the audited Codex CLI refresh, device-code,
  and direct authorization-code/PKCE request shapes behind injected clock, network, digest,
  randomness, redirect, polling, and transaction interfaces.
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

- `@mgravey/loom-credential-broker-api`, defining a transport-neutral, versioned, strictly validated
  access-token protocol.
- `@mgravey/loom-auth-extension`, adapting an explicitly supplied external-message runtime to Loom's
  provider-neutral `AuthProvider` capability.
- `@mgravey/loom-extension`, a Manifest V3 credential broker with exact-origin authorization,
  trusted-only refresh-credential storage, access-token caching, rotation support, and concurrent
  refresh deduplication.
- `@mgravey/loom-example-extension`, demonstrating end-to-end composition through public APIs with
  the development mock provider.
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

- `@mgravey/loom-agent-codex`, a small stateless coding-agent loop with a provider-neutral streamed
  model protocol, serial tool calls, cancellation propagation, and bounded turns.
- `@mgravey/loom-tool-workspace`, defining normalized relative paths and adapter-backed
  list/read/write text tools without host filesystem access.
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
