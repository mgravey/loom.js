# Architecture decision records

ADRs document decisions that constrain Loom's stable core. Status values are `Proposed`, `Accepted`,
`Superseded`, or `Deprecated`.

| ADR                                           | Decision                                 | Status   |
| --------------------------------------------- | ---------------------------------------- | -------- |
| [001](./001-one-shot-lifecycle.md)            | One-shot, deterministic plugin lifecycle | Accepted |
| [002](./002-plugin-dependencies.md)           | ID-only required dependency graph        | Accepted |
| [003](./003-service-scopes.md)                | Separate scoped dependency injection     | Accepted |
| [004](./004-event-delivery.md)                | Serial, error-isolated event delivery    | Accepted |
| [005](./005-package-boundaries.md)            | Environment-neutral layered packages     | Accepted |
| [006](./006-agent-owned-protocol.md)          | Agent-owned orchestration protocol       | Accepted |
| [007](./007-explicit-browser-hosts.md)        | Explicit browser host injection          | Accepted |
| [008](./008-extension-credential-boundary.md) | Extension-owned credential boundary      | Accepted |
