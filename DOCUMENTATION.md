# Documentation

This index separates stable core behavior from the independently replaceable plugins added in later
phases.

- [Architecture](./docs/architecture.md) — runtime boundaries, composition, and state ownership
- [Plugin authoring](./docs/plugin-authoring.md) — manifests, hooks, registrations, and constraints
- [Minimal coding agent](./docs/minimal-agent.md) — Phase 2 composition and protocol boundaries
- [Browser platform](./docs/browser-platform.md) — Phase 3 host adapters and permission boundaries
- [Credential broker](./docs/credential-broker.md) — Phase 4 extension protocol and trust boundary
- [Codex authentication experiment](./docs/codex-auth-experiment.md) — Phase 5 audit, threat model,
  feasibility verdict, and manual experiment policy
- [Testing](./docs/testing.md) — local checks, browser smoke tests, and acceptance criteria
- [Architecture decision records](./docs/adr/README.md) — rationale behind the stable contracts
- [Changes](./CHANGES.md) — milestone-level release notes

Concrete model providers, supported OAuth integrations, and execution environments remain
later-phase work and must not be introduced into the core. The Phase 2 agent, Phase 3 browser
adapters, Phase 4 broker, and Phase 5 Codex auth experiment remain independent packages. The generic
extension still has only a mock provider; the separate Codex experiment is disabled by default and
does not establish a supported OpenAI authentication contract.
