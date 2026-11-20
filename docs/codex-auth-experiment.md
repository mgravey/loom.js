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

## Extension-free Sign in with ChatGPT

As checked on 2026-10-22, OpenAI documents a newer
[Sign in with ChatGPT integration](https://developers.openai.com/siwc/quickstart) for external apps.
The workbench's sole **ChatGPT** connection is a browser-only local interoperability test of that
protocol. It uses no extension, API key, client secret, model relay, or token backend. The old
extension's "direct-first" integration remains in the library, outside this workbench.

The implementation is published as the reusable, host-neutral
[`@mgravey/loom-auth-chatgpt-browser`](../packages/auth-chatgpt-browser/README.md) package. The
workbench configures it with its app name (`Loom.js`), its legacy storage keys and callback message
type, and local-only notices. Its static `/auth/callback` page loads the package's
`completeChatGPTBrowserCallback()` helper; a single-page app can call the same helper from its own
route.

### Documentation re-check (2026-11-20)

The sub-pages for sign-in, accounts and sessions, models and inference, token reference, errors and
recovery, preview limitations, and UI/UX guidelines were re-read on 2026-11-20. Resulting changes:

- The undocumented `prompt=consent` parameter is no longer sent. Reauthorizing a saved registration
  sends the issued `client_id`, the stable `ext_agent_host_id`, and fresh state/nonce/PKCE, plus the
  documented `id_token_hint` (only while the ID token is still in memory) or `login_hint` (the
  verified email). `agent_name_hint` is sent only on first registration.
- Reauthorization with an issued client shows no consent screen, so a verified sign-in without
  `chatgpt.tokens.use.direct` keeps the session with plan usage disabled, as documented.
- All documented `subscription_sharing_*` and `chatpass_v2_*` Responses codes are mapped to stable
  error kinds (`usage-limit-reached`, `user-not-eligible`, `temporarily-unavailable`,
  `unsupported-capability`, `credential-rejected`, `client-configuration`), from HTTP error bodies
  and `response.failed`/`error` stream events. Uncoded direct-admission 401/403/503 responses map to
  `credential-rejected`, `access-denied`, and `temporarily-unavailable`. Only allowlisted codes and
  a format-checked `x-request-id` are exposed.
- Explicit `system` message items are rejected by the route; they are still sent as `developer`. The
  documented unsupported request fields remain filtered out.
- The total per-request lifetime is configurable and now defaults to 10 minutes instead of 2, so
  long tool-using generations are not aborted mid-stream.
- The docs describe protected local credential storage and retaining the ID token for
  `id_token_hint`. This browser adaptation intentionally keeps all tokens in memory, so a reload
  requires a fresh sign-in.

### Start the browser-only test

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev:chatgpt
```

Open the printed URL: <http://127.0.0.1:4174/example-codex-experimental/workbench.html>. Use
`127.0.0.1`, not `localhost`: the new OpenAI registration contract specifies that exact host. If
port 4174 is busy, use `LOOM_BROWSER_PORT=4175 pnpm dev:chatgpt`. Keep the same origin between tests
to reuse the browser's non-secret registration metadata.

1. In the **ChatGPT** account card, click **Continue with ChatGPT**. Allow the sign-in popup if your
   browser blocks it.
2. Sign in on OpenAI's page, choose the account/workspace, and consent to ChatGPT plan usage for
   Loom.js. The popup returns to `/auth/callback`; the original tab completes verification.
3. Check the displayed account and plan status. A verified identity without the plan permission
   cannot run models. OpenAI documents no consent screen when reauthorizing an issued registration,
   so review the permissions again by adding the account as a new registration. The model picker
   uses the account's advertised catalogue.
4. Choose **Temporary browser project**, click **Open workspace**, and send
   `Reply with exactly: Loom login test OK. Do not use tools.` Login and a completed model response
   are separate checks; stop on any provider rejection and record only its sanitized error.
5. Use **Manage usage** to open <https://chatgpt.com/settings/usage>. OpenAI's
   [UI guidance](https://developers.openai.com/siwc/ui-ux-guidelines) identifies this as the place
   to manage plan/app usage. The old Codex device-code Security toggle is not required by this flow.
6. Sign out when finished. Reloading or closing the workbench also discards its in-memory tokens; it
   does not prove the remote grant was revoked. Saved public registration metadata supports
   returning sign-in without registering a new client each time.

Temporary refresh failures retain the in-memory session so you can retry. A confirmed expired,
revoked, or reused refresh grant clears the session and requires signing in again. The UI shows
sanitized recovery instructions without displaying OpenAI's raw error bodies.

### ChatGPT Business workspace denial

On 2026-10-22, an administrator testing a ChatGPT Business workspace observed
`3p_delegated_access_policy_denied` on OpenAI's hosted authorization page, despite the
organization's External access identity default showing Allowed. This happens before Loom can
receive and verify the callback, and is separate from the browser public-metadata CORS failure.

The
[Admin Console guide](https://help.openai.com/en/articles/12289294-managing-your-tenant-in-admin-console)
documents identity, connected-app, and Ads permissions, but does not identify a Business control for
`dynamic_agent_client` and `chatgpt.tokens.use.direct`. Enabling connected-app sharing is not an
established remedy. The [developer quickstart](https://developers.openai.com/siwc/quickstart)
describes eligible Plus/Pro users, while the
[Help Center](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)
says supported open-source tools remain available to all users. These statements do not establish
Business eligibility or explain this particular denial. A personal Free-account test separately
showed the requested permission unavailable and an upgrade prompt; do not infer successful Free
inference from the broad Help Center wording.

[Pi issue 10953](https://github.com/earendil-works/pi/issues/10953) contains a matching firsthand
Business report and an inability to locate the relevant admin control. It corroborates the observed
failure but is not an official eligibility determination.

Request OpenAI Support to confirm whether Business supports the exact OSS flow and, if so, identify
the required role and control or investigate the workspace's policy/rollout state. Include the
workspace/organization identifiers privately, error code, request ID, timestamp/time zone, and
screenshots of saved settings. Do not send callback codes or tokens. This project does not
substitute another application's client ID or relax validation to work around the policy denial.

### Where authentication runs

The static server binds only to `127.0.0.1`, accepts only GET/HEAD, and maps `/auth/callback` to a
static HTML page. It never exchanges authorization codes, stores credentials, forwards model calls,
or logs requests. As with any query-based OAuth callback, the browser requests the callback URL with
its one-time code; the static handler discards the query and sends the same file. The popup passes
that code to the original tab, which holds the PKCE verifier and exchanges it directly with OpenAI.
Access, refresh, and ID tokens never go to the file server.

The browser generates state, nonce, and PKCE values; validates the callback origin/source and the ID
token's signature, issuer, audience, expiry, and nonce; and requires the granted
`chatgpt.tokens.use.direct` scope. All tokens and active login transactions stay in memory. Web
Storage contains only non-secret host/account-registration metadata and UI preferences. Losing the
tab means signing in again. Keep runtime browser diagnostics private; do not export token responses
or callback query strings into issues.

Model discovery and streaming go directly to `https://api.openai.com/v1` with the user's OAuth
token. Requests use `store: false`, `stream: true`, and full input history. The integration must
observe `response.completed`; an interrupted stream or `[DONE]` alone is not successful inference.
See
[models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
and
[preview limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

### Evidence and public deployment limits

Live credential-free GET checks on 2026-10-22 from `http://127.0.0.1:50412` failed in Chromium for
both `https://auth.openai.com/.well-known/openid-configuration` and
`https://auth.openai.com/.well-known/jwks.json`. The console explicitly reported missing
`Access-Control-Allow-Origin`. Direct HTTP checks returned 200 with no such header for both. This
blocks the current browser-only identity verification even if authorization returns a client
registration. It is independent of the organization-policy denial seen for a different login. No
live token response was inspected, and successful authenticated token/API CORS remains unverified.

The popup closes on both successful and failed attempts. The workbench now retains sanitized errors
next to the login button. An unverified registration in the account picker is public client
metadata, not a signed-in session; retrying uses that registration instead of creating a new one.
Signature verification remains mandatory. This prototype does not proxy credentials or disable
browser security to bypass the missing public-metadata CORS support.

A credential-free re-test on 2026-11-20 (GET with `Origin: http://127.0.0.1:4174`, outside a
browser) returned HTTP 200 without `Access-Control-Allow-Origin` for both the discovery document and
`/.well-known/jwks.json`; OPTIONS returned 405 and 404 respectively. The blocker is unchanged:
browser ID-token verification still fails before a session is created. The token endpoint and
`api.openai.com/v1` returned `Access-Control-Allow-Origin: *` for OPTIONS and for unauthenticated
400/401 responses, and the API exposes `X-Request-ID`.

Credential-free OPTIONS checks on 2026-10-22 returned HTTP 200 and CORS permission for the token,
models, and Responses endpoints from `http://127.0.0.1:4173` and `https://mgravey.com`. Preflight
success does not verify authenticated response headers, account eligibility, callback acceptance, or
successful live inference. Automated fixtures also cannot establish those facts.

OpenAI's
[open-source registration guide](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
documents dynamic registration with an HTTP `127.0.0.1` callback and a trusted local runtime. Its
[session guidance](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
describes protected runtime credential storage. It does not establish official support for this
browser-only adaptation, which deliberately keeps credentials out of persistent browser storage.
This is a local compatibility test, not a claim that a fully static production website is approved.

The intended product remains public static hosting with all credentials and inference in the user's
browser. The [website integration guide](https://developers.openai.com/siwc/website) currently
describes an approved client, registered callback, and backend, so it is not that architecture.
Before enabling the direct provider on an HTTPS website, obtain confirmation of a public browser
client with an HTTPS callback, ChatGPT plan scopes, and browser token/refresh/revocation/JWKS/API
access. Publishing the source on GitHub does not itself register that callback. Do not substitute an
unregistered public URL in the dynamic loopback flow or add a credential proxy as a workaround.

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
@mgravey/loom-credential-broker-api
            |
            v
@mgravey/loom-credential-provider-api
       |                  |
       v                  v
@mgravey/loom-extension   @mgravey/loom-auth-codex-experimental
       |                  |
       +---------+--------+
                 v
  experimental extension composition root
```

- `@mgravey/loom-credential-broker-api` remains the versioned, provider-neutral page/extension
  protocol.
- `@mgravey/loom-credential-provider-api` contains only structural credential-provider contracts and
  typed provider failures.
- `@mgravey/loom-extension` owns generic origin authorization, trusted storage, token caching,
  refresh coordination, and error sanitization. It contains no Codex endpoints or parameters.
- `@mgravey/loom-auth-codex-experimental` contains the audited provider-specific request
  construction and parsing for explicit device-code and direct-browser modes. Secure randomness,
  SHA-256, HTTP transport, clock, redirect launch, polling/sleep, and authorization transaction
  storage are injected interfaces. Redirect request creation and callback completion are split so
  the extension can persist and resume a short-lived transaction safely.
- A leaf extension composition root may bind those interfaces to `crypto`, `fetch`, `chrome.tabs`,
  tab-scoped DNR session rules, `chrome.storage.session`, and `chrome.storage.local`. Removing that
  leaf must leave Loom Core and the shared broker unchanged.

The application page retains the Phase 4 API for provider-neutral status and logout by explicit
provider ID. Phase 5.5 also defines a provider-specific direct-auth message: a manifest-eligible
workbench origin must first receive explicit user approval in trusted extension UI, then it can
request a short-lived access token and account-routing ID and perform all non-auth provider requests
directly when browser CORS permits. A failure before an HTTP response retries the credential-free
body through the origin-authorized extension. The page cannot receive refresh or ID tokens and
cannot initiate an interactive flow. A trusted extension page must initiate any manual experiment
after explaining its status and risks.

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
- Keep refresh credentials and account routing in trusted `chrome.storage.session` by default. An
  explicit, confirmed private-computer option may move that pair to trusted `chrome.storage.local`,
  scoped to the current Chrome profile. Never use page storage or `chrome.storage.sync`; local
  extension storage is not an encrypted secret vault.
- Persist a rotated refresh credential to the selected extension storage area before using the
  associated access token. Deduplicate refresh and interactive authorization per provider.
- Treat the persistence preference and authorization pair as coordinated state. Migrate by writing
  the destination before changing the preference, remove inactive or incomplete copies during
  initialization, and scrub both storage areas on logout, experiment disable, or credential
  rejection.
- Keep generic credential-broker access-token requests disabled. The separate experimental
  direct-auth message may return only the current short-lived access token and routing ID to an
  exact manifest-eligible, user-approved origin; it must never return refresh or ID tokens.
- Persist approved exact origins separately from credentials, keep pending requests session-only,
  and clear all origin grants when the experiment is disabled. A manifest match is necessary but
  never sufficient for token delivery.
- Treat the authorized workbench origin as bearer-credential-sensitive. Do not run untrusted scripts
  there, persist the direct credential response, or include it in logs and diagnostics.
- Restrict the extension model relay to direct pre-response failures. Never copy page authorization
  headers into the Port request, and never retry HTTP errors, stream failures, or cancellation.
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
