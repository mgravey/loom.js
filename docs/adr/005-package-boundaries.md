# ADR-005: Environment-neutral layered packages

- Status: Accepted
- Date: 2026-07-15

## Context

The same runtime must load in browser windows, dedicated workers, and other ESM hosts. Provider or
environment knowledge in the core would prevent independent replacement.

## Decision

Layer packages as `types ← plugin-api ← core`, with examples/plugins importing public exports only.
Compile runtime source against ES2022 without DOM or Node typings. Enforce boundaries with
TypeScript, ESLint restrictions, export smoke tests, and real Chromium tests. Keep concrete
providers, environments, and browser APIs out of Phase 1 packages.

## Consequences

Core code cannot use otherwise convenient host APIs and instead relies on injected clocks,
cancellation, disposal, and capability contracts. Environment adapters remain independently
replaceable plugins. Browser-specific code is allowed only in compatibility harnesses until the
browser-platform phase.
