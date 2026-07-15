# Documentation

This index separates stable core behavior, the minimal Phase 2 agent, and future work.

- [Architecture](./docs/architecture.md) — runtime boundaries, composition, and state ownership
- [Plugin authoring](./docs/plugin-authoring.md) — manifests, hooks, registrations, and constraints
- [Minimal coding agent](./docs/minimal-agent.md) — Phase 2 composition and protocol boundaries
- [Testing](./docs/testing.md) — local checks, browser smoke tests, and acceptance criteria
- [Architecture decision records](./docs/adr/README.md) — rationale behind the stable contracts
- [Changes](./CHANGES.md) — milestone-level release notes

Browser platform plugins, concrete model providers, credential brokers, and execution environments
belong to later phases and must not be introduced into the core. The Phase 2 agent and workspace
tools remain independent plugins.
