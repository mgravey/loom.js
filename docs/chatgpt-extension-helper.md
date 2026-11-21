# Website ChatGPT sign-in helper (Loom.js Companion)

OpenAI's open-source **Sign in with ChatGPT** registration accepts only a
`http://127.0.0.1:<port>/auth/callback` redirect, and several of its responses carry no CORS
headers. A public website therefore cannot run
[`@mgravey/loom-auth-chatgpt-browser`](../packages/auth-chatgpt-browser/README.md) on its own. The
Loom.js Companion extension adds a generic, opt-in helper so that **any website the user has
approved in the extension** can run the same page-held flow. Nothing is specific to a website or
product.

The website still runs the whole OAuth flow (state, nonce, PKCE, code exchange, ID-token
verification, refresh) and holds every token in its own memory (or its own opt-in `sessionStore`).
The extension only:

1. **Captures the redirect.** It opens the sign-in window itself, installs a declarativeNetRequest
   session rule scoped to that one tab that rewrites the navigation to
   `http://127.0.0.1:1456/auth/callback?…` into its packaged `chatgpt-callback.html` before anything
   is sent to 127.0.0.1, and returns the callback only to the page port that started the attempt.
2. **Relays four fixed requests** whose successful responses a page cannot read: OpenAI's OpenID
   configuration and JWKS (GET, no credentials), `GET /v1/models` and streaming `POST /v1/responses`
   (with the bearer token the page supplies per request).

## Why this mechanism

- **Extension-owned window + tab-scoped DNR rule** (the pattern Companion already uses for its Codex
  login) rather than `webNavigation`/`tabs` observation: observation cannot stop the request, so the
  authorization code would reach any local process listening on that port, and it needs the "Read
  your browsing history" permission. A DNR redirect is applied before the request is sent, is
  limited to one tab ID, and needs no new install-time permission (`declarativeNetRequest` is
  already declared). Opening the window from the extension also gives a known tab ID and removes the
  popup-blocker and user-gesture constraints.
- **Fixed port 1456.** Because the rule is scoped to the sign-in tab, a real server on that port in
  other tabs is unaffected, and the navigation never reaches it. A fixed port keeps the
  `redirect_uri` stable across sign-ins for the same issued client.
- **One Chrome port per operation** (`loom/chatgpt-helper/v1`). Ports give request scoping, abort
  propagation (disconnect or `cancel`), and streaming. Responses flow with **credit-based
  backpressure**: at most 8 unacknowledged chunks are in flight and the page acknowledges a chunk
  only when its consumer pulls it, so the extension stops reading from OpenAI when the page is slow.
  Pages send a ping every 20 s so the service worker is not stopped during a long sign-in or a quiet
  stream.

## Page-side API

`@mgravey/loom-auth-chatgpt-browser`:

- `createChatGPTBrowserClient({ …, redirectBroker })` — optional `ChatGPTBrowserRedirectBroker`
  (`redirectUri`, `authorize({ authorizationUrl, state, signal })` resolving to
  `{ status: 'callback', url } | { status: 'cancelled' | 'unavailable' | 'failed' }`). With a broker
  the client opens no popup, accepts any page origin, and validates the callback against the
  broker's `redirectUri` and the attempt's `state`. Combine it with the existing `fetch` option.
- `detectChatGPTBrowserSupport(environment, { redirectBroker: true })` reports
  `{ supported: true, mode: 'redirect-broker' }`. Without the option the result is unchanged.

`@mgravey/loom-companion-codex-experimental`:

- `getCompanionChatGPTHelperStatus({ runtime, extensionId? })` → `{ available: true, redirectUri }`
  or `{ available: false, reason }` with `reason` one of `extension-unavailable`,
  `origin-not-approved`, `helper-disabled`, `unsupported-version`. Never throws.
- `createCompanionChatGPTHelper({ runtime, extensionId?, redirectUri, fallbackFetch? })` →
  `{ redirectBroker, fetch, clientOptions }`. `fetch` relays only the four allowlisted method+URL
  pairs and passes everything else (including the token endpoint) to `fallbackFetch` (default:
  global `fetch`).
- `connectCompanionChatGPTHelper(options)` → `{ status, helper? }` combining both.

