# Experimental Codex authentication

Phase 5 is an interoperability experiment, not a supported authentication product. Its purpose is to
determine whether the ChatGPT sign-in flow used by the open-source Codex CLI can be hosted by a
Manifest V3 extension without weakening Loom's provider-neutral credential boundary.

The current conclusion is deliberately limited:

- Chrome provides the browser and storage primitives needed to implement an OAuth authorization code
  flow with PKCE inside an extension.
- The Codex CLI client audited here uses registered localhost callback URIs.
- `chrome.identity` completes a web auth flow only at an extension-specific
  `https://<extension-id>.chromiumapp.org/*` redirect.
- No audited OpenAI source or public documentation confirms that the Codex CLI OAuth client accepts
  that Chrome redirect URI.
- The audited CLI also implements a device-code flow that does not require a Chrome callback, but
  its Codex-specific endpoints may be disabled and are not documented as a third-party contract.

The redirect registration mismatch is therefore a **hard blocker for the direct browser flow**. Loom
must not present that flow as working, supported, or production-ready until OpenAI explicitly
registers and supports a stable extension redirect URI for an appropriate client. Reusing a public
client ID does not grant permission to invent another redirect URI.

The device-code path is the preferred Phase 5 feasibility experiment because it avoids that redirect
substitution. It remains disabled by default, manually initiated, and explicitly unsupported. Its
availability does not remove the blocker from the direct `launchWebAuthFlow()` design.

A user-reported manual device-code run on 2026-07-16 observed successful token issuance. That result
justifies building the Phase 5.5 vertical slice, but it is not provider support and does not remove
either the direct-redirect blocker or the need to re-audit undocumented endpoints. No live token
payload is retained in this repository.

## Evidence snapshot

