# ADR-004: Serial, error-isolated event delivery

- Status: Accepted
- Date: 2026-07-15

## Context

Lifecycle and registry events are observational. A faulty observer must not change runtime state,
and concurrent handler execution would make ordering difficult to test and reason about.

## Decision

Event keys are typed and buses are runtime-local. Invoke handlers serially in subscription order,
attempt every handler, and route each failure to the runtime error sink. Unsubscription is
idempotent. Core-emitted payloads are immutable. Sessions use isolated event scopes.

## Consequences

Delivery is deterministic and robust to observer failures. A slow handler delays later handlers, so
high-throughput plugin protocols should use their own abstractions rather than the core event bus.
