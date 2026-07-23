# ADR-010: Keep experimental model transport inside the extension leaf

- Status: Superseded by ADR-013
- Date: 2026-07-16

## Context

Phase 5.5 needs a browser application to call the ChatGPT-authenticated Responses implementation
audited from the open-source Codex client. The audited request requires bearer authorization and a
`ChatGPT-Account-ID` routing header. A preflight from `http://localhost:4173` to the ChatGPT backend
was rejected without an allowed CORS origin. Returning the access token to the page would also
weaken the Phase 4 extension-owned credential boundary.

The existing credential broker is intentionally provider-neutral. It exposes access-token status,
temporary token retrieval for generic auth consumers, and logout. Codex inference request bodies,
SSE events, account routing, and provider endpoint selection do not belong in that protocol.

## Decision

Add `@mgravey/loom-model-codex-experimental` as a removable leaf above the agent-owned model
protocol. Its preferred mode accepts a credential-free transport and maps generic agent messages and
tool calls to the currently audited Responses-style body. It parses streamed SSE into the Phase 2
agent protocol.

Add a separate, versioned `chrome.runtime.Port` transport to the experimental extension. The port
accepts one bounded model request from an exact authorized origin. The extension resolves its own
temporary access token and stored account-routing ID, selects the pinned provider endpoint, injects
honest Loom origin/session/request headers, performs the fetch, and relays only status and response
chunks. Port disconnect cancels the request. Errors are sanitized and provider response bodies are
not returned for rejected HTTP statuses.

Parse the initial ID token in trusted extension code and persist only the non-bearer account routing
ID in trusted storage. Do not retain or expose the raw ID token for inference routing. Keep the
model port protocol separate from `@mgravey/loom-credential-broker-api`; do not change Core or the
generic agent contract.

Publish the matching website-side Port client as `@mgravey/loom-companion-codex-experimental`. It
validates the extension stream, handles cancellation and disconnects, requests explicit approval for
the calling origin, and implements the credential-free transport contract consumed by
`@mgravey/loom-model-codex-experimental`. The provider endpoint, access token, account routing, and
privileged headers remain extension-owned.

Automated tests use only local fixtures and synthetic credentials. Live compatibility remains an
explicit, disabled-by-default manual experiment.

## Consequences

The page can run a real Loom runtime and workspace agent without possessing provider credentials.
The extension grows beyond a credential-only broker, but only in the provider-specific experimental
composition root. Removing `@mgravey/loom-extension-codex-experimental` and
`@mgravey/loom-model-codex-experimental` leaves the generic broker, Core, and agent unchanged. The
public Companion client can also be removed without changing those packages.

The transport inherits the instability of an undocumented provider backend and current event shapes.
Model IDs, headers, endpoints, and events require source re-audit before release. The extension host
permission includes the audited ChatGPT backend path, increasing its network authority. This
expansion is visible in the manifest, documentation, and threat model rather than being hidden
inside generic authentication.