This analysis pins behavior to OpenAI Codex commit
[`38b064c31b1f7464b281006316ec878ed23fea77`](https://github.com/openai/codex/tree/38b064c31b1f7464b281006316ec878ed23fea77).
Later Codex versions may differ and require a new audit.

Phase 5.5 separately re-audited the inference protocol at current Codex commit
[`9ff47868eb2afeec579183e01bb9d3d3e9df2bcd`](https://github.com/openai/codex/tree/9ff47868eb2afeec579183e01bb9d3d3e9df2bcd).
The auth and inference request behavior relevant to Loom was unchanged from the Phase 5 pin. The
ChatGPT-authenticated client uses `POST https://chatgpt.com/backend-api/codex/responses`, bearer
authentication, and `ChatGPT-Account-ID`. This is distinct from the documented OpenAI Platform
Responses endpoint and remains an implementation detail.

OpenAI's [Codex authentication documentation](https://developers.openai.com/codex/auth) says that
ChatGPT sign-in opens a browser, returns credentials to Codex, caches them locally, and refreshes
ChatGPT tokens automatically during use. It also documents file, OS-keyring, and automatic
credential-store modes. Loom does not copy credentials from `~/.codex`, the Codex OS-keyring entry,
or another installed client.

At the pinned commit, the CLI's
[`server.rs`](https://github.com/openai/codex/blob/38b064c31b1f7464b281006316ec878ed23fea77/codex-rs/login/src/server.rs)
and
[`pkce.rs`](https://github.com/openai/codex/blob/38b064c31b1f7464b281006316ec878ed23fea77/codex-rs/login/src/pkce.rs)
implement the following browser flow:

1. Generate a PKCE verifier from 64 random bytes and derive a base64url SHA-256 challenge.
2. Generate an independent random `state` value.
3. Bind a short-lived HTTP callback server, normally on port `1455`, with `1457` as the documented
   fallback in the source.
4. Build `https://auth.openai.com/oauth/authorize` with an authorization-code response, the public
   client ID, `openid profile email offline_access`, the exact localhost redirect URI, the PKCE
   challenge with `S256`, and `state`. The implementation also supplies Codex-specific request
   metadata.
5. Accept `/auth/callback` only when the returned state matches and an authorization code is
   present.
6. POST the code, exact redirect URI, client ID, and verifier to
   `https://auth.openai.com/oauth/token` as form data.
7. Require ID, access, and refresh tokens, enforce any configured workspace restriction, and save
   the credential set through the CLI's selected auth store. The implementation may additionally
   exchange the ID token for an API-key-style token.

These are observations of one audited implementation, not a stable OpenAI OAuth contract. Endpoint
paths, request metadata, client registration, token fields, workspace claims, and refresh behavior
can change independently of Loom.

### Audited device-code path

The pinned
[`device_code_auth.rs`](https://github.com/openai/codex/blob/38b064c31b1f7464b281006316ec878ed23fea77/codex-rs/login/src/device_code_auth.rs)
also implements a Codex-specific device-code flow:

1. POST the client ID as JSON to `/api/accounts/deviceauth/usercode`.
2. Show the returned user code and direct the user to `/codex/device`.
3. Poll `/api/accounts/deviceauth/token` using the returned device-auth ID, user code, and server
   interval for up to 15 minutes.
4. Receive an authorization code plus a server-supplied PKCE verifier and challenge.
5. Exchange the authorization code and verifier at `/oauth/token` with the redirect URI
   `/deviceauth/callback`, then apply the same workspace check and credential persistence as the
   browser flow.

The source treats a `404` from the user-code endpoint as “device code login is not enabled,” and the
[Codex authentication documentation](https://developers.openai.com/codex/auth#login-on-headless-devices)
describes device-code authentication as beta. Loom must therefore expect administrator- or
deployment-level disablement. These private-looking endpoint shapes and response fields are audited
behavior, not permission or a promise that another client may rely on them.

## Chrome feasibility and blocker

Chrome's [`identity` API](https://developer.chrome.com/docs/extensions/reference/api/identity)
supports non-Google providers through `launchWebAuthFlow()`. `getRedirectURL()` produces a URI in
the form `https://<extension-id>.chromiumapp.org/*`, and the flow resolves when navigation reaches
that URI. Chrome also recommends starting interactive authorization from explanatory extension UI,
not silently at startup.

That mechanism can host PKCE, state validation, code exchange, cancellation, and error handling. It
cannot make an authorization server accept an unregistered redirect URI. The audited Codex source
explicitly constructs `http://localhost:<port>/auth/callback` and notes that its ports must stay
synchronized with the Codex CLI redirect allowlist. A Chrome service worker cannot reproduce the
CLI's local TCP callback server, while `launchWebAuthFlow()` requires the `chromiumapp.org`
callback.

The extension ID is part of the Chrome redirect URI. A viable registration would consequently need a
stable extension ID and an OpenAI-supported redirect entry for that exact origin/path. Until that
exists, the experiment stops before live authorization. It must not work around the block using an
open redirect, a relay that receives credentials for the extension, a copied CLI refresh token, or
an unverified redirect substitution.

Device-code authentication is documented by OpenAI as an alternative where the localhost callback
cannot work. Phase 5 may implement it as the preferred, disabled-by-default manual experiment. It
must never activate as a silent fallback: a trusted extension page must explain that the flow is
beta, provider-specific, potentially unavailable, and unsupported for third-party use before the
user starts it.

The direct authorization-code flow remains a separate disabled mode. Even if the device-code
experiment succeeds, `launchWebAuthFlow()` must remain blocked until the exact Chrome redirect is
registered and supported.

## Package boundary

The concrete provider remains outside Loom Core and the provider-neutral broker:

```text
@loom/credential-broker-api
            |
            v
@loom/credential-provider-api
       |                  |
       v                  v
@loom/extension   @loom/auth-codex-experimental
       |                  |
       +---------+--------+
                 v
  experimental extension composition root
```

- `@loom/credential-broker-api` remains the versioned, provider-neutral page/extension protocol.
- `@loom/credential-provider-api` contains only structural credential-provider contracts and typed
  provider failures.
- `@loom/extension` owns generic origin authorization, trusted storage, token caching, refresh
  coordination, and error sanitization. It contains no Codex endpoints or parameters.
- `@loom/auth-codex-experimental` contains the audited provider-specific request construction and
  parsing for explicit device-code and direct-browser modes. Secure randomness, SHA-256, HTTP
  transport, clock, redirect launch, polling/sleep, and authorization transaction storage are
  injected interfaces. Direct-browser mode is unavailable unless the composition root supplies an
  explicit redirect-registration approval.
- A leaf extension composition root may bind those interfaces to `crypto`, `fetch`,
  `chrome.identity`, `chrome.storage.session`, and `chrome.storage.local`. Removing that leaf must
  leave Loom Core and the shared broker unchanged.

The application page retains the Phase 4 API for provider-neutral status, temporary token access,
and logout by explicit provider ID. The Phase 5.5 application itself does not request a token: it
uses a separate credential-free model Port, and the extension injects the access token and account
routing ID into the provider request. The page cannot receive refresh or ID tokens and cannot
initiate an interactive flow. A trusted extension page must initiate any manual experiment after
explaining its status and risks.

## Security and threat model

### Protected assets

- refresh, access, and ID tokens;
- authorization codes and PKCE verifiers;
- OAuth state and redirect data;
- account and workspace identifiers derived from tokens;
- the exact configured provider endpoints and extension origin allowlist.

### Relevant attackers and failures

- an authorized Loom page compromised by cross-site scripting;
- a page outside the exact broker origin allowlist;
- another extension or code injected into this extension;
- a local user or process with access to the Chrome profile;
- network interception, malicious redirects, and authorization-code interception;
- stale service-worker memory, concurrent refreshes, token rotation races, and replayed callbacks;
- secrets leaked through logs, error bodies, URLs, DOM, test artifacts, or runtime events.

### Required controls

- Use authorization code plus PKCE `S256`; never accept `plain`. PKCE follows
  [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636).
- Generate verifier and state with injected cryptographically secure randomness. Make state
  high-entropy, short-lived, single-use, and bound to the exact provider and redirect URI.
- Validate the final redirect origin and path exactly before reading its query, then validate state
  before exchanging the code.
- Use TLS for authorization and token endpoints and follow the current OAuth security practices in
  [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700).
- Begin interactive authorization only from an explicit gesture in trusted extension UI.
- For device-code mode, pin the expected issuer and endpoint paths, honor the server polling
  interval, enforce a bounded timeout, support cancellation, and reject malformed or inconsistent
  authorization-code/PKCE responses. Display the user code only in trusted extension UI with an
  anti-phishing reminder to continue only when the user initiated the flow.
- Keep the verifier and transaction state in `chrome.storage.session`, with a short expiry and
  trusted-context access. Chrome documents session storage as in-memory extension storage that is
  cleared on reload, update, disable, and browser restart.
- Keep refresh credentials only in `chrome.storage.local` after restricting it to
  `TRUSTED_CONTEXTS`. Chrome's
  [`storage` API](https://developer.chrome.com/docs/extensions/reference/api/storage) does not
  constitute OS-keyring, hardware-backed, or at-rest encryption protection.
- Persist a rotated refresh credential before exposing the associated access token. Deduplicate
  refresh and interactive authorization per provider.
- Return only the access token and expiry through the Phase 4 broker. Never place secrets in Loom
  configuration, sessions, events, IndexedDB, agent/tool inputs, or page logs.
- For the experimental model Port, resolve the token and `ChatGPT-Account-ID` only in the extension.
  Return authentication state, sanitized status, and response chunks—not credentials—to the page.
- Parse initial account routing inside trusted extension code. Persist only the account ID needed
  for routing; do not persist the raw ID token merely to recover that claim later.
- Sanitize OAuth and HTTP failures. Do not include codes, verifiers, tokens, callback query strings,
  raw token responses, or token-derived claims in ordinary logs.
- Use minimal extension permissions and exact endpoint/origin allowlists. Do not add content scripts
  for this flow.
- Treat service-worker globals as disposable. Chrome's
  [service-worker lifecycle documentation](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
  says globals are lost on shutdown; correctness must come from scoped storage and idempotent
  operations.

The extension boundary cannot protect against malicious code already executing with trusted
extension privileges or a fully compromised Chrome profile. This limitation must remain explicit in
any manual test instructions.

## Test and release policy

Automated tests use deterministic injected randomness and digest results plus a local fake OAuth
authorization/token server. Real Chromium tests may exercise `chrome.identity`, the generated
callback, state validation, PKCE verification, token rotation, service-worker restart, exact-origin
broker access, and failure sanitization against that fake server. Device-code tests additionally
cover user-code issuance, polling intervals, pending responses, timeout, cancellation, disabled
`404` responses, malformed server PKCE, and token exchange through `/deviceauth/callback`.

CI must never contact `auth.openai.com`, use a real OpenAI account, embed a real client secret, copy
Codex credentials, or record live callback URLs. No test fixture may contain a real access, refresh,
or ID token.

A live **direct-browser** test is permitted only after the redirect-registration blocker is resolved
by explicit OpenAI support. A live **device-code** test may be attempted earlier only as a manually
enabled, disabled-by-default experiment. It must run from trusted extension UI, use a dedicated test
account, warn that the beta endpoint may be disabled and is not a supported third-party contract,
avoid persistent artifacts, and provide immediate logout/credential deletion. A successful manual
device-code run establishes only observed compatibility for the audited date; it neither resolves
the Chrome redirect blocker nor makes the flow a stable Loom contract.

## Re-audit gate

Before enabling a manual live test, record and review:

1. the new exact Codex source commit;
2. official OpenAI authorization guidance and permission to use the client/redirect combination;
3. for direct-browser mode, the registered redirect URI and stable extension ID; for device-code
   mode, explicit confirmation that the Codex-specific device endpoints may be used by this client;
4. authorization and token parameters, token response fields, rotation, revocation, and workspace
   enforcement;
5. Chrome minimum version and `identity`/service-worker behavior;
6. a threat-model update and evidence that no refresh credential crosses the extension boundary.
