# ADR-001: One-shot plugin lifecycle

- Status: Accepted
- Date: 2026-07-15

## Context

Plugins need deterministic setup and teardown, including partial-failure cleanup. Supporting restart
or mutation would multiply lifecycle states before the contracts are proven.

## Decision

Use `created → initialized → running → stopped → disposed`, plus terminal `failed`. Validate the
complete graph before hooks, execute initialization/start in stable topological order, and execute
stop/dispose in reverse order. Freeze registration before startup. Rollback is best-effort, cleans
owned registrations, attempts every applicable hook, and preserves all failures in typed errors.

## Consequences

Plugin authors can reason about exactly one setup and teardown. Runtime instances cannot restart or
change their plugin set; callers create a new instance instead. Cleanup hooks must tolerate partial
work and idempotent cleanup paths.
