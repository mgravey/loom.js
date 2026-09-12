# ADR-016: Direct OpenAI-compatible Responses servers

- Status: Accepted
- Date: 2026-08-07

## Context

The coding workbench was coupled to the experimental ChatGPT connection even though the agent
already consumes a provider-neutral `CodexModel`. Local servers commonly expose OpenAI-compatible
Models and Responses endpoints, but do not implement Platform-only hosted programs or credential
requirements uniformly. A generic extension relay would substantially expand Companion's network
authority over localhost and private networks.

## Decision

Add an opt-in compatible factory beside the existing Platform factory in
`@mgravey/loom-model-openai-responses`. It emits the portable Responses subset, accepts optional
Bearer authentication, decodes either bounded SSE or complete JSON, and registers under a separate
model capability ID. Keep the existing Platform request and public factory unchanged.

Let the workbench contact only a user-entered HTTP(S) `/v1` base URL after an explicit Connect
action. Persist connection metadata and the explicitly supplied API key in origin-scoped browser
storage, never in project or conversation files. Require server CORS and use no extension relay,
optional host permission, cookie, redirect, or ambient fetch inside the model package.

## Consequences

Local and LAN inference is usable without an extension or cloud account, and Core, the agent
protocol, and Companion permissions remain unchanged. Tool quality and protocol compatibility depend
on the selected server/model. Hosted HTTPS pages cannot reliably reach plain HTTP LAN services, and
persisted page storage provides less protection than an extension credential vault; the UI and
documentation disclose both constraints and provide explicit key deletion.