```ts
import { createChatGPTBrowserClient } from '@mgravey/loom-auth-chatgpt-browser';
import { connectCompanionChatGPTHelper } from '@mgravey/loom-companion-codex-experimental';

const { status, helper } = await connectCompanionChatGPTHelper({
  runtime: () => globalThis.chrome?.runtime,
});
// Without the helper this is exactly today's client (loopback origins only).
const chatgpt = createChatGPTBrowserClient({ appName: 'My App', ...helper?.clientOptions });
if (!chatgpt.getStatus().supported) explain(status); // e.g. ask the user to approve this site
```

A session restored through `sessionStore` on a non-loopback origin uses the same helper `fetch`, so
its ID-token re-verification, model list and responses go through the relay; the refresh itself goes
directly to the token endpoint, which is CORS-readable.

## Message contract (extension side)

All messages carry `protocol: 'loom/chatgpt-helper'`, `version: 1` and a `requestId`
(`[a-zA-Z0-9._:-]{1,256}`).

| Direction  | Message                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| one-shot   | `getStatus` → `status` `{ ok, approved, enabled?, redirectUri? }` (`ok:false` + `error.code` otherwise)       |
| page → ext | `authorize` `{ authorizationUrl, state }`                                                                     |
| ext → page | `authorizing`, then `callback` `{ url }` or `error` `{ code }`                                                |
| page → ext | `fetch` `{ target, authorization?, body? }`, `target` ∈ `openid-configuration`, `jwks`, `models`, `responses` |
| ext → page | `head` `{ status, contentType?, providerRequestId? }`, `chunk` `{ sequence, data }`…, `end` or `error`        |
| page → ext | `ack` (one per consumed chunk), `cancel`, `ping`                                                              |

Error codes: `UNAUTHORIZED_REQUEST`, `HELPER_DISABLED`, `INVALID_REQUEST`, `BUSY`,
`SIGN_IN_CANCELLED`, `SIGN_IN_EXPIRED`, `WINDOW_UNAVAILABLE`, `CALLBACK_REJECTED`,
`UPSTREAM_UNREACHABLE`, `UPSTREAM_TOO_LARGE`, `DEADLINE_EXCEEDED`. The page client maps them to its
existing `ChatGPTBrowserError` kinds (`sign-in-cancelled`, `unsupported-environment`,
`sign-in-failed`; relay failures behave like a network failure → `temporarily-unavailable`).

The extension's own callback page sends
`{ protocol: 'loom/chatgpt-helper-callback', version: 1, search }` over internal messaging; it is
accepted only from this extension's `chatgpt-callback.html` in the attempt's tab, with the attempt
identifier the rule inserted and exactly one matching `state`.

## Security properties

- Every operation requires the manifest routing policy **and** the user's exact-origin approval
  **and** the helper opt-in (setting plus the two optional host permissions). Approval is re-checked
  at most every second while an operation runs, so revoking a site stops its sign-in or stream.
- The callback goes only to the port that started the attempt. Binding: extension-created tab ID, a
  256-bit attempt identifier inserted by the rule, and the OAuth `state` (single occurrence).
  Attempts are single use, expire after 10 minutes, close their window and remove their rule on any
  outcome, and are limited to 2 per origin and 4 in total. Several tabs of one site each get their
  own attempt, window and rule.
- The authorization URL must be OpenAI's authorize endpoint with this `redirect_uri`,
  `response_type=code`, `code_challenge_method=S256`, the declared `state`, and no duplicate
  parameters, otherwise no window opens.
- The relay has a fixed table of four URL+method pairs; the page picks a target name, not a URL.
  Headers are fixed (`Accept`, and `Authorization: Bearer …` / `Content-Type` only where needed).
  Requests use `credentials: 'omit'`, `redirect: 'error'`, `cache: 'no-store'`, no referrer,
  per-target deadlines (30 s, 60 s, 15 min) and size limits (64 KiB, 4 MiB, 64 MiB; error bodies 16
  KiB). Limits: 8 relays per origin, 32 in total. Only status, a validated `Content-Type` and
  `x-request-id` are returned.
- Bearer tokens, codes, and bodies are held only in transit and are never stored or logged. The
  service worker's existing envelope log records `type`/`requestId`/`ok`/`error.code` only.
- Residual risks: an approved website is trusted with the flow by design; the callback URL with its
  one-time, PKCE-bound code can remain in the sign-in window's history entry until replaced; the
  web-accessible `chatgpt-callback.html` lets pages on 127.0.0.1 or auth.openai.com detect that
  Companion is installed; chunks are UTF-8 text (all relayed bodies are JSON or SSE).

## Permissions and review surface

