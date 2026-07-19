# ADR-013: Try the experimental model fetch directly from the workbench

- Status: Accepted
- Date: 2026-07-19
- Supersedes: ADR-010 for the runnable workbench composition
- Amended by: ADR-015 for pre-response failures

## Context

The extension-owned model port hid the provider request from the workbench Network panel and made
browser CORS behavior impossible to observe directly. It also preserved a stronger credential
boundary than the experiment currently needs. A live request exposed a second issue: Loom's
Responses Lite body lagged the current Codex request contract by omitting
`reasoning.context: "all_turns"` and leaving parallel tool calls enabled.

## Decision

Keep interactive login, refresh credentials, ID-token parsing, and account-routing persistence in
the extension. Require both a manifest match and one-time user approval for the page's exact origin.
Add a provider-specific direct-auth message that returns only the current short-lived access token
and account-routing ID. The workbench holds that pair in memory, renews it through the extension
near expiry, and uses page-side fetch for every non-auth provider request.

Responses Lite requests use `reasoning.context: "all_turns"`, set `parallel_tool_calls` to `false`,
and retain the required Lite transport header. Classic requests keep their previous shape. Remove
the ChatGPT model host permission, model-port registration, and extension model-transport API.

## Consequences

The provider POST and any CORS preflight are visible in the workbench Network panel. The provider
may reject the browser preflight because this is an undocumented compatibility endpoint; that is an
experiment result, not a reason to bypass browser security.

The authorized page can now read a bearer access token and routing ID during a run. An XSS or other
same-origin compromise can therefore steal the short-lived token. Refresh and ID tokens remain in
trusted extension storage, and the direct credential response is restricted to the exact manifest
origin allowlist plus a persistent user grant. Pending origin requests remain session-only; grants
persist until revoked or the experiment is disabled. This weaker boundary is limited to the
experimental leaf and must not be presented as the production credential architecture.
