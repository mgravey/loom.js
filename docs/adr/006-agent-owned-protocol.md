# ADR-006: Agent-owned orchestration protocol

- Status: Accepted
- Date: 2026-07-15

## Context

The first coding agent needs streamed model output and tool calls, but promoting one agent's message
shape into the plugin API would constrain every future agent and model integration. The coding tools
also need stable semantics without coupling them to a browser filesystem.

## Decision

Keep the normalized Codex-style model and event protocol in `@loom/agent-codex`. Keep normalized
workspace paths and list/read/write contracts in `@loom/tool-workspace`, backed by an injected text
workspace adapter. Compose the agent externally from explicitly selected capabilities after runtime
startup. Do not add agent selection, conversations, run tracking, or workspace behavior to core.

Model-provider plugins may adapt their native wire formats to the agent-owned protocol. Other agent
plugins may publish different protocols. Workspace implementations may target different hosts while
preserving the tool contracts.

## Consequences

The core remains provider- and agent-neutral. Applications perform a small amount of explicit
wiring, and a model adapter must target the selected agent protocol. Consumer-held agents are not
revoked by runtime disposal, so session cancellation and application ownership define the run
lifetime. New agents can coexist without a plugin API version change.