No install-time permission changes. The manifest adds one web-accessible resource
(`chatgpt-callback.html` for `http://127.0.0.1/*` and `https://auth.openai.com/*`), which shows no
warning. Enabling the helper requests the **optional** host permissions `https://api.openai.com/*`
and `http://127.0.0.1/*` (already covered by the declared optional `https://*/*` and `http://*/*`),
so Chrome shows a runtime prompt for those two sites. The Store dossier, privacy policy and
permission justification must mention the helper.

## Can a browser without the extension use the plan?

Unauthenticated probes on 2026-11-20/21 (`curl` with `Origin: https://example.com` and
`Origin: http://127.0.0.1:1455`):

| Endpoint                                        | Preflight                                            | Response probed                                                                                                                 | `Access-Control-Allow-Origin` |
| ----------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `POST auth.openai.com/api/accounts/oauth/token` | 200, `*`, allows `content-type,accept`               | 400 `invalid_grant` (refresh and code)                                                                                          | `*`                           |
| `POST …/oauth/revoke`                           | —                                                    | 400 `invalid_client`                                                                                                            | `*`                           |
| OpenID configuration, JWKS                      | 405 / 404                                            | 200                                                                                                                             | none                          |
| `GET api.openai.com/v1/models`                  | 200, `*`, allows `authorization,accept`              | 401 for opaque or JWT-shaped bearer                                                                                             | `*`                           |
| `POST api.openai.com/v1/responses`              | 200, `*`, allows `authorization,content-type,accept` | 401 with an opaque bearer                                                                                                       | `*`                           |
| `POST api.openai.com/v1/responses`              | (same)                                               | 401 `text/plain` with any JWT-shaped or `sk-` bearer, incl. `hardened_oauth_rule_missing` for an `auth.openai.com`-issued shape | **none**                      |

What this establishes:

- **Token refresh is very likely readable without the extension.** The token endpoint answers with
  `Access-Control-Allow-Origin: *` regardless of `Origin` on both error paths, and earlier live
  tests read a successful code exchange from a `127.0.0.1` page (they got as far as ID-token
  verification). A successful **refresh** response was not observed.
- **ID-token verification is not possible without the extension or another relay**: discovery and
  JWKS have no CORS headers.
- **`POST /v1/responses` with a ChatGPT token is very likely not readable cross-origin.** Requests
  carrying a JWT bearer are answered by a different backend whose 401s have no CORS header, the same
  pattern as the observed signed-in `GET /v1/models` 200 without the header. A signed-in success was
  never observed from a page.

One manual test settles it. With a valid ChatGPT plan access token from a completed sign-in (for
example from the Loom workbench at `http://127.0.0.1:4174`, in DevTools, never pasted anywhere
else), open DevTools on any HTTPS page such as `https://example.com` and run:

```js
const r = await fetch('https://api.openai.com/v1/responses', {
  method: 'POST',
  headers: { Authorization: 'Bearer <token>', 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: '<slug>', input: 'Say OK', stream: true, store: false }),
});
console.log(r.status, r.headers.get('content-type'));
```

A `TypeError: Failed to fetch` with a CORS error in the console means the extension (or a server
relay) is required for inference; a printed status means pages can stream directly. The same snippet
with `method: 'GET'` on `/v1/models` reconfirms the catalogue, and a `refresh_token` grant POST to
the token endpoint confirms refresh.

## Manual test with the unpacked extension

1. `pnpm install && pnpm build` (build after any `pnpm typecheck`, which overwrites `dist`).
2. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked**, and select
   `packages/extension-codex-experimental/dist`. (Remove or disable the Store version first.)
3. Note the extension ID shown on the card; pass it as `extensionId` from your site (the default is
   the published Store ID).
4. Open the extension's **Details → Extension options**, find **Website ChatGPT sign-in helper**,
   tick the checkbox, and allow access to api.openai.com and 127.0.0.1 in Chrome's prompt.
5. Open your HTTPS site, call `requestCompanionOriginAccess(...)` (or any Companion access request),
   and approve the exact origin under **Website access** in the options.
6. On the site, `connectCompanionChatGPTHelper` should report `available: true`. Click your sign-in
   button: a Companion-owned popup opens OpenAI's sign-in; after consent it closes and the site is
   signed in. List models and send a prompt.
7. Check in DevTools that no request went to `127.0.0.1:1456`, and use the service worker console
   (`chrome://extensions` → **service worker**) to confirm no tokens or bodies are logged.
