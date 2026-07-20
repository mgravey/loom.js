# Documentation

This index separates stable core behavior from the independently replaceable plugins added in later
phases.

- [Architecture](./docs/architecture.md) — runtime boundaries, composition, and state ownership
- [Plugin authoring](./docs/plugin-authoring.md) — manifests, hooks, registrations, and constraints
- [Step-by-step onboarding](./docs/getting-started.md) — repository setup, first workspace and
  coding session, plugin composition, typed and model-callable website tools, model transports,
  runtimes, and current limitations
- [Chrome Web Store submission dossier](./docs/chrome-web-store-submission.md) — development/store
  extension IDs, production packaging, listing copy, permission justifications, privacy answers,
  legal/support pages, reviewer instructions, assets, blockers, and release checklist
- [Minimal coding agent](./docs/minimal-agent.md) — Phase 2 composition and protocol boundaries
- [OpenAI Platform Responses](./docs/openai-responses.md) — supported Responses API adapter,
  Programmatic Tool Calling, continuation, and API-key trust boundary
- [Browser platform](./docs/browser-platform.md) — Phase 3 host adapters and permission boundaries
- [Credential broker](./docs/credential-broker.md) — Phase 4 extension protocol and trust boundary
- [Codex authentication experiment](./docs/codex-auth-experiment.md) — Phase 5 audit, threat model,
  feasibility verdict, and manual experiment policy
- [Phase 5.5 vertical slice](./docs/phase-5-5-vertical-slice.md) — build, extension installation,
  localhost application, authentication, model run, two-sided diagnostics, logout, and local
  verification
- [Browser coding workbench](./docs/browser-coding-workbench.md) — reusable coding sessions,
  extension-owned ChatGPT boundary, direct/memory/OPFS projects, ZIP transfer, and browser runtimes
- [Brand vectors and Lottie animation](./docs/brand-animation.md) — transparent SVG assets, After
  Effects composition builder, and Bodymovin export workflow
- [Browser-readable welcome and guide](./packages/example-codex-experimental/index.html) — project
  introduction, library/example separation, and the rendered onboarding path
- [Extension installation README](./packages/extension-codex-experimental/README.md) — unpacked
  installation, current development ID, Store-ID migration, permissions, and production ZIP
- [Testing](./docs/testing.md) — local checks, browser smoke tests, and acceptance criteria
- [Architecture decision records](./docs/adr/README.md) — rationale behind the stable contracts
- [Changes](./CHANGES.md) — milestone-level release notes

The documented OpenAI Platform adapter is a provider leaf and does not enter Core. The coding
orchestrator, project workspaces, and browser execution adapters are independently replaceable
packages. The generic extension still has only a mock provider; the separate Codex experiment is
disabled by default and does not establish a supported OpenAI authentication or ChatGPT inference
contract.
