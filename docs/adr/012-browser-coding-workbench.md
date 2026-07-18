# ADR-012: Keep coding sessions, project filesystems, and browser runtimes outside Core

- Status: Accepted
- Date: 2026-07-18

## Context

The browser example needs follow-up conversations, direct and virtual projects, archive transfer,
and JavaScript, Node.js, and Python execution. Putting those policies in Core would couple lifecycle
composition to UI state, DOM permissions, filesystem semantics, large WASM engines, and provider
credentials.

## Decision

Create three independently replaceable boundaries:

1. `@loom/coding` owns coding-session transcript, follow-up, cancellation, event, and disposal
   behavior while consuming existing model, agent, tool, and execution contracts.
2. `ProjectWorkspace` extends the portable text adapter with binary/stat/mutation operations. Memory
   and FSA/OPFS adapters implement it; safe archives and strict patches stay in
   `@loom/tool-workspace`.
3. `@loom/execution-browser` accepts only command data and project snapshots. QuickJS, WebContainer,
   and Pyodide modules load lazily and receive no credentials or host transport.

The experimental extension remains the complete ChatGPT trust boundary. Browser runtimes and project
files never receive OAuth credentials.

## Consequences

- The same coding library can run with a different model, workspace, or runtime host.
- Direct-directory permission and runtime write-back confirmation stay application-owned.
- OPFS persistence and ZIP download are UI policies, not Core storage semantics.
- WebContainer cross-origin isolation/licensing and WASM hard-cancellation limits remain explicit
  deployment concerns.
- Additional runtimes can implement the credential-free execution contract without changing Core.
