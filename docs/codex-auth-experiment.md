# Experimental Codex authentication

Phase 5 is an interoperability experiment, not a supported authentication product. Its purpose is to
determine whether the ChatGPT sign-in flow used by the open-source Codex CLI can be hosted by a
Manifest V3 extension without weakening Loom's provider-neutral credential boundary.

The current conclusion is deliberately limited:

- Chrome provides the browser and storage primitives needed to implement an OAuth authorization code
  flow with PKCE inside an extension.
- The Codex CLI client audited here uses registered localhost callback URIs.
- A tab-scoped Manifest V3 DNR session rule can preserve the registered localhost redirect and
  transform the resulting main-frame navigation into a web-accessible extension callback page before
  localhost is contacted.
- The audited CLI also implements a device-code flow that does not require a Chrome callback, but
  its Codex-specific endpoints may be disabled and are not documented as a third-party contract.

The implemented browser flow does not invent a `chromiumapp.org` redirect. It uses the audited
`http://localhost:1455/auth/callback` URI verbatim and transforms only the browser navigation inside
the authorized extension tab. This removes the need for a localhost server but does not create an
official third-party client registration or supported OAuth product.

Normal browser login is now the primary manual experiment. Device code remains a manually selected,
disabled-by-default fallback when the browser callback cannot complete.

A user-reported manual device-code run on 2026-07-16 observed successful token issuance. That result
justifies retaining the fallback, but it is not provider support and does not remove the need to
re-audit undocumented endpoints. No live token payload is retained in this repository.

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

## Chrome callback bridge

The extension does not use `chrome.identity.launchWebAuthFlow()`, because that API requires an
extension-specific `chromiumapp.org` redirect that the audited client does not register. Instead it
opens an ordinary authorization tab with PKCE and state while preserving the exact audited
`http://localhost:1455/auth/callback` redirect URI.

Before navigation, the extension installs a `declarativeNetRequest` session rule restricted to that
single tab and main-frame requests. When the provider returns to the localhost callback, Chrome
transforms the navigation into the extension's web-accessible `callback.html`, preserving the query.
The callback consumes a session-stored bridge record, verifies tab binding, state, expiry, and
single use, exchanges the code inside the extension, then removes the DNR rule and transaction.
Nothing listens on localhost and no relay receives the code.

The flow remains disabled by default and starts only from trusted extension UI. It is an observed
compatibility experiment, not proof that OpenAI supports this extension/client combination. It must
not use an open redirect, external relay, copied CLI credential, or invented callback URI.

Device-code authentication remains an explicit fallback. It never activates silently: the trusted
extension page explains that the flow is beta, provider-specific, potentially unavailable, and
unsupported for third-party use before the user starts it.

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
  injected interfaces. Redirect request creation and callback completion are split so the extension
  can persist and resume a short-lived transaction safely.
- A leaf extension composition root may bind those interfaces to `crypto`, `fetch`, `chrome.tabs`,
  tab-scoped DNR session rules, `chrome.storage.session`, and `chrome.storage.local`. Removing that
  leaf must leave Loom Core and the shared broker unchanged.

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
- Keep refresh credentials and account routing only in trusted `chrome.storage.session`; require
  sign-in again after Chrome exits. Chrome local/sync storage is not an encrypted secret vault.
- Persist a rotated session refresh credential before using the associated access token internally.
  Deduplicate refresh and interactive authorization per provider.
- Reject external access-token requests. Status/logout may use external messages, while token use
  remains internal to the extension-owned model Port.
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
authorization/token server. Real Chromium tests may exercise the tab-scoped DNR callback bridge,
state validation, PKCE verification, token rotation, service-worker restart, exact-origin broker
access, and failure sanitization against that fake server. Device-code tests additionally cover
user-code issuance, polling intervals, pending responses, timeout, cancellation, disabled `404`
responses, malformed server PKCE, and token exchange through `/deviceauth/callback`.

CI must never contact `auth.openai.com`, use a real OpenAI account, embed a real client secret, copy
Codex credentials, or record live callback URLs. No test fixture may contain a real access, refresh,
or ID token.

A live browser or device-code test may be attempted only as a manually enabled, disabled-by-default
experiment. It must run from trusted extension UI, use a dedicated test account, warn that the
integration is not a supported third-party contract, avoid persistent artifacts, and provide
immediate logout/credential deletion. A successful manual run establishes only observed
compatibility for the audited date; it does not make either flow a stable Loom contract.

## Re-audit gate

Before enabling a manual live test, record and review:

1. the new exact Codex source commit;
2. official OpenAI authorization guidance and permission to use the client/redirect combination;
3. the exact localhost redirect URI, DNR callback transformation behavior, and for device-code mode,
   explicit confirmation that the Codex-specific device endpoints may be used by this client;
4. authorization and token parameters, token response fields, rotation, revocation, and workspace
   enforcement;
5. Chrome minimum version plus tabs, DNR session-rule, and service-worker behavior;
6. a threat-model update and evidence that no refresh credential crosses the extension boundary.
