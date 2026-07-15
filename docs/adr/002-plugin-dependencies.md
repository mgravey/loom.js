# ADR-002: ID-only required dependency graph

- Status: Accepted
- Date: 2026-07-15

## Context

Lifecycle order must be reproducible without coupling the core to package managers or loading
strategies. Optional integrations should not prevent otherwise valid composition.

## Decision

Manifests declare separate required and optional namespaced plugin-ID lists. Only required IDs are
validated and included in the dependency graph. Stable topological sorting preserves caller input
order between equally eligible plugins. Version-range negotiation is deferred; the numeric plugin
API version is checked separately.

## Consequences

Missing required plugins and cycles fail before hooks. Optional plugins do not affect order and must
be resolved during `start`. Compatibility between plugin-specific versions remains the application's
responsibility during Phase 1.
