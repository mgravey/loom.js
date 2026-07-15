# ADR-008: Extension-owned credential boundary

- Status: Accepted
- Date: 2026-07-15

## Context

Browser applications need temporary access tokens, but persisting refresh credentials in a page,
runtime configuration, session, general storage capability, or agent-visible context would broaden
their exposure. Chrome's external-message routing can connect an application page to an extension,
but a manifest match alone is too coarse for the development localhost port and does not replace
validation at the service-worker boundary.

## Decision

Keep refresh credentials entirely inside a separate Manifest V3 extension. Define a
provider-neutral, versioned `getAccessToken` protocol in a dependency-free package shared by the
extension and its Loom adapter. Return only a short-lived access token and optional expiry to the
page.

Use `externally_connectable` as the outer routing restriction and independently require the exact
configured sender origin before parsing a request. Restrict `chrome.storage.local` to
`TRUSTED_CONTEXTS` before initializing or reading credentials. Cache access tokens only in service
worker memory, deduplicate concurrent refreshes per provider, support refresh-credential rotation,
and sanitize provider failures.

Keep all actual provider authorization flows outside Phase 4. Ship only a deterministic mock
provider for composition and browser testing.

## Consequences

Loom Core remains unaware of Chrome and OAuth, and real providers can be added or replaced without
changing runtime contracts. Refresh credentials never enter page-managed Loom state. The extension
adds an installation and origin-configuration step, while service-worker restarts may require a new
refresh because the access-token cache is intentionally ephemeral. `chrome.storage.local` protects
the extension boundary when restricted to trusted contexts but is not a claim of operating-system
keychain or hardware-backed security.
