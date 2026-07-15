# ADR-003: Separate scoped dependency injection

- Status: Accepted
- Date: 2026-07-15

## Context

Plugins need internal collaborators, but exposing those helpers as discoverable capabilities would
blur the public ecosystem boundary. Runtime and session lifetimes also differ.

## Decision

Keep typed DI tokens and registrations separate from capability keys. Support value/factory
registrations with runtime-singleton, session, and transient lifetimes. Resolve async factories,
detect missing and circular dependencies, and dispose instantiated services in reverse creation
order through Loom-owned disposal contracts.

## Consequences

Capabilities remain intentional public integrations. Sessions receive child scopes while runtime
singletons remain shared within one runtime only. Factories must express dependency resolution
through the supplied scope and must not rely on global containers.
