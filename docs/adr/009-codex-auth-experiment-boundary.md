# ADR-009: Isolate and gate the Codex authentication experiment

- Status: Accepted
- Date: 2026-07-15

## Context

Phase 5 asks whether the open-source Codex CLI's ChatGPT OAuth flow can run in a Manifest V3
credential-broker extension. The audited CLI implementation at commit
[`38b064c31b1f7464b281006316ec878ed23fea77`](https://github.com/openai/codex/tree/38b064c31b1f7464b281006316ec878ed23fea77)
uses an authorization-code flow with PKCE `S256`, validates state, receives a callback at
`http://localhost:<registered-port>/auth/callback`, exchanges the code at the token endpoint, and
persists access, ID, and refresh credentials. OpenAI's
[Codex authentication documentation](https://developers.openai.com/codex/auth) describes browser
sign-in, local credential caching, and automatic refresh but does not define a public third-party
OAuth client contract.

Chrome can launch a provider flow, but
[`chrome.identity.getRedirectURL()`](https://developer.chrome.com/docs/extensions/reference/api/identity#getRedirectURL)
produces `https://<extension-id>.chromiumapp.org/*`. No audited OpenAI source confirms that the
Codex CLI client registration permits that URI. PKCE protects a code from interception; it does not
relax redirect registration.

The same audited commit also contains a
[`device_code_auth.rs`](https://github.com/openai/codex/blob/38b064c31b1f7464b281006316ec878ed23fea77/codex-rs/login/src/device_code_auth.rs)
flow. It requests a user code, sends the user to `/codex/device`, polls for an authorization code
and server PKCE material, and exchanges that code with `/deviceauth/callback` as its redirect URI.
This avoids `chromiumapp.org`, but the source explicitly handles device auth being disabled, and
OpenAI documents device-code login as beta rather than as a supported third-party OAuth contract.

## Decision

Keep Codex OAuth in a provider-specific experimental leaf package behind provider-neutral credential
contracts. Inject secure randomness, SHA-256, HTTP, clock, redirect, and transaction storage. Bind
Chrome APIs only in a separate extension composition root. Do not change Loom Core, the Loom plugin
API, the external Phase 4 `getAccessToken` protocol, or generic broker behavior to accommodate
Codex.

Treat the localhost-versus-`chromiumapp.org` redirect mismatch as a hard blocker. Do not enable or
advertise live authentication until OpenAI explicitly supports a stable redirect URI for the exact
extension/client combination. Do not substitute an open redirect, credential relay, copied CLI
credential, or unregistered callback.

Prefer device-code mode for the feasibility experiment because it does not substitute a redirect.
Keep it disabled by default and available only through a manual gesture in trusted extension UI with
an explicit experimental/unsupported warning. Treat a disabled endpoint, `404`, policy denial, or
incompatible response as an expected negative result, not as permission to fall back silently.
Device-code success does not unblock direct `launchWebAuthFlow()`.

Keep interactive authorization manual and opt-in from trusted extension UI. CI uses only a fake
OAuth server and synthetic credentials; it never contacts live OpenAI authentication endpoints. Use
PKCE `S256` and state in accordance with [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636) and
[RFC 9700](https://www.rfc-editor.org/rfc/rfc9700). Keep short-lived transaction material in trusted
`chrome.storage.session`, refresh credentials in trusted `chrome.storage.local`, and return only a
temporary access token through the broker.

## Consequences

The experiment can model and test the complete browser mechanism without claiming unsupported
provider interoperability. A Codex or OpenAI change can replace or remove the leaf package without
affecting Loom Core, existing auth adapters, or other credential providers.

Live feasibility remains unresolved until redirect registration is documented and tested with
permission. `chrome.storage.local` is a weaker at-rest boundary than an OS credential store and does
not protect against compromised extension code or a compromised browser profile. Every future live
attempt requires a source re-audit, a security review, a stable extension identity, and explicit
manual activation.

The device-code experiment can be tested manually before Chrome redirect registration only to record
whether the audited beta endpoints accept the client at that moment. Such a result is not a support
statement, must not be enabled by default, and cannot graduate without explicit provider
authorization and a renewed threat-model review.
